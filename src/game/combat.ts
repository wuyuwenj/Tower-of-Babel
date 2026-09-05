import * as THREE from "three";
import type { Enemies } from "./enemies";
import { weaponPower, type PlayerStats } from "./balance";

const MAX_TARGETS = 24;
const ORB_LIFETIME = 22;

interface Orb {
  mesh: THREE.Mesh;
  value: number;
  age: number;
}

/** Auto-attack: no aiming. Hits the nearest enemy in range, splashes if upgraded. */
export class Combat {
  private cooldown = 0;
  private orbs: Orb[] = [];
  private beam: THREE.Mesh;
  private beamLife = 0;
  private ring: THREE.Mesh;
  private ringLife = 0;
  private orbGeom = new THREE.OctahedronGeometry(0.22);
  private orbMat = new THREE.MeshBasicMaterial({ color: 0x7ce8ff });
  private scene: THREE.Scene;
  private enemies: Enemies;

  constructor(scene: THREE.Scene, enemies: Enemies) {
    this.scene = scene;
    this.enemies = enemies;

    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 1, 6),
      new THREE.MeshBasicMaterial({ color: 0xbfe4ff, transparent: true, opacity: 0.9 }),
    );
    this.beam.visible = false;
    scene.add(this.beam);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.85, 28),
      new THREE.MeshBasicMaterial({
        color: 0xffd47a,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    scene.add(this.ring);
  }

  setThemeColor(color: number): void {
    (this.ring.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  /** Returns XP collected this frame. */
  update(dt: number, player: THREE.Vector3, stats: PlayerStats, playerLevel: number): number {
    this.cooldown -= dt;
    if (this.cooldown <= 0) {
      const target = this.enemies.nearest(player.x, player.z, stats.attackRange);
      if (target) {
        this.cooldown = stats.attackCooldown;
        this.strike(player, target.x, target.y, target.z, stats, weaponPower(playerLevel));
      }
    }

    if (this.beamLife > 0) {
      this.beamLife -= dt;
      (this.beam.material as THREE.MeshBasicMaterial).opacity = Math.max(0, this.beamLife * 8);
      if (this.beamLife <= 0) this.beam.visible = false;
    }
    if (this.ringLife > 0) {
      this.ringLife -= dt;
      const t = 1 - this.ringLife / 0.28;
      this.ring.scale.setScalar(0.4 + t * 1.2);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.7 * (1 - t));
      if (this.ringLife <= 0) this.ring.visible = false;
    }

    return this.updateOrbs(dt, player, stats.pickupRadius);
  }

  private strike(
    from: THREE.Vector3,
    x: number,
    y: number,
    z: number,
    stats: PlayerStats,
    power: number,
  ): void {
    const splash = stats.splashRadius;
    const damage = stats.damage * power;
    const hits = splash > 0
      ? this.enemies.damageArea(x, z, splash, damage, MAX_TARGETS)
      : this.enemies.damageArea(x, z, 0.9, damage, 1);

    for (const hit of hits) {
      if (hit.killed) this.spawnOrb(hit.x, hit.y, hit.z, hit.xp);
    }

    const target = new THREE.Vector3(x, y + 0.6, z);
    const origin = new THREE.Vector3(from.x, from.y + 1.0, from.z);
    const mid = origin.clone().lerp(target, 0.5);
    const len = origin.distanceTo(target);
    this.beam.position.copy(mid);
    this.beam.scale.set(1, Math.max(0.01, len), 1);
    this.beam.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      target.clone().sub(origin).normalize(),
    );
    this.beam.visible = true;
    this.beamLife = 0.12;

    if (splash > 0) {
      this.ring.position.set(x, y + 0.12, z);
      this.ring.scale.setScalar(splash);
      this.ring.visible = true;
      this.ringLife = 0.28;
    }
  }

  private spawnOrb(x: number, y: number, z: number, value: number): void {
    const mesh = new THREE.Mesh(this.orbGeom, this.orbMat);
    mesh.position.set(x, y + 0.35, z);
    this.scene.add(mesh);
    this.orbs.push({ mesh, value, age: 0 });
  }

  private updateOrbs(dt: number, player: THREE.Vector3, pickupRadius: number): number {
    let gained = 0;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      orb.age += dt;
      const p = orb.mesh.position;
      const dx = player.x - p.x;
      const dz = player.z - p.z;
      const dist = Math.hypot(dx, dz);

      if (dist < pickupRadius) {
        const pull = Math.min(1, dt * (6 + (pickupRadius - dist) * 3));
        p.x += dx * pull;
        p.z += dz * pull;
        p.y += (player.y + 0.8 - p.y) * pull;
      }
      orb.mesh.rotation.y += dt * 3;

      if (dist < 1.0 || orb.age > ORB_LIFETIME) {
        if (dist < 1.0) gained += orb.value;
        this.scene.remove(orb.mesh);
        this.orbs.splice(i, 1);
      }
    }
    return gained;
  }

  clear(): void {
    for (const orb of this.orbs) this.scene.remove(orb.mesh);
    this.orbs.length = 0;
    this.beam.visible = false;
    this.ring.visible = false;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.beam);
    this.scene.remove(this.ring);
    this.orbGeom.dispose();
    this.orbMat.dispose();
  }
}
