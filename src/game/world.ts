import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import RAPIER from "@dimforge/rapier3d-compat";
import { ARENA_RADIUS } from "./balance";

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

    onStage?.("Building ground");
    if (spec.colliderUrl) {
      try {
        await this.loadColliderMesh(spec.colliderUrl);
      } catch (err) {
        console.warn("collider load failed, using flat ground", err);
        this.buildFlatGround();
      }
    } else {
      this.buildFlatGround();
    }

    onStage?.("Streaming world");
    const splat = new SplatMesh({ url: spec.splatUrl });
    if (spec.flip !== false) splat.quaternion.set(1, 0, 0, 0);
    const scale = spec.scale ?? 1;
    splat.scale.setScalar(scale);
    splat.position.y = spec.yOffset ?? 0;
    this.scene.add(splat);
    this.splat = splat;
    await splat.initialized;
    onStage?.("Ready");
  }

  private buildFlatGround(): void {
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.cuboid(ARENA_RADIUS * 2, 0.5, ARENA_RADIUS * 2)
      .setTranslation(0, -0.5, 0);
    this.groundColliders.push(this.physics.createCollider(desc, body));
    this.groundBody = body;
  }

  private async loadColliderMesh(url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
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

export { RAPIER };
