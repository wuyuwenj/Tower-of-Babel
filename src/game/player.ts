import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { BASE_PLAYER, type PlayerStats } from "./balance";
import type { World } from "./world";

const CAPSULE_HALF_HEIGHT = 0.55;
const CAPSULE_RADIUS = 0.42;
const CAM_HEIGHT = 13.5;
const CAM_BACK = 12.5;
const CAM_LERP = 6.5;

export class Player {
  readonly mesh: THREE.Group;
  stats: PlayerStats = { ...BASE_PLAYER };
  hp = BASE_PLAYER.maxHp;
  alive = true;

  readonly position = new THREE.Vector3(0, 0, 0);
  readonly facing = new THREE.Vector3(0, 0, -1);

  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private keys = new Set<string>();
  private camYaw = 0;
  private readonly camTarget = new THREE.Vector3();
  private readonly moveDir = new THREE.Vector3();

  private world: World;

  constructor(world: World) {
    this.world = world;
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HALF_HEIGHT * 2, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0xf4f6ff, emissive: 0x3355ff, emissiveIntensity: 0.35 }),
    );
    body.position.y = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS;
    group.add(body);

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x4d7dff, emissive: 0x2244ff, emissiveIntensity: 0.6 }),
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS, -0.55);
    group.add(nose);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.62, 24),
      new THREE.MeshBasicMaterial({ color: 0x6f9bff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    group.add(ring);

    this.mesh = group;
    world.scene.add(group);

    this.body = world.physics.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 2, 0),
    );
    this.collider = world.physics.createCollider(
      RAPIER.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS),
      this.body,
    );
    this.controller = world.physics.createCharacterController(0.02);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.controller.enableAutostep(0.7, 0.3, true);
    this.controller.enableSnapToGround(0.7);
    this.controller.setMaxSlopeClimbAngle((60 * Math.PI) / 180);

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    if (e.code === "KeyQ") this.camYaw += Math.PI / 8;
    if (e.code === "KeyE") this.camYaw -= Math.PI / 8;
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  reset(spawn = new THREE.Vector3(0, 0, 0)): void {
    const y = this.world.groundHeight(spawn.x, spawn.z) + CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS + 0.1;
    this.body.setNextKinematicTranslation({ x: spawn.x, y, z: spawn.z });
    this.body.setTranslation({ x: spawn.x, y, z: spawn.z }, true);
    this.position.set(spawn.x, y, spawn.z);
    this.mesh.position.copy(this.position);
    this.hp = this.stats.maxHp;
    this.alive = true;
    this.keys.clear();
  }

  setStats(stats: PlayerStats): void {
    const gained = stats.maxHp - this.stats.maxHp;
    this.stats = stats;
    if (gained > 0) this.hp = Math.min(stats.maxHp, this.hp + gained);
  }

  damage(amount: number): void {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
  }

  update(dt: number): void {
    if (!this.alive) return;

    this.moveDir.set(0, 0, 0);
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) this.moveDir.z -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) this.moveDir.z += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) this.moveDir.x -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) this.moveDir.x += 1;

    if (this.moveDir.lengthSq() > 0) {
      this.moveDir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.camYaw);
      this.facing.lerp(this.moveDir, Math.min(1, dt * 14)).normalize();
    }

    const step = this.stats.speed * dt;
    const desired = {
      x: this.moveDir.x * step,
      y: -12 * dt, // gravity, resolved by the character controller
      z: this.moveDir.z * step,
    };

    this.controller.computeColliderMovement(this.collider, desired);
    const move = this.controller.computedMovement();
    const t = this.body.translation();
    const next = { x: t.x + move.x, y: t.y + move.y, z: t.z + move.z };

    // Never let the player fall out of a generated world.
    if (next.y < -25) {
      next.y = this.world.groundHeight(next.x, next.z) + CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS + 0.2;
    }

    this.body.setNextKinematicTranslation(next);
    this.position.set(next.x, next.y, next.z);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = Math.atan2(this.facing.x, this.facing.z) + Math.PI;

    if (this.hp < this.stats.maxHp) {
      this.hp = Math.min(this.stats.maxHp, this.hp + this.stats.regen * dt);
    }
  }

  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const offset = new THREE.Vector3(0, CAM_HEIGHT, CAM_BACK).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      this.camYaw,
    );
    this.camTarget.copy(this.position).add(offset);
    camera.position.lerp(this.camTarget, Math.min(1, dt * CAM_LERP));
    camera.lookAt(this.position.x, this.position.y + 1.2, this.position.z);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.world.scene.remove(this.mesh);
    this.world.physics.removeCharacterController(this.controller);
    this.world.physics.removeCollider(this.collider, false);
    this.world.physics.removeRigidBody(this.body);
  }
}
