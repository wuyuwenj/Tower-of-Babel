import * as THREE from "three";
import {
  ARCHETYPES,
  MAX_ENEMIES,
  SPAWN_RING_MAX,
  SPAWN_RING_MIN,
  depthScale,
  type Archetype,
} from "./balance";
import type { World } from "./world";

const CAPACITY: Record<Archetype, number> = { swarm: 220, fast: 120, tank: 48, boss: 4 };
const CELL = 1.6;

/**
 * Generated creatures come back +Z-forward, which is what `atan2(vx, vz)`
 * already produces. Kept as a knob because providers disagree about forward.
 */
const MODEL_YAW_OFFSET = 0;

interface Enemy {
  archetype: Archetype;
  slot: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  radius: number;
  xp: number;
  x: number;
  y: number;
  z: number;
  ground: number;
  phase: number;
  flash: number;
  alive: boolean;
  /** Yaw of travel, held between frames so a stalled enemy keeps facing forward. */
  yaw: number;
}

export interface EnemyHit {
  killed: boolean;
  xp: number;
  x: number;
  y: number;
  z: number;
}

const BASE_COLOR: Record<Archetype, THREE.Color> = {
  swarm: new THREE.Color(0x8b5a3c),
  fast: new THREE.Color(0xc7563f),
  tank: new THREE.Color(0x5a5f7a),
  boss: new THREE.Color(0xd94f8a),
};

export class Enemies {
  readonly list: Enemy[] = [];
  private meshes = new Map<Archetype, THREE.InstancedMesh>();
  private free = new Map<Archetype, number[]>();
  private grid = new Map<number, number[]>();
  private tint = new THREE.Color(0xffffff);
  private dummy = new THREE.Object3D();
  private world: World;
  private themeColor = new THREE.Color(0xffffff);
  private generated = false;

  constructor(world: World) {
    this.world = world;
    for (const archetype of Object.keys(ARCHETYPES) as Archetype[]) {
      this.build(archetype, defaultGeometry(archetype), defaultMaterial());
      const cap = CAPACITY[archetype];
      this.free.set(
        archetype,
        Array.from({ length: cap }, (_, i) => cap - 1 - i),
      );
    }
  }

  private build(archetype: Archetype, geom: THREE.BufferGeometry, mat: THREE.Material): void {
    const old = this.meshes.get(archetype);
    if (old) {
      this.world.scene.remove(old);
      old.geometry.dispose();
      (old.material as THREE.Material).dispose();
    }

    const cap = CAPACITY[archetype];
    const mesh = new THREE.InstancedMesh(geom, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = cap;
    mesh.frustumCulled = false;
    const colors = new Float32Array(cap * 3).fill(1);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    // Park every instance out of sight until it is spawned.
    this.dummy.position.set(0, -999, 0);
    this.dummy.scale.setScalar(1);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, this.dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    this.world.scene.add(mesh);
    this.meshes.set(archetype, mesh);
  }

  /**
   * Swap in a Tripo-generated creature. Called at level load, when nothing is
   * alive, so rebuilding the instanced meshes is safe.
   * `generated` geometry is already normalized to 1 unit tall and origin-on-floor.
   */
  setModel(geometry: THREE.BufferGeometry, material: THREE.Material): void {
    for (const archetype of Object.keys(ARCHETYPES) as Archetype[]) {
      this.build(archetype, geometry.clone(), material.clone());
    }
    this.generated = true;
  }

  /** Restore the stock shapes (used when a level has no generated creature). */
  resetModel(): void {
    if (!this.generated) return;
    for (const archetype of Object.keys(ARCHETYPES) as Archetype[]) {
      this.build(archetype, defaultGeometry(archetype), defaultMaterial());
    }
    this.generated = false;
  }

  setTheme(color: number): void {
    this.themeColor.setHex(color);
  }

  get aliveCount(): number {
    return this.list.length;
  }

  bossAlive(): Enemy | null {
    return this.list.find((e) => e.archetype === "boss") ?? null;
  }

  spawn(archetype: Archetype, levelIndex: number, origin: THREE.Vector3): boolean {
    if (this.list.length >= MAX_ENEMIES) return false;
    const pool = this.free.get(archetype)!;
    const slot = pool.pop();
    if (slot === undefined) return false;

    const stats = ARCHETYPES[archetype];
    const scale = depthScale(levelIndex);
    const angle = Math.random() * Math.PI * 2;
    const dist = SPAWN_RING_MIN + Math.random() * (SPAWN_RING_MAX - SPAWN_RING_MIN);
    const x = origin.x + Math.cos(angle) * dist;
    const z = origin.z + Math.sin(angle) * dist;
    const ground = this.world.groundHeight(x, z);

    this.list.push({
      archetype,
      slot,
      hp: stats.hp * scale,
      maxHp: stats.hp * scale,
      speed: stats.speed,
      damage: stats.damage * scale,
      radius: stats.radius * stats.scale,
      xp: stats.xp,
      x,
      y: ground,
      z,
      ground,
      phase: Math.random() * Math.PI * 2,
      flash: 0,
      alive: true,
      // Spawned on a ring facing the player at the centre.
      yaw: Math.atan2(origin.x - x, origin.z - z),
    });
    return true;
  }

  /** Damage every enemy within `radius` of (x, z), nearest-first up to `maxTargets`. */
  damageArea(x: number, z: number, radius: number, amount: number, maxTargets: number): EnemyHit[] {
    const hits: EnemyHit[] = [];
    const r2 = radius * radius;
    const candidates: Array<{ e: Enemy; d2: number }> = [];
    for (const e of this.list) {
      const dx = e.x - x;
      const dz = e.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= r2) candidates.push({ e, d2 });
    }
    candidates.sort((a, b) => a.d2 - b.d2);
    for (const { e } of candidates.slice(0, maxTargets)) {
      e.hp -= amount;
      e.flash = 0.14;
      if (e.hp <= 0) {
        e.alive = false;
        hits.push({ killed: true, xp: e.xp, x: e.x, y: e.y + 0.6, z: e.z });
      } else {
        hits.push({ killed: false, xp: 0, x: e.x, y: e.y, z: e.z });
      }
    }
    return hits;
  }

  nearest(x: number, z: number, maxRange: number): Enemy | null {
    let best: Enemy | null = null;
    let bestD2 = maxRange * maxRange;
    for (const e of this.list) {
      const dx = e.x - x;
      const dz = e.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  /** Returns damage dealt to the player this frame by contact. */
  update(dt: number, time: number, target: THREE.Vector3, targetRadius: number): number {
    let contactDamage = 0;
    const frame = Math.floor(time * 60);

    this.grid.clear();
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      const key = this.cellKey(e.x, e.z);
      let cell = this.grid.get(key);
      if (!cell) this.grid.set(key, (cell = []));
      cell.push(i);
    }

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (!e.alive) {
        this.release(e);
        this.list.splice(i, 1);
        continue;
      }

      const dx = target.x - e.x;
      const dz = target.z - e.z;
      const dist = Math.hypot(dx, dz) || 1;

      let vx = (dx / dist) * e.speed;
      let vz = (dz / dist) * e.speed;

      // Cheap separation so crowds spread out instead of stacking.
      const [sx, sz] = this.separation(i, e);
      vx += sx * e.speed * 0.9;
      vz += sz * e.speed * 0.9;

      e.x += vx * dt;
      e.z += vz * dt;

      // Face where it is actually going, not where it stands.
      if (vx * vx + vz * vz > 0.0001) e.yaw = Math.atan2(vx, vz);

      // Stagger ground sampling: each enemy re-samples a few times a second.
      if ((frame + e.slot) % 12 === 0) e.ground = this.world.groundHeight(e.x, e.z);
      const hop = e.archetype === "tank" ? 0.06 : 0.16;
      e.y = e.ground + Math.abs(Math.sin(time * 6 + e.phase)) * hop;

      if (dist < e.radius + targetRadius) contactDamage += e.damage * dt;
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);
    }

    this.writeInstances();
    return contactDamage;
  }

  private separation(index: number, e: Enemy): [number, number] {
    let sx = 0;
    let sz = 0;
    const cx = Math.floor(e.x / CELL);
    const cz = Math.floor(e.z / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const cell = this.grid.get((cx + ox) * 73856093 + (cz + oz) * 19349663);
        if (!cell) continue;
        for (const j of cell) {
          if (j === index) continue;
          const o = this.list[j];
          const dx = e.x - o.x;
          const dz = e.z - o.z;
          const d2 = dx * dx + dz * dz;
          const min = e.radius + o.radius;
          if (d2 > 0.0001 && d2 < min * min) {
            const d = Math.sqrt(d2);
            sx += (dx / d) * (1 - d / min);
            sz += (dz / d) * (1 - d / min);
          }
        }
      }
    }
    return [sx, sz];
  }

  private cellKey(x: number, z: number): number {
    return Math.floor(x / CELL) * 73856093 + Math.floor(z / CELL) * 19349663;
  }

  private writeInstances(): void {
    const dirty = new Set<Archetype>();
    for (const e of this.list) {
      const mesh = this.meshes.get(e.archetype)!;
      const stats = ARCHETYPES[e.archetype];
      this.dummy.position.set(e.x, e.y + (this.generated ? 0 : stats.scale * 0.55), e.z);
      this.dummy.rotation.set(0, e.yaw + (this.generated ? MODEL_YAW_OFFSET : 0), 0);
      this.dummy.scale.setScalar(stats.scale);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(e.slot, this.dummy.matrix);

      if (e.flash > 0) {
        this.tint.setRGB(1, 1, 1);
      } else if (this.generated) {
        // Instance color multiplies the texture, so start from white and only
        // lean toward the archetype hue — otherwise a textured model goes muddy.
        this.tint.setRGB(1, 1, 1).lerp(BASE_COLOR[e.archetype], 0.35);
      } else {
        this.tint.copy(BASE_COLOR[e.archetype]).lerp(this.themeColor, 0.35);
      }
      mesh.setColorAt(e.slot, this.tint);
      dirty.add(e.archetype);
    }
    for (const archetype of dirty) {
      const mesh = this.meshes.get(archetype)!;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private release(e: Enemy): void {
    this.dummy.position.set(0, -999, 0);
    this.dummy.scale.setScalar(1);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.updateMatrix();
    const mesh = this.meshes.get(e.archetype)!;
    mesh.setMatrixAt(e.slot, this.dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    this.free.get(e.archetype)!.push(e.slot);
  }

  clear(): void {
    for (const e of this.list) this.release(e);
    this.list.length = 0;
  }

  dispose(): void {
    this.clear();
    for (const mesh of this.meshes.values()) {
      this.world.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.meshes.clear();
  }
}

function defaultGeometry(archetype: Archetype): THREE.BufferGeometry {
  if (archetype === "boss") return new THREE.IcosahedronGeometry(0.62, 1);
  if (archetype === "tank") return new THREE.BoxGeometry(0.9, 1.1, 0.9);
  return new THREE.ConeGeometry(0.42, 1.05, 6);
}

function defaultMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0.1 });
}

export type { Enemy };
