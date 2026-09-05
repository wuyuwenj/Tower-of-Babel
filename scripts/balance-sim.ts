// Headless balance probe: can a competent player clear each rung, and does the
// curve actually tighten with depth? Pure functions from balance.ts, no browser.
import {
  ARCHETYPES, CARD_TIERS, WAVES_PER_LEVEL, WAVE_SPAWN_SECONDS, startingStats,
  damageScale, hpScale, waveBudget, weaponPower, xpForLevel, xpScale, hpScale as _hp, type Archetype, type PlayerStats,
} from "../src/game/balance";

const COMPOSITION: Archetype[][] = [["swarm"], ["swarm", "fast"], ["boss", "fast", "swarm"]];

function buildQueue(allowed: Archetype[], budget: number): Archetype[] {
  const q: Archetype[] = [];
  let rem = budget;
  if (allowed.includes("boss")) { q.push("boss"); rem -= ARCHETYPES.boss.cost; }
  const pool = allowed.filter((a) => a !== "boss");
  const usable = pool.length ? pool : (["swarm"] as Archetype[]);
  while (rem > 0) {
    const aff = usable.filter((a) => ARCHETYPES[a].cost <= rem);
    if (!aff.length) break;
    const pick = aff[Math.floor(Math.random() * aff.length)];
    q.push(pick); rem -= ARCHETYPES[pick].cost;
  }
  return q;
}

/** Greedy build: always take the strongest available tier of a rotating slot. */
function levelUp(stats: PlayerStats, playerLevel: number, levelIndex: number): PlayerStats {
  const tier = playerLevel >= 8 ? 3 : playerLevel >= 4 ? 2 : 1;
  const slots = ["damage", "area", "utility", "defense"] as const;
  const slot = slots[playerLevel % slots.length];
  const delta = CARD_TIERS[slot][tier - 1];
  const depth = hpScale(levelIndex);
  const next = { ...stats };
  for (const [k, v] of Object.entries(delta) as Array<[keyof PlayerStats, number]>)
    next[k] += k === "damage" || k === "maxHp" ? v * depth : v;
  next.attackCooldown = Math.max(0.12, next.attackCooldown);
  return next;
}

function simulate(levelIndex: number, skill: number): { cleared: boolean; hp: number; secs: number } {
  let stats: PlayerStats = startingStats(levelIndex);
  let hp = stats.maxHp, xp = 0, plevel = 1, secs = 0;
  const hs = hpScale(levelIndex);
  const ds = damageScale(levelIndex);
  const xs = xpScale(levelIndex);

  for (let wave = 1; wave <= WAVES_PER_LEVEL; wave++) {
    const queue = buildQueue(COMPOSITION[wave - 1], waveBudget(levelIndex, wave));
    const window = WAVE_SPAWN_SECONDS[wave - 1];
    // Enemies arrive over the window and are killed at the player's DPS.
    const totalHp = queue.reduce((s, a) => s + ARCHETYPES[a].hp * hs, 0);
    const targets = stats.splashRadius > 0 ? Math.min(6, 2 + stats.splashRadius) : 1;
    const dps = ((stats.damage * weaponPower(plevel)) / stats.attackCooldown) * targets;
    const killSecs = totalHp / dps;
    const dur = Math.max(window, killSecs);

    // `skill` is the fraction of contact damage the player dodges.
    const pressure = queue.reduce((s, a) => s + ARCHETYPES[a].damage * ds, 0) / queue.length;
    // Only a handful of enemies can touch a kiting player at once, however
    // large the crowd is. Density raises that number, but with hard limits.
    const contact = Math.min(9, 1 + Math.sqrt(queue.length) * 1.15);
    const taken = pressure * contact * dur * 0.042 * (1 - skill);
    hp = Math.min(stats.maxHp, hp + stats.regen * dur) - taken;
    secs += dur;
    if (hp <= 0) return { cleared: false, hp: 0, secs };

    xp += Math.round(queue.reduce((s, a) => s + ARCHETYPES[a].xp, 0) * xs);
    while (xp >= xpForLevel(plevel)) {
      xp -= xpForLevel(plevel); plevel++;
      const before = stats.maxHp;
      stats = levelUp(stats, plevel, levelIndex);
      hp += stats.maxHp - before;
    }
  }
  return { cleared: true, hp, secs };
}

console.log("lvl  budget(w1/2/3)   novice   average   expert    time   wave3    depth");
for (const levelIndex of [1, 2, 3, 5, 8, 12, 16, 20]) {
  const b = [1, 2, 3].map((w) => waveBudget(levelIndex, w)).join("/");
  const row = [0.25, 0.5, 0.75].map((skill) => {
    let wins = 0, secs = 0;
    for (let i = 0; i < 400; i++) { const r = simulate(levelIndex, skill); if (r.cleared) wins++; secs += r.secs; }
    return { rate: wins / 400, secs: secs / 400 };
  });
  const peak = buildQueue(COMPOSITION[2], waveBudget(levelIndex, 3)).length;
  console.log(
    `${String(levelIndex).padStart(3)}  ${b.padEnd(16)} ` +
    row.map((r) => `${(r.rate * 100).toFixed(0).padStart(4)}%`).join("    ") +
    `   ${row[1].secs.toFixed(0).padStart(4)}s  ${String(peak).padStart(4)} foes  hp x${hpScale(levelIndex).toFixed(1)} dmg x${damageScale(levelIndex).toFixed(1)}`,
  );
}
