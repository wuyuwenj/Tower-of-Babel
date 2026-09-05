import * as THREE from "three";
import { createGltfLoader } from "./gltf-runtime";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import RAPIER from "@dimforge/rapier3d-compat";
import { ARENA_RADIUS, ARENA_RADIUS_MIN } from "./balance";
import { TERRAIN_GRID, sampleTerrain, terrainHeightAt, terrainWireframe, type Terrain } from "./terrain";
import { resolveWorldUrl } from "./net";

let rapierReady: Promise<void> | null = null;
function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export interface WorldSpec {
  splatUrl: string;
  colliderUrl?: string | null;
  /** Vertical offset applied to the splat so the ground sits near y=0. */
  yOffset?: number;
  /** Splats are usually Y-down; flip 180 degrees about X unless told otherwise. */
  flip?: boolean;
  scale?: number;
  /** Radius of the invisible arena wall. Defaults to ARENA_RADIUS. */
  arenaRadius?: number;
}

/** Segments in the arena wall. 32 is smooth enough that corners are unnoticeable. */
const WALL_SEGMENTS = 32;
/** Wall spans floorY - 2 up to floorY + 10: unsteppable, unjumpable, uneven-floor proof. */
const WALL_HALF_HEIGHT = 6;
const WALL_THICKNESS = 0.3;
const UP = new THREE.Vector3(0, 1, 0);

export class World {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly physics: RAPIER.World;
  readonly clock = new THREE.Clock();

  private spark: SparkRenderer;
  private splat: SplatMesh | null = null;
  private groundBody: RAPIER.RigidBody | null = null;
  private groundColliders: RAPIER.Collider[] = [];
  private wallBody: RAPIER.RigidBody | null = null;
  private arenaRing: THREE.Mesh | null = null;
  private wireframe: THREE.Group | null = null;
  private terrain: Terrain | null = null;
  /**
   * Play radius for the loaded world: measured from the cloud rather than
   * assumed, overridable per level, and where the arena wall stands. Read by
   * Enemies so spawns land inside it.
   */
  arenaRadius = ARENA_RADIUS;
  private readonly downRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(canvas: HTMLCanvasElement, physics: RAPIER.World) {
    this.physics = physics;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x05060a);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Tone mapping is opt-in until it has been eyeballed against a real splat:
    // the worlds arrive as baked sRGB radiance, and a filmic curve may flatten
    // them. ?tonemap=aces | neutral to compare; default leaves them untouched.
    const tonemap = new URLSearchParams(location.search).get("tonemap");
    if (tonemap === "aces") this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    if (tonemap === "neutral") this.renderer.toneMapping = THREE.NeutralToneMapping;
    if (tonemap) this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.05,
      600,
    );
    this.camera.position.set(0, 14, 14);

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    // Lights only touch the meshes — creatures, monument, orbs — never the
    // splat, which is its own baked light. A small stack instead of one flat
    // white ambient: warm key for form, cool fill so shadow sides stay legible,
    // and a rim from behind the camera's far side so a dark creature on a dark
    // floor still has an edge.
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a1e14, 1.1));
    const key = new THREE.DirectionalLight(0xfff1d6, 2.4);
    key.position.set(12, 24, 8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fb8ff, 0.8);
    fill.position.set(-14, 10, -6);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.2);
    rim.position.set(0, 9, -20);
    this.scene.add(rim);

    window.addEventListener("resize", this.onResize);
  }

  static async create(canvas: HTMLCanvasElement): Promise<World> {
    await initRapier();
    const physics = new RAPIER.World({ x: 0, y: -19.6, z: 0 });
    return new World(canvas, physics);
  }

  private onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  /** Load a level's splat + collider. Safe to call repeatedly. */
  async load(spec: WorldSpec, onStage?: (stage: string) => void): Promise<void> {
    this.unloadWorldGeometry();

    this.arenaRadius = resolveArenaRadius(spec, ARENA_RADIUS);

    // ?nosplat=1 skips the splat entirely: a fast path for testing the game
    // loop, and a usable fallback on machines that cannot render splats.
    if (new URLSearchParams(location.search).get("nosplat")) {
      onStage?.("Building ground");
      this.buildFlatGround();
      this.scene.add(gridHelper());
      this.buildArenaWall();
      onStage?.("Ready");
      return;
    }

    onStage?.("Streaming world");
    const flipped = spec.flip !== false;
    const splatUrl = await resolveWorldUrl(spec.splatUrl);
    const splat = new SplatMesh({ url: splatUrl });
    if (flipped) splat.quaternion.set(1, 0, 0, 0);
    splat.scale.setScalar(spec.scale ?? 1);
    this.scene.add(splat);
    this.splat = splat;
    await splat.initialized;

    // Generated worlds arrive in arbitrary vertical alignment, so measure the
    // floor from the splat cloud itself rather than hand-tuning each level.
    onStage?.("Reading the ground");
    const terrain = sampleTerrain(splat, flipped);
    this.terrain = terrain.filled ? terrain : null;
    splat.position.y = spec.yOffset ?? (terrain.filled ? terrain.yOffset : 0);

    // Generated worlds are not a fixed size: a Mint basin measures ~21 units
    // across where the seed worlds are far larger, so fit the arena to the
    // world rather than assuming it. The estimate is the cloud's footprint,
    // which is right for a generated basin but far wider than the room you can
    // stand in inside a scanned scene — so a level may override it, and the
    // seed rungs carry radii measured off their own splats.
    this.arenaRadius = resolveArenaRadius(
      spec,
      terrain.filled
        ? Math.max(ARENA_RADIUS_MIN, Math.min(ARENA_RADIUS, terrain.worldRadius * 0.92))
        : ARENA_RADIUS,
    );

    onStage?.("Building ground");
    let usedMesh = false;
    if (spec.colliderUrl) {
      try {
        await this.loadColliderMesh(spec.colliderUrl, splat.position.y);
        usedMesh = this.colliderAgreesWithSplat();
        if (!usedMesh) {
          console.warn("collider mesh disagrees with the splat; using sampled terrain");
          this.clearGround();
        }
      } catch (err) {
        console.warn("collider load failed, falling back to sampled terrain", err);
        this.clearGround();
      }
    }
    if (!usedMesh) this.buildSampledGround();

    // A collider mesh knows where the walls are, which the splat cloud never
    // did. Fit the ring to the room the mesh actually encloses.
    if (usedMesh) this.arenaRadius = resolveArenaRadius(spec, this.fitArenaToCollider());

    // After the ground, so the wall can sit on the floor it actually found.
    this.buildArenaWall();

    onStage?.("Ready");
  }

  /**
   * The collider mesh ships in the world's own frame, and providers do not
   * agree on whether that frame is flipped. The splat is the ground truth the
   * player sees, so sanity-check the mesh against the sampled floor and throw
   * it away if it disagrees — a mismatched collider means falling through the
   * world or standing on nothing.
   */
  private colliderAgreesWithSplat(): boolean {
    const terrain = this.terrain;
    if (!terrain) return true; // nothing to check against; trust the mesh

    const r = this.arenaRadius * 0.5;
    const samples: Array<[number, number]> = [
      [0, 0],
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ];

    let total = 0;
    let hits = 0;
    for (const [x, z] of samples) {
      const mesh = this.groundHeight(x, z);
      const sampled = terrainHeightAt(terrain, x, z);
      if (!Number.isFinite(mesh)) continue;
      total += Math.abs(mesh - sampled);
      hits++;
    }
    if (hits === 0) return false;
    return total / hits < 2.5;
  }

  /**
   * Radius of the largest mostly-clear disc around the spawn, measured by
   * casting rays outward against the collider mesh at knee height. The 20th
   * percentile of wall distances is used so one doorway cannot inflate the
   * ring and one pillar cannot collapse it: four directions in five are clear
   * to at least this far. Rays start just outside the player's own capsule.
   */
  private fitArenaToCollider(): number {
    const N = 64;
    const start = 1.0;
    const y = this.groundHeight(0, 0) + 0.9;
    const ray = new RAPIER.Ray({ x: 0, y, z: 0 }, { x: 1, y: 0, z: 0 });
    const dists: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      ray.origin.x = dx * start;
      ray.origin.z = dz * start;
      ray.dir.x = dx;
      ray.dir.z = dz;
      const hit = this.physics.castRay(ray, ARENA_RADIUS, true);
      dists.push(hit ? start + hit.timeOfImpact : ARENA_RADIUS);
    }
    dists.sort((a, b) => a - b);
    // Stand the ring half a metre off the nearest wall it is fitted to.
    const fitted = dists[Math.floor(N * 0.2)] - 0.5;
    return Math.max(ARENA_RADIUS_MIN, Math.min(ARENA_RADIUS, fitted));
  }

  private clearGround(): void {
    for (const c of this.groundColliders) this.physics.removeCollider(c, false);
    this.groundColliders = [];
    if (this.groundBody) {
      this.physics.removeRigidBody(this.groundBody);
      this.groundBody = null;
    }
  }

  /**
   * A ring of static colliders penning the player into the playable middle.
   *
   * Generated worlds have walls you can see but not touch: a splat is not
   * geometry, and the sampled heightfield deliberately keeps only each cell's
   * floor, so vertical surfaces flatten out of it entirely. Rather than try to
   * recover real walls from a point cloud, the arena is the contract — the
   * world prompt asks for a clear middle, and this ring is where it ends.
   */
  private buildArenaWall(): void {
    const radius = this.arenaRadius;
    const floorY = this.groundHeight(0, 0);
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.wallBody = body;

    // Half the chord each segment spans, plus a little overlap so the joins
    // between segments cannot open up a gap to squeeze through.
    const half = Math.PI / WALL_SEGMENTS;
    const halfChord = radius * Math.sin(half) + WALL_THICKNESS;
    const quat = new THREE.Quaternion();

    for (let i = 0; i < WALL_SEGMENTS; i++) {
      const angle = (i / WALL_SEGMENTS) * Math.PI * 2;
      // Turn the segment's long (local X) axis to lie along the tangent.
      quat.setFromAxisAngle(UP, -(angle + Math.PI / 2));
      const desc = RAPIER.ColliderDesc.cuboid(halfChord, WALL_HALF_HEIGHT, WALL_THICKNESS)
        .setTranslation(
          Math.cos(angle) * radius,
          floorY + WALL_HALF_HEIGHT - 2,
          Math.sin(angle) * radius,
        )
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
      this.physics.createCollider(desc, body);
    }

    this.arenaRing = arenaRing(radius, (x, z) => this.groundHeight(x, z));
    this.scene.add(this.arenaRing);
  }

  /** Tint the boundary ring to match the level's theme. */
  setArenaColor(color: number): void {
    const material = this.arenaRing?.material as THREE.MeshBasicMaterial | undefined;
    material?.color.setHex(color);
  }

  /** Toggleable debug view of the floor and wall the physics is actually using. */
  toggleWireframe(): void {
    if (this.wireframe) {
      this.scene.remove(this.wireframe);
      disposeTree(this.wireframe);
      this.wireframe = null;
      return;
    }
    const group = new THREE.Group();
    if (this.terrain) group.add(terrainWireframe(this.terrain));
    group.add(wallWireframe(this.arenaRadius, this.groundHeight(0, 0)));
    this.wireframe = group;
    this.scene.add(group);
  }

  /**
   * Build collision from the splat cloud when the world shipped without a
   * collider mesh. A Rapier heightfield over the play area is enough for a
   * top-down survivors game: the player and 300 enemies just need a floor.
   */
  private buildSampledGround(): void {
    const terrain = this.terrain;
    if (!terrain) {
      this.buildFlatGround();
      return;
    }

    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.groundBody = body;

    const n = TERRAIN_GRID;
    // Rapier reads heightfield data column-major; our grid is row-major.
    const heights = new Float32Array(n * n);
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) heights[x * n + z] = terrain.heights[z * n + x];
    }

    const desc = RAPIER.ColliderDesc.heightfield(n - 1, n - 1, heights, {
      x: terrain.extent * 2,
      y: 1,
      z: terrain.extent * 2,
    });
    this.groundColliders.push(this.physics.createCollider(desc, body));

    // A skirt underneath, so nothing can fall out of the world at the edges.
    const skirt = RAPIER.ColliderDesc.cuboid(terrain.extent * 3, 0.5, terrain.extent * 3)
      .setTranslation(0, -14, 0);
    this.groundColliders.push(this.physics.createCollider(skirt, body));
  }

  private buildFlatGround(): void {
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.cuboid(ARENA_RADIUS * 2, 0.5, ARENA_RADIUS * 2)
      .setTranslation(0, -0.5, 0);
    this.groundColliders.push(this.physics.createCollider(desc, body));
    this.groundBody = body;
  }

  private async loadColliderMesh(url: string, yOffset: number): Promise<void> {
    // Shared Draco-capable loader: a Mint collider is compressed too, and
    // losing it silently would drop the floor out of the level.
    const gltf = await createGltfLoader().loadAsync(url);
    // The collider ships in the splat's own frame, so it needs the same
    // flip and vertical alignment the splat got.
    gltf.scene.rotation.x = Math.PI;
    gltf.scene.position.y = yOffset;
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.groundBody = body;

    let built = 0;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geom = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const pos = geom.getAttribute("position");
      if (!pos) return;
      const vertices = new Float32Array(pos.array as ArrayLike<number>);
      const index = geom.getIndex();
      const indices = index
        ? new Uint32Array(index.array as ArrayLike<number>)
        : new Uint32Array(Array.from({ length: pos.count }, (_, i) => i));
      const desc = RAPIER.ColliderDesc.trimesh(vertices, indices);
      this.groundColliders.push(this.physics.createCollider(desc, body));
      built++;
      geom.dispose();
    });

    if (built === 0) throw new Error("collider glb contained no meshes");
  }

  private unloadWorldGeometry(): void {
    if (this.wireframe) {
      this.scene.remove(this.wireframe);
      disposeTree(this.wireframe);
      this.wireframe = null;
    }
    this.terrain = null;
    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose?.();
      this.splat = null;
    }
    if (this.arenaRing) {
      this.scene.remove(this.arenaRing);
      disposeTree(this.arenaRing);
      this.arenaRing = null;
    }
    for (const c of this.groundColliders) this.physics.removeCollider(c, false);
    this.groundColliders = [];
    if (this.groundBody) {
      this.physics.removeRigidBody(this.groundBody);
      this.groundBody = null;
    }
    // Removing the body takes its wall colliders with it.
    if (this.wallBody) {
      this.physics.removeRigidBody(this.wallBody);
      this.wallBody = null;
    }
  }

  /** Ground height under (x, z). Falls back to 0 when nothing is hit. */
  groundHeight(x: number, z: number, from = 40): number {
    this.downRay.origin.x = x;
    this.downRay.origin.y = from;
    this.downRay.origin.z = z;
    const hit = this.physics.castRay(this.downRay, from + 60, true);
    return hit ? from - hit.timeOfImpact : 0;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.unloadWorldGeometry();
    this.renderer.dispose();
    this.physics.free();
  }
}

function gridHelper(): THREE.GridHelper {
  const grid = new THREE.GridHelper(ARENA_RADIUS * 2, 34, 0x39ff9a, 0x1d5c3c);
  grid.position.y = 0.02;
  return grid;
}

/**
 * The arena radius for a level: `?arena=12` beats a level's own value, which
 * in turn beats the radius measured from the splat cloud. The query override
 * is how the per-level numbers in SEED_LEVELS get tuned without a rebuild.
 */
function resolveArenaRadius(spec: WorldSpec, measured: number): number {
  const override = Number(new URLSearchParams(location.search).get("arena"));
  if (Number.isFinite(override) && override > 0) return override;
  return spec.arenaRadius ?? measured;
}

/**
 * A faint ring on the floor at the wall. An invisible wall that stops you
 * somewhere unmarked reads as a bug, so the boundary is drawn — and drawn
 * following the ground, since the sampled floor is rarely level.
 */
function arenaRing(radius: number, heightAt: (x: number, z: number) => number): THREE.Mesh {
  const geom = new THREE.RingGeometry(radius - 0.12, radius + 0.12, 128);
  geom.rotateX(-Math.PI / 2);
  const pos = geom.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)) + 0.06);
  }
  pos.needsUpdate = true;
  return new THREE.Mesh(
    geom,
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
}

/** Debug companion to terrainWireframe: the wall the player is actually hitting. */
function wallWireframe(radius: number, floorY: number): THREE.LineSegments {
  const geom = new THREE.CylinderGeometry(radius, radius, WALL_HALF_HEIGHT * 2, WALL_SEGMENTS, 1, true);
  geom.translate(0, floorY + WALL_HALF_HEIGHT - 2, 0);
  return new THREE.LineSegments(
    new THREE.WireframeGeometry(geom),
    new THREE.LineBasicMaterial({ color: 0xff9a39, transparent: true, opacity: 0.3 }),
  );
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

export { RAPIER };
