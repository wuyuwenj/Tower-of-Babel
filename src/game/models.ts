import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { createGltfLoader, unsupportedExtensions } from "./gltf-runtime";

// Draco-capable: Mint's optimized GLBs are compressed and a bare loader throws.
const loader = createGltfLoader();
const cache = new Map<string, Promise<GLTF>>();

/** Frames per second the walk cycle is baked at. 30 reads smooth; more is texture for nothing. */
const BAKE_FPS = 30;
const MAX_FRAMES = 64;

function loadRaw(url: string): Promise<GLTF> {
  let hit = cache.get(url);
  if (!hit) {
    hit = loader.loadAsync(url).then((g) => {
      // Draco is handled; anything else a file *requires* would render as a
      // broken mesh rather than an error, so say so instead.
      const missing = unsupportedExtensions(g.parser.json.extensionsRequired);
      if (missing.length > 0) {
        throw new Error(`${url}: unsupported glTF extension(s) ${missing.join(", ")}`);
      }
      return g;
    });
    cache.set(url, hit);
  }
  return hit;
}

export function loadGltf(url: string): Promise<THREE.Group> {
  return loadRaw(url).then((g) => g.scene.clone(true));
}

export interface AnimatedModel {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /**
   * Yaw (radians) that turns the model to face +Z. Tripo does not export
   * rigged characters in one orientation — one came back facing −X — so the
   * skeleton is asked: its bones are named Left/Right, the mean Right position
   * minus the mean Left gives the model's right, and forward = up × right.
   * Zero when the rig carries no side labels.
   */
  yawToForward: number;
}

/**
 * A single rigged character with its clips, for a SkinnedMesh + AnimationMixer.
 *
 * Extra URLs contribute only their animations: Tripo writes one clip per
 * retarget, all on the same rig, and clips bind to bones by name, so the
 * character loads once and borrows the others' tracks.
 */
export async function loadAnimated(url: string, clipUrls: string[] = []): Promise<AnimatedModel | null> {
  try {
    const [main, ...extra] = await Promise.all([loadRaw(url), ...clipUrls.map(loadRaw)]);
    // A plain clone leaves the skeleton bound to the cached scene's bones.
    const scene = cloneSkeleton(main.scene) as THREE.Group;
    const clips = [...main.animations, ...extra.flatMap((g) => g.animations)];
    return { scene, clips, yawToForward: yawToForward(scene) };
  } catch (err) {
    console.warn(`model load failed (${url}):`, err);
    return null;
  }
}

/**
 * A walk cycle baked to a texture so an InstancedMesh can play it.
 *
 * three has no skinning for instanced meshes, and 200 SkinnedMesh draws is
 * what instancing exists to avoid. Instead every bone's matrix is sampled
 * per frame into one float texture — `bones * 4` texels wide (a mat4 per
 * bone), `frames` tall — and the vertex shader does the skinning itself,
 * picking the frame from a per-instance phase. See `animateMaterial`.
 */
export interface CreatureAnimation {
  texture: THREE.DataTexture;
  bones: number;
  frames: number;
  fps: number;
}

export interface CreatureModel {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Present when the GLB carried a skin and a clip; the geometry then keeps skinIndex/skinWeight. */
  animation: CreatureAnimation | null;
}

/**
 * Flatten a generated GLB into a single geometry + material usable by an
 * InstancedMesh, normalized so any model — whatever scale Tripo returns —
 * ends up `targetHeight` tall and standing on y=0.
 *
 * A rigged, animated GLB additionally yields a baked walk: the merged geometry
 * keeps its skin attributes, and the bone matrices are re-expressed in the
 * normalized space so the shader can skin the flattened vertices directly.
 */
export async function loadInstanceable(
  url: string,
  targetHeight: number,
): Promise<CreatureModel | null> {
  try {
    const gltf = await loadRaw(url);
    // A plain clone leaves skeletons pointing at the cached scene's bones;
    // SkeletonUtils rebinds them so the mixer in bakeWalk drives this copy.
    const scene = cloneSkeleton(gltf.scene) as THREE.Group;
    scene.updateMatrixWorld(true);

    const parts: THREE.BufferGeometry[] = [];
    const skinned: Array<{ mesh: THREE.SkinnedMesh; boneOffset: number }> = [];
    let material: THREE.Material | null = null;
    let boneCount = 0;

    scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geom = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const skin = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
      // InstancedMesh needs one consistent attribute set across merged parts.
      for (const name of Object.keys(geom.attributes)) {
        const keep =
          name === "position" || name === "normal" || name === "uv" ||
          (skin && (name === "skinIndex" || name === "skinWeight"));
        if (!keep) geom.deleteAttribute(name);
      }
      if (!geom.getAttribute("normal")) geom.computeVertexNormals();
      if (!geom.getAttribute("uv")) {
        const count = geom.getAttribute("position").count;
        geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      }
      if (skin && geom.getAttribute("skinIndex") && geom.getAttribute("skinWeight")) {
        // Bone indices are per skeleton; offset them into one shared table.
        // Float copies also flatten whatever integer/normalized storage the
        // file used, so every part ends up with the same attribute types.
        geom.setAttribute("skinIndex", toFloat4(geom.getAttribute("skinIndex"), boneCount));
        geom.setAttribute("skinWeight", toFloat4(geom.getAttribute("skinWeight"), 0));
        skinned.push({ mesh: skin, boneOffset: boneCount });
        boneCount += skin.skeleton.bones.length;
      } else {
        geom.deleteAttribute("skinIndex");
        geom.deleteAttribute("skinWeight");
      }
      // Keep the index when there is a single part: expanding an indexed
      // 19k-triangle mesh triples its vertex memory for nothing.
      parts.push(geom);
      if (!material) {
        const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        material = m;
      }
    });

    if (parts.length === 0) return null;

    const clip = gltf.animations[0];
    const animated = skinned.length > 0 && !!clip;
    if (animated) {
      // Rigid parts (eyes, held props) ride one identity bone so the whole
      // model shares a single attribute set and one skinning path.
      let needRigid = false;
      for (const geom of parts) {
        if (geom.getAttribute("skinIndex")) continue;
        needRigid = true;
        const count = geom.getAttribute("position").count;
        const idx = new Float32Array(count * 4).fill(boneCount);
        const w = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) w[i * 4] = 1;
        geom.setAttribute("skinIndex", new THREE.BufferAttribute(idx, 4));
        geom.setAttribute("skinWeight", new THREE.BufferAttribute(w, 4));
      }
      if (needRigid) boneCount++;
    }

    // mergeGeometries wants every part indexed or none.
    const mixed = parts.some((p) => !!p.getIndex()) && parts.some((p) => !p.getIndex());
    const merged =
      parts.length === 1
        ? parts[0]
        : mergeGeometries(mixed ? parts.map((p) => p.toNonIndexed()) : parts, false);
    if (!merged) return null;
    for (const p of parts) if (p !== merged) p.dispose();

    merged.computeBoundingBox();
    const box = merged.boundingBox!;
    const size = new THREE.Vector3();
    box.getSize(size);
    const height = Math.max(size.y, 0.0001);
    const scale = targetHeight / height;

    const translate = new THREE.Vector3(
      -(box.min.x + box.max.x) / 2,
      -box.min.y,
      -(box.min.z + box.max.z) / 2,
    );
    merged.translate(translate.x, translate.y, translate.z);
    merged.scale(scale, scale, scale);
    merged.computeBoundingSphere();

    const mat =
      material ??
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.05 });
    // Instance colors tint the model, so the base map must survive vertex colors.
    if (mat instanceof THREE.MeshStandardMaterial) mat.vertexColors = false;

    const animation = animated ? bakeWalk(scene, clip, skinned, boneCount, translate, scale) : null;

    return { geometry: merged, material: mat, animation };
  } catch (err) {
    console.warn(`model load failed (${url}):`, err);
    return null;
  }
}

function yawToForward(scene: THREE.Object3D): number {
  scene.updateMatrixWorld(true);
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();
  let nl = 0;
  let nr = 0;
  const p = new THREE.Vector3();
  scene.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    if (/left/i.test(o.name)) {
      left.add(o.getWorldPosition(p));
      nl++;
    } else if (/right/i.test(o.name)) {
      right.add(o.getWorldPosition(p));
      nr++;
    }
  });
  if (nl === 0 || nr === 0) return 0;
  right.divideScalar(nr).sub(left.divideScalar(nl)).setY(0);
  if (right.lengthSq() < 1e-8) return 0;
  const forward = new THREE.Vector3(0, 1, 0).cross(right.normalize());
  // R_y(θ) · forward = +Z  ⇒  θ = atan2(−fx, fz).
  return Math.atan2(-forward.x, forward.z);
}

function toFloat4(src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, offset: number): THREE.BufferAttribute {
  const out = new Float32Array(src.count * 4);
  for (let i = 0; i < src.count; i++) {
    out[i * 4] = src.getX(i) + offset;
    out[i * 4 + 1] = src.getY(i) + offset;
    out[i * 4 + 2] = src.getZ(i) + offset;
    out[i * 4 + 3] = src.getW(i) + offset;
  }
  return new THREE.BufferAttribute(out, 4);
}

/**
 * Sample the clip into a bone-matrix texture.
 *
 * three skins a vertex as `Σ wᵢ · (boneWorldᵢ · boneInverseᵢ) · bindMatrix · v`
 * (the mesh's own world matrix cancels against bindMatrixInverse). Our merged
 * vertices are already `N · W · v` — world-space, then normalized by N — so
 * each baked matrix is `N · boneWorldᵢ(t) · boneInverseᵢ · bindMatrix · W⁻¹ · N⁻¹`,
 * which maps a stored vertex straight to its posed, normalized position.
 */
function bakeWalk(
  root: THREE.Object3D,
  clip: THREE.AnimationClip,
  skinned: Array<{ mesh: THREE.SkinnedMesh; boneOffset: number }>,
  boneCount: number,
  translate: THREE.Vector3,
  scale: number,
): CreatureAnimation {
  const frames = Math.max(2, Math.min(MAX_FRAMES, Math.round(clip.duration * BAKE_FPS)));
  // Frame `frames` is frame 0 again, so the loop closes without a duplicate.
  const fps = frames / clip.duration;

  const N = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(translate.x, translate.y, translate.z));
  const Ninv = N.clone().invert();

  // Constant right-hand side per bone: boneInverse · bindMatrix · W⁻¹ · N⁻¹.
  const bones: Array<{ bone: THREE.Object3D; post: THREE.Matrix4 } | null> = Array.from({ length: boneCount }, () => null);
  for (const { mesh, boneOffset } of skinned) {
    const Winv = mesh.matrixWorld.clone().invert();
    const tail = mesh.bindMatrix.clone().multiply(Winv).multiply(Ninv);
    mesh.skeleton.bones.forEach((bone, i) => {
      bones[boneOffset + i] = {
        bone,
        post: mesh.skeleton.boneInverses[i].clone().multiply(tail),
      };
    });
  }

  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();

  const data = new Float32Array(boneCount * 16 * frames);
  const m = new THREE.Matrix4();
  for (let f = 0; f < frames; f++) {
    mixer.setTime(f / fps);
    root.updateMatrixWorld(true);
    for (let b = 0; b < boneCount; b++) {
      const entry = bones[b];
      if (entry) m.copy(N).multiply(entry.bone.matrixWorld).multiply(entry.post);
      else m.identity(); // the rigid-part bone
      data.set(m.elements, (f * boneCount + b) * 16);
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);

  const texture = new THREE.DataTexture(data, boneCount * 4, frames, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, bones: boneCount, frames, fps };
}

/**
 * Make a standard material skin its vertices from a baked walk.
 *
 * Each instance carries `aAnim = (phase seconds, rate)`; the shader turns the
 * shared clock into a frame, fetches the four bone matrices for that frame
 * and the next, and blends them. Instancing, instance colour and lighting
 * are untouched — only where `transformed` and `objectNormal` come from.
 */
export function animateMaterial(
  material: THREE.MeshStandardMaterial,
  animation: CreatureAnimation,
  clock: { value: number },
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.boneTex = { value: animation.texture };
    shader.uniforms.animClock = clock;
    shader.uniforms.animFrames = { value: animation.frames };
    shader.uniforms.animFps = { value: animation.fps };

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        attribute vec4 skinIndex;
        attribute vec4 skinWeight;
        attribute vec2 aAnim;
        uniform sampler2D boneTex;
        uniform float animClock;
        uniform float animFrames;
        uniform float animFps;

        mat4 boneAt(int bone, int frame) {
          int x = bone * 4;
          return mat4(
            texelFetch(boneTex, ivec2(x, frame), 0),
            texelFetch(boneTex, ivec2(x + 1, frame), 0),
            texelFetch(boneTex, ivec2(x + 2, frame), 0),
            texelFetch(boneTex, ivec2(x + 3, frame), 0));
        }

        mat4 poseAt(int frame) {
          return boneAt(int(skinIndex.x), frame) * skinWeight.x +
            boneAt(int(skinIndex.y), frame) * skinWeight.y +
            boneAt(int(skinIndex.z), frame) * skinWeight.z +
            boneAt(int(skinIndex.w), frame) * skinWeight.w;
        }

        mat4 walkMatrix() {
          float t = mod((animClock * aAnim.y + aAnim.x) * animFps, animFrames);
          int f0 = int(floor(t));
          int f1 = (f0 + 1) % int(animFrames);
          float k = fract(t);
          return poseAt(f0) * (1.0 - k) + poseAt(f1) * k;
        }`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        /* glsl */ `
        mat4 walkMat = walkMatrix();
        vec3 objectNormal = normalize(mat3(walkMat) * normal);`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `
        vec3 transformed = (walkMat * vec4(position, 1.0)).xyz;`,
      );
  };
  // Every creature patches the shader identically, so one program serves all.
  material.customProgramCacheKey = () => "creature-walk";
}
