import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
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
}

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
  private wireframe: THREE.LineSegments | null = null;
  private terrain: Terrain | null = null;
  /** Play radius for the loaded world, measured rather than assumed. */
  arenaRadius = ARENA_RADIUS;
  private readonly downRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(canvas: HTMLCanvasElement, physics: RAPIER.World) {
    this.physics = physics;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x05060a);

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.05,
      600,
    );
    this.camera.position.set(0, 14, 14);

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(12, 24, 8);
    this.scene.add(key);

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

    // ?nosplat=1 skips the splat entirely: a fast path for testing the game
    // loop, and a usable fallback on machines that cannot render splats.
    if (new URLSearchParams(location.search).get("nosplat")) {
      onStage?.("Building ground");
      this.buildFlatGround();
      this.scene.add(gridHelper());
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
    // across where the seed worlds are far larger. Fit the arena to the world
    // so enemies never spawn off the edge of it.
    this.arenaRadius = terrain.filled
      ? Math.max(ARENA_RADIUS_MIN, Math.min(ARENA_RADIUS, terrain.worldRadius * 0.92))
      : ARENA_RADIUS;

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

  private clearGround(): void {
    for (const c of this.groundColliders) this.physics.removeCollider(c, false);
    this.groundColliders = [];
    if (this.groundBody) {
      this.physics.removeRigidBody(this.groundBody);
      this.groundBody = null;
    }
  }

  /** Toggleable debug view of the floor the physics is actually using. */
  toggleWireframe(): void {
    if (this.wireframe) {
      this.scene.remove(this.wireframe);
      this.wireframe.geometry.dispose();
      this.wireframe = null;
      return;
    }
    if (!this.terrain) return;
    this.wireframe = terrainWireframe(this.terrain);
    this.scene.add(this.wireframe);
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
    const gltf = await new GLTFLoader().loadAsync(url);
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
      this.wireframe.geometry.dispose();
      this.wireframe = null;
    }
    this.terrain = null;
    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose?.();
      this.splat = null;
    }
    for (const c of this.groundColliders) this.physics.removeCollider(c, false);
    this.groundColliders = [];
    if (this.groundBody) {
      this.physics.removeRigidBody(this.groundBody);
      this.groundBody = null;
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

export { RAPIER };
