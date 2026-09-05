import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group>>();

export function loadGltf(url: string): Promise<THREE.Group> {
  let hit = cache.get(url);
  if (!hit) {
    hit = loader.loadAsync(url).then((g) => g.scene);
    cache.set(url, hit);
  }
  return hit.then((scene) => scene.clone(true));
}

/**
 * Flatten a generated GLB into a single geometry + material usable by an
 * InstancedMesh, normalized so any model — whatever scale Tripo returns —
 * ends up `targetHeight` tall and standing on y=0.
 */
export async function loadInstanceable(
  url: string,
  targetHeight: number,
): Promise<{ geometry: THREE.BufferGeometry; material: THREE.Material } | null> {
  try {
    const scene = await loadGltf(url);
    scene.updateMatrixWorld(true);

    const parts: THREE.BufferGeometry[] = [];
    let material: THREE.Material | null = null;

    scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geom = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      // InstancedMesh needs one consistent attribute set across merged parts.
      for (const name of Object.keys(geom.attributes)) {
        if (name !== "position" && name !== "normal" && name !== "uv") {
          geom.deleteAttribute(name);
        }
      }
      if (!geom.getAttribute("normal")) geom.computeVertexNormals();
      if (!geom.getAttribute("uv")) {
        const count = geom.getAttribute("position").count;
        geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      }
      parts.push(geom.toNonIndexed());
      if (!material) {
        const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        material = m;
      }
    });

    if (parts.length === 0) return null;

    const merged = mergeGeometries(parts);
    for (const p of parts) p.dispose();

    merged.computeBoundingBox();
    const box = merged.boundingBox!;
    const size = new THREE.Vector3();
    box.getSize(size);
    const height = Math.max(size.y, 0.0001);
    const scale = targetHeight / height;

    merged.translate(
      -(box.min.x + box.max.x) / 2,
      -box.min.y,
      -(box.min.z + box.max.z) / 2,
    );
    merged.scale(scale, scale, scale);
    merged.computeBoundingSphere();

    const mat =
      material ??
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.05 });
    // Instance colors tint the model, so the base map must survive vertex colors.
    if (mat instanceof THREE.MeshStandardMaterial) mat.vertexColors = false;

    return { geometry: merged, material: mat };
  } catch (err) {
    console.warn(`model load failed (${url}):`, err);
    return null;
  }
}

/** Minimal geometry merge: all parts already share position/normal/uv. */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 1) return parts[0].clone();

  let total = 0;
  for (const p of parts) total += p.getAttribute("position").count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  let v = 0;
  for (const p of parts) {
    const pos = p.getAttribute("position");
    const nor = p.getAttribute("normal");
    const tex = p.getAttribute("uv");
    for (let i = 0; i < pos.count; i++, v++) {
      position[v * 3] = pos.getX(i);
      position[v * 3 + 1] = pos.getY(i);
      position[v * 3 + 2] = pos.getZ(i);
      normal[v * 3] = nor.getX(i);
      normal[v * 3 + 1] = nor.getY(i);
      normal[v * 3 + 2] = nor.getZ(i);
      uv[v * 2] = tex.getX(i);
      uv[v * 2 + 1] = tex.getY(i);
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return out;
}
