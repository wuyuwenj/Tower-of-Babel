import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { BASE_PLAYER, type PlayerStats } from "./balance";
import type { World } from "./world";

const CAPSULE_HALF_HEIGHT = 0.55;
const CAPSULE_RADIUS = 0.42;
const CAM_HEIGHT = 13.5;
const CAM_BACK = 12.5;
const CAM_LERP = 6.5;

// Jump tuning. Apex = JUMP_SPEED² / 2·GRAVITY ≈ 1.7 units, about one capsule
// tall, airborne for ~0.7 s. Gravity is steeper than the world's so the hop
// feels snappy rather than floaty.
const GRAVITY = 26;
const JUMP_SPEED = 9.5;
const TERMINAL_VELOCITY = -30;
/** Seconds after leaving an edge during which a jump still counts. */
const COYOTE_TIME = 0.1;
/** Seconds a Space press is remembered while waiting to land. */
const JUMP_BUFFER = 0.12;
/** Downward push while grounded, so slopes and autostep keep resolving. */
const GROUND_STICK = 12;

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

  // Vertical state. Horizontal movement is direct; the jump is a velocity.
  private vy = 0;
  private grounded = true;
  private sinceGrounded = 0;
  private jumpBuffered = 0;
  /** Height of the last ground we stood on; the camera follows this, not the hop. */
  private groundY = 0;
  private camAnchorY = 0;
  /** Squash on landing and stretch in the air, purely cosmetic. */
  private squash = 0;

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
    if (e.code === "Space") {
      // Buffered, so a press a few frames before landing still fires.
      if (!e.repeat) this.jumpBuffered = JUMP_BUFFER;
      e.preventDefault();
    }
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
    this.vy = 0;
    this.grounded = true;
    this.sinceGrounded = 0;
    this.jumpBuffered = 0;
    this.groundY = y;
    this.camAnchorY = y;
    this.squash = 0;
    this.mesh.scale.setScalar(1);
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

    // Jump: from the ground, or within a breath of having left it.
    this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);
    if (this.jumpBuffered > 0 && (this.grounded || this.sinceGrounded < COYOTE_TIME)) {
      this.vy = JUMP_SPEED;
      this.grounded = false;
      this.sinceGrounded = COYOTE_TIME;
      this.jumpBuffered = 0;
    }
    if (!this.grounded) this.vy = Math.max(TERMINAL_VELOCITY, this.vy - GRAVITY * dt);

    const step = this.stats.speed * dt;
    const desired = {
      x: this.moveDir.x * step,
      // Grounded: a steady push down keeps slopes and steps resolving. Airborne:
      // the jump's own velocity. Snap-to-ground only applies when this is ≤ 0,
      // so it never swallows a take-off.
      y: this.grounded ? -GROUND_STICK * dt : this.vy * dt,
      z: this.moveDir.z * step,
    };

    this.controller.computeColliderMovement(this.collider, desired);
    const move = this.controller.computedMovement();
    const t = this.body.translation();
    const next = { x: t.x + move.x, y: t.y + move.y, z: t.z + move.z };

    // Head bump: if the ceiling ate most of the rise, stop rising.
    if (this.vy > 0 && move.y < desired.y * 0.5) this.vy = 0;

    // Rapier reports "grounded" for any move that started in contact with the
    // floor, including the take-off frame itself. Trusting it would zero the
    // jump 15 cm up, so a rising capsule is never grounded.
    const wasGrounded = this.grounded;
    this.grounded = this.vy <= 0 && this.controller.computedGrounded();
    if (this.grounded) {
      if (!wasGrounded) this.squash = Math.min(0.22, -this.vy / 55);
      this.vy = 0;
      this.sinceGrounded = 0;
      this.groundY = next.y;
    } else {
      this.sinceGrounded += dt;
    }

    // Never let the player fall out of a generated world.
    if (next.y < -25) {
      next.y = this.world.groundHeight(next.x, next.z) + CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS + 0.2;
      this.vy = 0;
      this.groundY = next.y;
    }

    this.body.setNextKinematicTranslation(next);
    this.position.set(next.x, next.y, next.z);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = Math.atan2(this.facing.x, this.facing.z) + Math.PI;

    // Stretch along the jump, squash on the landing, settle back to 1.
    this.squash *= Math.max(0, 1 - dt * 12);
    const stretch = THREE.MathUtils.clamp(this.vy / JUMP_SPEED, -1, 1) * 0.12;
    this.mesh.scale.set(1 - stretch * 0.6 + this.squash * 0.7, 1 + stretch - this.squash, 1 - stretch * 0.6 + this.squash * 0.7);

    if (this.hp < this.stats.maxHp) {
      this.hp = Math.min(this.stats.maxHp, this.hp + this.stats.regen * dt);
    }
  }

  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    // Follow the ground under the player, not the player: a jump should read
    // as the capsule leaving the frame's centre, not the whole world dipping.
    this.camAnchorY += (this.groundY - this.camAnchorY) * Math.min(1, dt * 8);
    const offset = new THREE.Vector3(0, CAM_HEIGHT, CAM_BACK).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      this.camYaw,
    );
    this.camTarget.set(this.position.x, this.camAnchorY, this.position.z).add(offset);
    camera.position.lerp(this.camTarget, Math.min(1, dt * CAM_LERP));
    camera.lookAt(this.position.x, this.camAnchorY + 1.2, this.position.z);
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
