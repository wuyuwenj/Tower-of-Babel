import * as THREE from "three";
import { BASE_PLAYER, THEME_COLOR, WAVES_PER_LEVEL, xpForLevel, type Archetype, type PlayerStats, type ThemeTag } from "./balance";
import { EventBus } from "./bus";
import { applyCard, rollOffers, type CardOffer, type CardSkin } from "./cards";
import { Combat } from "./combat";
import { Director } from "./director";
import { Enemies } from "./enemies";
import { Player } from "./player";
import { Waves } from "./waves";
import { World, type WorldSpec } from "./world";

export interface LevelSpec extends WorldSpec {
  levelIndex: number;
  themeTag: ThemeTag;
  composition: Archetype[][] | null;
  cardSkins: CardSkin[] | null;
}

export class Game {
  readonly bus = new EventBus();

  private world: World;
  private player: Player;
  private enemies: Enemies;
  private combat: Combat;
  private waves: Waves;
  private director = new Director();

  private stats: PlayerStats = { ...BASE_PLAYER };
  private playerLevel = 1;
  private xp = 0;
  private kills = 0;
  private elapsed = 0;
  private levelIndex = 1;
  private cardSkins: CardSkin[] | null = null;
  private paused = true;
  private running = false;
  private ended = false;
  private raf = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;

  private constructor(world: World) {
    this.world = world;
    this.enemies = new Enemies(world);
    this.player = new Player(world);
    this.combat = new Combat(world.scene, this.enemies);
    this.waves = new Waves(this.enemies, this.director);
  }

  static async create(canvas: HTMLCanvasElement): Promise<Game> {
    const world = await World.create(canvas);
    return new Game(world);
  }

  async loadLevel(spec: LevelSpec): Promise<void> {
    this.paused = true;
    this.bus.emit("loading", { stage: "Preparing", done: false });

    this.enemies.clear();
    this.combat.clear();

    await this.world.load(spec, (stage) => this.bus.emit("loading", { stage, done: false }));

    const color = THEME_COLOR[spec.themeTag] ?? 0xffffff;
    this.enemies.setTheme(color);
    this.combat.setThemeColor(color);

    this.levelIndex = spec.levelIndex;
    this.cardSkins = spec.cardSkins;
    this.stats = { ...BASE_PLAYER };
    this.player.setStats(this.stats);
    this.player.reset(new THREE.Vector3(0, 0, 0));
    this.playerLevel = 1;
    this.xp = 0;
    this.kills = 0;
    this.elapsed = 0;
    this.ended = false;
    this.director.reset();
    this.waves.start(spec.levelIndex, spec.composition);

    this.emitHp();
    this.emitXp();
    this.emitWave();
    this.bus.emit("boss", null);
    this.bus.emit("loading", { stage: "Ready", done: true });
    this.paused = false;

    if (!this.running) this.start();
  }

  private start(): void {
    this.running = true;
    let last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.tick(dt);
      this.world.render();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.bus.emit("fps", { value: Math.round(this.fpsFrames / this.fpsAccum) });
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.paused || this.ended) {
      this.player.updateCamera(this.world.camera, dt);
      return;
    }

    this.elapsed += dt;
    this.world.physics.step();
    this.player.update(dt);

    const contact = this.enemies.update(dt, this.elapsed, this.player.position, 0.5);
    if (contact > 0) {
      this.player.damage(contact);
      this.director.noteDamage(contact);
      this.emitHp();
    }
    this.director.update(dt, this.player.hp / this.stats.maxHp);

    const before = this.enemies.aliveCount;
    const gained = this.combat.update(dt, this.player.position, this.stats);
    const after = this.enemies.aliveCount;
    if (after < before) this.kills += before - after;
    if (gained > 0) this.addXp(gained);

    const prevWave = this.waves.wave;
    const prevState = this.waves.state;
    this.waves.update(dt, this.player.position);
    if (this.waves.wave !== prevWave || this.waves.state !== prevState) this.emitWave();

    const boss = this.enemies.bossAlive();
    this.bus.emit("boss", boss ? { hp: boss.hp, maxHp: boss.maxHp } : null);

    this.player.updateCamera(this.world.camera, dt);

    if (!this.player.alive) {
      this.ended = true;
      this.bus.emit("death", {
        levelIndex: this.levelIndex,
        score: this.score(),
        timeSeconds: this.elapsed,
      });
      return;
    }

    if (this.waves.levelCleared) {
      this.ended = true;
      this.bus.emit("clear", {
        levelIndex: this.levelIndex,
        score: this.score(),
        timeSeconds: this.elapsed,
      });
    }
  }

  private score(): number {
    return Math.round(this.kills * 10 + this.playerLevel * 60 + this.levelIndex * 150 + this.elapsed);
  }

  private addXp(amount: number): void {
    this.xp += amount;
    let needed = xpForLevel(this.playerLevel);
    while (this.xp >= needed) {
      this.xp -= needed;
      this.playerLevel += 1;
      needed = xpForLevel(this.playerLevel);
      this.offerCards();
    }
    this.emitXp();
  }

  private offerCards(): void {
    this.paused = true;
    this.bus.emit("levelup", { offers: rollOffers(this.playerLevel, this.cardSkins) });
  }

  /** Called by the UI when the player picks a card. */
  choose(offer: CardOffer): void {
    this.stats = applyCard(this.stats, offer);
    this.player.setStats(this.stats);
    this.bus.emit("pick", { tag: offer.tag });
    this.emitHp();
    this.paused = false;
  }

  private emitHp(): void {
    this.bus.emit("hp", { hp: Math.max(0, this.player.hp), maxHp: this.stats.maxHp });
  }
  private emitXp(): void {
    this.bus.emit("xp", { xp: this.xp, needed: xpForLevel(this.playerLevel), level: this.playerLevel });
  }
  private emitWave(): void {
    this.bus.emit("wave", {
      wave: this.waves.wave,
      wavesPerLevel: WAVES_PER_LEVEL,
      remaining: this.waves.remaining,
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;
    this.combat.dispose();
    this.enemies.dispose();
    this.player.dispose();
    this.world.dispose();
    this.bus.clear();
  }
}

export type { CardOffer, CardSkin };
