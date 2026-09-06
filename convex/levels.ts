import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { archetype, cardSkin, levelStatus, themeTag } from "./schema";
import { THEME_TAGS } from "./composer";

// Seed worlds are served from /public/worlds when cached (npm run fetch:worlds)
// and fall back to the CDN at load time. See src/game/net.ts.
const BASE = "/worlds";

/**
 * A forge that has not moved in this long is treated as dead (backend restart,
 * a lost scheduler run) and may be retried. Without this a single interrupted
 * forge would wedge that rung — and the whole ladder above it — forever.
 */
const FORGE_STALE_MS = 20 * 60_000;

function forgeIsStale(level: { status: string; forgeStartedAt?: number }): boolean {
  return (
    level.status.startsWith("forging") &&
    Date.now() - (level.forgeStartedAt ?? 0) > FORGE_STALE_MS
  );
}

/**
 * How long the architect has to describe their floor before the tower writes
 * it for them. A closed tab must not stall the rung for everyone else.
 */
const ARCHITECT_GRACE_MS = 120_000;

/** Rungs that exist before anyone has forged anything. */
const SEED = [
  { index: 1, theme: "haunted house", themeTag: "void", splatUrl: `${BASE}/haunted-house.spz` },
  { index: 2, theme: "cozy ship", themeTag: "stone", splatUrl: `${BASE}/cozy_ship.spz` },
  { index: 3, theme: "cozy cottage", themeTag: "nature", splatUrl: `${BASE}/cozy_cottage.spz` },
  { index: 4, theme: "derelict spaceship", themeTag: "tech", splatUrl: `${BASE}/cozy-spaceship_2.spz` },
] as const;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const levels = await ctx.db.query("levels").withIndex("by_index").collect();
    return levels.sort((a, b) => a.index - b.index);
  },
});

export const progressFor = query({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    const row = await ctx.db
      .query("progress")
      .withIndex("by_user", (q) => q.eq("user", user))
      .unique();
    return row?.maxCleared ?? 0;
  },
});

/** Top clears of one rung, best score first. */
export const leaderboard = query({
  args: { levelIndex: v.number() },
  handler: async (ctx, { levelIndex }) => {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_level", (q) => q.eq("levelIndex", levelIndex))
      .collect();
    return runs
      .filter((r) => r.cleared)
      .sort((a, b) => b.score - a.score || a.timeSeconds - b.timeSeconds)
      .slice(0, 10)
      .map((r) => ({ user: r.user, score: r.score, timeSeconds: r.timeSeconds, at: r._creationTime }));
  },
});

export interface Standing {
  user: string;
  maxCleared: number;
  bestScore: number;
  clears: number;
  deaths: number;
  /** Rungs this player claimed by clearing the frontier first. */
  forged: number;
}

/**
 * The tower-wide leaderboard: who has climbed highest, and with what score.
 * Ranked by highest rung cleared, then rungs forged, then best score, then
 * fewest deaths. Every table here is tiny for a room of players, so a full
 * scan is fine and the query stays reactive.
 */
export const standings = query({
  args: {},
  handler: async (ctx): Promise<Standing[]> => {
    const rows = new Map<string, Standing>();
    const row = (user: string): Standing => {
      let r = rows.get(user);
      if (!r) {
        r = { user, maxCleared: 0, bestScore: 0, clears: 0, deaths: 0, forged: 0 };
        rows.set(user, r);
      }
      return r;
    };

    for (const p of await ctx.db.query("progress").collect()) {
      row(p.user).maxCleared = Math.max(row(p.user).maxCleared, p.maxCleared);
    }
    for (const r of await ctx.db.query("runs").collect()) {
      const s = row(r.user);
      if (r.cleared) {
        s.clears++;
        s.bestScore = Math.max(s.bestScore, r.score);
      } else {
        s.deaths++;
      }
    }
    for (const l of await ctx.db.query("levels").collect()) {
      if (l.forgedBy) row(l.forgedBy).forged++;
    }

    return [...rows.values()]
      .sort(
        (a, b) =>
          b.maxCleared - a.maxCleared ||
          b.forged - a.forged ||
          b.bestScore - a.bestScore ||
          a.deaths - b.deaths ||
          a.user.localeCompare(b.user),
      )
      .slice(0, 25);
  },
});

/** Idempotent: safe to call on every client boot. */
export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    for (const s of SEED) {
      const existing = await ctx.db
        .query("levels")
        .withIndex("by_index", (q) => q.eq("index", s.index))
        .unique();
      if (existing) continue;
      await ctx.db.insert("levels", {
        index: s.index,
        theme: s.theme,
        themeTag: s.themeTag,
        status: "ready",
        tally: {},
        splatUrl: s.splatUrl,
        forgedBy: null,
        coForgers: [],
        seed: true,
      });
    }
  },
});

/**
 * Every upgrade pick is a vote on what the next level becomes.
 * Only votes cast on the frontier count — you cannot stuff the ballot by
 * replaying an old level you have already beaten.
 */
export const recordPick = mutation({
  args: { levelIndex: v.number(), tag: themeTag },
  handler: async (ctx, { levelIndex, tag }) => {
    if (!THEME_TAGS.includes(tag)) return;

    const frontier = await frontierIndex(ctx);
    if (levelIndex !== frontier) return;

    const level = await byIndex(ctx, levelIndex);
    if (!level) return;

    const tally = { ...level.tally, [tag]: (level.tally[tag] ?? 0) + 1 };
    await ctx.db.patch(level._id, { tally });
  },
});

/**
 * First player to clear the frontier earns the next floor: the rung is created
 * `awaiting`, owned by them, and they get to say what it is. Anyone else who
 * clears it before that floor opens goes on the plaque beside them.
 */
export const clearLevel = mutation({
  args: {
    levelIndex: v.number(),
    user: v.string(),
    score: v.number(),
    timeSeconds: v.number(),
  },
  handler: async (ctx, { levelIndex, user, score, timeSeconds }) => {
    await ctx.db.insert("runs", { user, levelIndex, score, cleared: true, timeSeconds });

    const progress = await ctx.db
      .query("progress")
      .withIndex("by_user", (q) => q.eq("user", user))
      .unique();
    if (progress) {
      if (levelIndex > progress.maxCleared) {
        await ctx.db.patch(progress._id, { maxCleared: levelIndex });
      }
    } else {
      await ctx.db.insert("progress", { user, maxCleared: levelIndex });
    }

    const next = await byIndex(ctx, levelIndex + 1);
    if (!next) {
      // This whole handler is ONE transaction, so two players who clear at the
      // same instant cannot both insert the rung: the loser re-runs against the
      // committed row and falls through to the plaque below.
      const current = await byIndex(ctx, levelIndex);
      if (!current) return { forgedBy: null, first: false, canWrite: false };
      const id = await ctx.db.insert("levels", {
        index: levelIndex + 1,
        theme: "unwritten",
        themeTag: "stone",
        status: "awaiting",
        tally: { ...current.tally },
        forgedBy: user,
        coForgers: [],
        // Starts the architect's clock; also what reapStuckForges measures.
        forgeStartedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(ARCHITECT_GRACE_MS, internal.levels.autoForge, { levelId: id });
      return { forgedBy: user, first: true, canWrite: true };
    }

    if (next.forgedBy === null) {
      // A rung that exists but nobody owns (a seed floor, or one forged from
      // votes by the dev button): claim the monument, but it is already written.
      const patch: { forgedBy: string; status?: "ready" } = { forgedBy: user };
      if (next.status === "sealed") patch.status = "ready";
      await ctx.db.patch(next._id, patch);
      return { forgedBy: user, first: true, canWrite: false };
    }

    if (next.forgedBy !== user && !next.coForgers.includes(user)) {
      await ctx.db.patch(next._id, { coForgers: [...next.coForgers, user] });
    }
    // The architect may reload mid-write; let them back into their own desk.
    const canWrite = next.forgedBy === user && next.status === "awaiting";
    return { forgedBy: next.forgedBy, first: false, canWrite };
  },
});

/**
 * The architect's answer. Their words go to the world model as-is; the message
 * is inscribed on the floor for everyone who climbs it afterwards.
 *
 * Guarded on both owner and status, so a stale tab cannot rewrite a floor that
 * has already started forging, and nobody can write a floor they did not earn.
 */
export const describeLevel = mutation({
  args: {
    levelIndex: v.number(),
    user: v.string(),
    prompt: v.string(),
    message: v.optional(v.string()),
  },
  handler: async (ctx, { levelIndex, user, prompt, message }) => {
    const level = await byIndex(ctx, levelIndex);
    if (!level) return { started: false as const, reason: "no such floor" };
    if (level.forgedBy !== user) return { started: false as const, reason: "not yours to write" };
    if (level.status !== "awaiting") {
      return { started: false as const, reason: `already ${level.status}` };
    }

    const text = prompt.trim().slice(0, 240);
    if (text.length === 0) return { started: false as const, reason: "empty prompt" };

    await ctx.db.patch(level._id, {
      prompt: text,
      message: clean(message),
      status: "forging:composing",
      forgeStartedAt: Date.now(),
      error: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.forge.generate, { levelId: level._id });
    return { started: true as const, reason: null };
  },
});

/**
 * The architect never came back. Forge the floor from the room's votes so the
 * ladder keeps moving; a no-op if they already wrote it.
 */
export const autoForge = internalMutation({
  args: { levelId: v.id("levels") },
  handler: async (ctx, { levelId }) => {
    const level = await ctx.db.get(levelId);
    if (!level || level.status !== "awaiting") return false;
    await ctx.db.patch(levelId, {
      status: "forging:composing",
      forgeStartedAt: Date.now(),
      error: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.forge.generate, { levelId });
    return true;
  },
});

/** One line, no control characters, short enough to read at a run. */
function clean(message: string | undefined): string | undefined {
  if (!message) return undefined;
  // eslint-disable-next-line no-control-regex
  const text = message.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text.slice(0, 80) : undefined;
}

/** Sweep forges that died mid-flight so their rungs can be retried. */
export const reapStuckForges = mutation({
  args: {},
  handler: async (ctx) => {
    const levels = await ctx.db.query("levels").withIndex("by_index").collect();
    let reaped = 0;
    for (const level of levels) {
      // An awaiting rung whose auto-forge was lost: write it from the votes
      // rather than leaving the ladder capped forever.
      if (
        level.status === "awaiting" &&
        Date.now() - (level.forgeStartedAt ?? 0) > ARCHITECT_GRACE_MS * 2
      ) {
        await ctx.scheduler.runAfter(0, internal.levels.autoForge, { levelId: level._id });
        reaped++;
        continue;
      }
      if (!forgeIsStale(level)) continue;
      await ctx.db.patch(level._id, {
        status: "failed",
        error: "forge interrupted (backend restart or lost scheduler run)",
      });
      reaped++;
    }
    return reaped;
  },
});

export const recordDeath = mutation({
  args: {
    levelIndex: v.number(),
    user: v.string(),
    score: v.number(),
    timeSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("runs", { ...args, cleared: false });
  },
});

/**
 * Dev button: forge a rung without clearing anything. With a prompt, this is
 * also how floors get pre-forged before a demo.
 */
export const forgeNow = mutation({
  args: { tag: themeTag, prompt: v.optional(v.string()), message: v.optional(v.string()) },
  handler: async (ctx, { tag, prompt, message }) => {
    const levels = await ctx.db.query("levels").withIndex("by_index").collect();
    const nextIndex = levels.reduce((m, l) => Math.max(m, l.index), 0) + 1;
    const id = await ctx.db.insert("levels", {
      index: nextIndex,
      theme: "unforged",
      themeTag: "stone",
      status: "forging:composing",
      tally: { [tag]: 1 },
      prompt: prompt?.trim().slice(0, 240) || undefined,
      message: clean(message),
      forgedBy: null,
      coForgers: [],
      forgeStartedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.forge.generate, { levelId: id });
    return nextIndex;
  },
});

// ---- internal helpers used by the forge action -----------------------------

export const getLevel = internalQuery({
  args: { levelId: v.id("levels") },
  handler: async (ctx, { levelId }) => await ctx.db.get(levelId),
});

export const setStatus = internalMutation({
  args: { levelId: v.id("levels"), status: levelStatus, error: v.optional(v.string()) },
  handler: async (ctx, { levelId, status, error }) => {
    await ctx.db.patch(levelId, { status, error });
  },
});

export const applyComposition = internalMutation({
  args: {
    levelId: v.id("levels"),
    theme: v.string(),
    themeTag,
    worldPrompt: v.string(),
    enemyPrompt: v.string(),
    monumentPrompt: v.string(),
    composition: v.array(v.array(archetype)),
    cardSkins: v.array(cardSkin),
  },
  handler: async (ctx, { levelId, ...fields }) => {
    await ctx.db.patch(levelId, { ...fields, status: "forging:world" });
  },
});

export const rememberProvider = internalMutation({
  args: {
    levelId: v.id("levels"),
    providerWorldId: v.optional(v.string()),
    providerEnemyId: v.optional(v.string()),
    providerMonumentId: v.optional(v.string()),
  },
  handler: async (ctx, { levelId, ...ids }) => {
    const patch: Record<string, string> = {};
    for (const [k, val] of Object.entries(ids)) if (val) patch[k] = val;
    if (Object.keys(patch).length > 0) await ctx.db.patch(levelId, patch);
  },
});

export const applyAssets = internalMutation({
  args: {
    levelId: v.id("levels"),
    splatUrl: v.optional(v.string()),
    colliderUrl: v.optional(v.string()),
    enemyUrl: v.optional(v.string()),
    monumentUrl: v.optional(v.string()),
    yOffset: v.optional(v.number()),
    scale: v.optional(v.number()),
    // A measured ring beats the seed table's hand-tuned one once a rung has
    // a real collider; the client only falls back to the table when unset.
    arenaRadius: v.optional(v.number()),
    status: v.optional(levelStatus),
  },
  handler: async (ctx, { levelId, status, ...assets }) => {
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(assets)) {
      if (val !== undefined) patch[k] = val;
    }
    if (status) patch.status = status;
    await ctx.db.patch(levelId, patch);
  },
});

export const finishForge = internalMutation({
  args: { levelId: v.id("levels") },
  handler: async (ctx, { levelId }) => {
    const level = await ctx.db.get(levelId);
    if (!level) return;
    // A level nobody has cleared yet stays sealed: visible on the ladder,
    // not enterable until someone earns it.
    await ctx.db.patch(levelId, {
      status: level.forgedBy ? "ready" : "sealed",
      forgeEndedAt: Date.now(),
    });
  },
});

async function byIndex(
  ctx: { db: { query: (t: "levels") => any } },
  index: number,
) {
  return await ctx.db
    .query("levels")
    .withIndex("by_index", (q: any) => q.eq("index", index))
    .unique();
}

async function frontierIndex(ctx: { db: { query: (t: "levels") => any } }): Promise<number> {
  const levels = await ctx.db.query("levels").withIndex("by_index").collect();
  return levels.reduce((m: number, l: { index: number }) => Math.max(m, l.index), 0);
}

/** Dev-only: drop a rung entirely. Used to clean up botched experiments. */
export const removeLevel = mutation({
  args: { index: v.number() },
  handler: async (ctx, { index }) => {
    const level = await byIndex(ctx, index);
    if (level) await ctx.db.delete(level._id);
  },
});

/** Dev: hand a rung an already-generated Mint world (see forge.adopt). */
export const adoptWorld = mutation({
  args: { index: v.number(), worldId: v.string() },
  handler: async (ctx, { index, worldId }) => {
    const level = await byIndex(ctx, index);
    if (!level) throw new Error(`no level ${index}`);
    await ctx.db.patch(level._id, { status: "forging:world", error: undefined });
    await ctx.scheduler.runAfter(0, internal.forge.adopt, { levelId: level._id, worldId });
  },
});

/** Dev: close a gap in the ladder. A missing rung is unreachable forever. */
export const renumber = mutation({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const source = await byIndex(ctx, from);
    if (!source) throw new Error(`no level ${from}`);
    if (await byIndex(ctx, to)) throw new Error(`level ${to} already exists`);
    await ctx.db.patch(source._id, { index: to });
  },
});

// ---- dev helpers for scripts/race-test.mjs ---------------------------------

/**
 * Dev: insert a bare rung with no assets so the clear race can be exercised
 * against a real backend without triggering a forge. Idempotent.
 */
export const devInsertLevel = mutation({
  args: { index: v.number(), status: levelStatus },
  handler: async (ctx, { index, status }) => {
    if (await byIndex(ctx, index)) return false;
    await ctx.db.insert("levels", {
      index,
      theme: `test rung ${index}`,
      themeTag: "stone",
      status,
      tally: {},
      forgedBy: null,
      coForgers: [],
    });
    return true;
  },
});

/** Dev: erase the runs and progress of test players whose names share a prefix. */
export const devPurgeUsers = mutation({
  args: { prefix: v.string() },
  handler: async (ctx, { prefix }) => {
    if (prefix.length < 4) throw new Error("refusing to purge with a prefix shorter than 4 chars");
    let removed = 0;
    for (const r of await ctx.db.query("runs").collect()) {
      if (r.user.startsWith(prefix)) {
        await ctx.db.delete(r._id);
        removed++;
      }
    }
    for (const p of await ctx.db.query("progress").collect()) {
      if (p.user.startsWith(prefix)) {
        await ctx.db.delete(p._id);
        removed++;
      }
    }
    return removed;
  },
});

/** Dev: inspect provider handles for a rung. */
export const providerFor = query({
  args: { index: v.number() },
  handler: async (ctx, { index }) => {
    const l = await byIndex(ctx, index);
    return l
      ? {
          status: l.status,
          world: l.providerWorldId ?? null,
          enemy: l.providerEnemyId ?? null,
          monument: l.providerMonumentId ?? null,
        }
      : null;
  },
});

/** Restart the poller for a rung whose forge stalled (see convex/forge.ts). */
export const resumeForge = mutation({
  args: { index: v.number() },
  handler: async (ctx, { index }) => {
    const level = await byIndex(ctx, index);
    if (!level) throw new Error(`no level ${index}`);

    if (level.status === "forging:world" && level.providerWorldId) {
      await ctx.scheduler.runAfter(0, internal.forge.pollWorld, { levelId: level._id });
      return "polling world";
    }
    if (level.status === "forging:creatures") {
      await ctx.scheduler.runAfter(0, internal.forge.startCreatures, { levelId: level._id });
      return "polling creatures";
    }
    await ctx.db.patch(level._id, { status: "forging:composing", forgeStartedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.forge.generate, { levelId: level._id });
    return "restarted";
  },
});
