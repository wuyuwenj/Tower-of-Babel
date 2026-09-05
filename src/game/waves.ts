import * as THREE from "three";
import {
  ARCHETYPES,
  WAVES_PER_LEVEL,
  WAVE_SPAWN_SECONDS,
  waveBudget,
  type Archetype,
} from "./balance";
import type { Enemies } from "./enemies";
import type { Director } from "./director";

export const DEFAULT_COMPOSITION: Archetype[][] = [
  ["swarm"],
  ["swarm", "fast"],
  ["boss", "swarm", "fast"],
];

export type WaveState = "spawning" | "clearing" | "complete";

export class Waves {
  wave = 1;
  state: WaveState = "spawning";
  levelCleared = false;

  private queue: Archetype[] = [];
  private spawnTimer = 0;
  private interval = 1;
  private composition: Archetype[][] = DEFAULT_COMPOSITION;
  private levelIndex = 1;
  private enemies: Enemies;
  private director: Director;

  constructor(enemies: Enemies, director: Director) {
    this.enemies = enemies;
    this.director = director;
  }

  start(levelIndex: number, composition: Archetype[][] | null): void {
    this.levelIndex = levelIndex;
    this.composition = normalizeComposition(composition);
    this.wave = 1;
    this.levelCleared = false;
    this.beginWave();
  }

  private beginWave(): void {
    this.queue = buildQueue(this.composition[this.wave - 1], waveBudget(this.levelIndex, this.wave));
    const seconds = WAVE_SPAWN_SECONDS[this.wave - 1] ?? 26;
    this.interval = this.queue.length > 0 ? seconds / this.queue.length : seconds;
    this.spawnTimer = 0;
    this.state = "spawning";
  }

  get remaining(): number {
    return this.queue.length + this.enemies.aliveCount;
  }

  update(dt: number, origin: THREE.Vector3): void {
    if (this.state === "complete") return;

    if (this.state === "spawning") {
      this.spawnTimer -= dt * this.director.multiplier;
      while (this.spawnTimer <= 0 && this.queue.length > 0) {
        const archetype = this.queue.shift()!;
        this.enemies.spawn(archetype, this.levelIndex, origin);
        this.spawnTimer += this.interval;
      }
      if (this.queue.length === 0) this.state = "clearing";
      return;
    }

    if (this.state === "clearing" && this.enemies.aliveCount === 0) {
      if (this.wave >= WAVES_PER_LEVEL) {
        this.state = "complete";
        this.levelCleared = true;
      } else {
        this.wave += 1;
        this.beginWave();
      }
    }
  }
}

function normalizeComposition(input: Archetype[][] | null): Archetype[][] {
  if (!input || input.length === 0) return DEFAULT_COMPOSITION;
  const out: Archetype[][] = [];
  for (let i = 0; i < WAVES_PER_LEVEL; i++) {
    const wave = input[i]?.filter((a) => a in ARCHETYPES) ?? [];
    out.push(wave.length > 0 ? wave : DEFAULT_COMPOSITION[i]);
  }
  // The final wave is always a boss wave, whatever the composer said.
  if (!out[WAVES_PER_LEVEL - 1].includes("boss")) {
    out[WAVES_PER_LEVEL - 1] = ["boss", ...out[WAVES_PER_LEVEL - 1]];
  }
  return out;
}

/** Spend the wave's point budget on the allowed archetypes. Exactly one boss. */
function buildQueue(allowed: Archetype[], budget: number): Archetype[] {
  const queue: Archetype[] = [];
  let remaining = budget;

  if (allowed.includes("boss")) {
    queue.push("boss");
    remaining -= ARCHETYPES.boss.cost;
  }

  const pool = allowed.filter((a) => a !== "boss");
  const usable = pool.length > 0 ? pool : (["swarm"] as Archetype[]);
  let guard = 0;
  while (remaining > 0 && guard++ < 2000) {
    const affordable = usable.filter((a) => ARCHETYPES[a].cost <= remaining);
    if (affordable.length === 0) break;
    const pick = affordable[Math.floor(Math.random() * affordable.length)];
    queue.push(pick);
    remaining -= ARCHETYPES[pick].cost;
  }

  // Boss first, then trickle the escorts in.
  const boss = queue.filter((a) => a === "boss");
  const rest = queue.filter((a) => a !== "boss").sort(() => Math.random() - 0.5);
  return [...boss, ...rest];
}
