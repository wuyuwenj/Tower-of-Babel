import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { archetype, cardSkin, levelStatus, themeTag } from "./schema";
import { THEME_TAGS } from "./composer";

const BASE = "https://storage.googleapis.com/forge-dev-public/hackathon-260227";

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

export const leaderboard = query({
  args: { levelIndex: v.number() },
  handler: async (ctx, { levelIndex }) => {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_level", (q) => q.eq("levelIndex", levelIndex))
      .collect();
    return runs
      .filter((r) => r.cleared)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
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
 * Fires the forge for level N+1 the moment the first player reaches the
 * frontier's boss wave, so the ~5 minute generation finishes while people
 * are still fighting.
 *
 * This whole handler is ONE Convex transaction: two players who hit the boss
 * at the same instant cannot both insert level N+1. The second one re-runs
 * against the committed state, sees the row, and no-ops.
 */
export const reachedBoss = mutation({
  args: { levelIndex: v.number() },
  handler: async (ctx, { levelIndex }) => {
    const existing = await byIndex(ctx, levelIndex + 1);
    if (existing && existing.status !== "failed" && !forgeIsStale(existing)) {
      return { started: false as const, status: existing.status };
    }

    const current = await byIndex(ctx, levelIndex);
    if (!current) return { started: false as const, status: null };

    const tally = { ...current.tally };

    let id;
    if (existing) {
      // Previous forge failed or died mid-flight; retry it with whatever the
      // room has voted since.
      id = existing._id;
      await ctx.db.patch(id, {
        status: "forging:composing",
        tally,
        forgeStartedAt: Date.now(),
        error: undefined,
      });
    } else {
      id = await ctx.db.insert("levels", {
        index: levelIndex + 1,
        theme: "unforged",
        themeTag: "stone",
        status: "forging:composing",
        tally,
        forgedBy: null,
        coForgers: [],
        forgeStartedAt: Date.now(),
      });
    }

    await ctx.scheduler.runAfter(0, internal.forge.generate, { levelId: id });
    return { started: true as const, status: "forging:composing" as const };
  },
});

/**
 * First player to clear the frontier owns the monument. Anyone else who clears
 * it while the next level is still forging goes on the plaque beside them.
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
    if (!next) return { forgedBy: null, first: false };

    if (next.forgedBy === null) {
      const patch: { forgedBy: string; status?: "ready" } = { forgedBy: user };
      if (next.status === "sealed") patch.status = "ready";
      await ctx.db.patch(next._id, patch);
      return { forgedBy: user, first: true };
    }

    if (next.forgedBy !== user && !next.coForgers.includes(user)) {
      await ctx.db.patch(next._id, { coForgers: [...next.coForgers, user] });
    }
    return { forgedBy: next.forgedBy, first: false };
  },
});

/** Sweep forges that died mid-flight so their rungs can be retried. */
export const reapStuckForges = mutation({
  args: {},
  handler: async (ctx) => {
    const levels = await ctx.db.query("levels").withIndex("by_index").collect();
    let reaped = 0;
    for (const level of levels) {
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

/** Dev button: forge a level from a typed theme without clearing anything. */
export const forgeNow = mutation({
  args: { tag: themeTag },
  handler: async (ctx, { tag }) => {
    const levels = await ctx.db.query("levels").withIndex("by_index").collect();
    const nextIndex = levels.reduce((m, l) => Math.max(m, l.index), 0) + 1;
    const id = await ctx.db.insert("levels", {
      index: nextIndex,
      theme: "unforged",
      themeTag: "stone",
      status: "forging:composing",
      tally: { [tag]: 1 },
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

export const applyAssets = internalMutation({
  args: {
    levelId: v.id("levels"),
    splatUrl: v.optional(v.string()),
    colliderUrl: v.optional(v.string()),
    enemyUrl: v.optional(v.string()),
    monumentUrl: v.optional(v.string()),
    yOffset: v.optional(v.number()),
    scale: v.optional(v.number()),
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
