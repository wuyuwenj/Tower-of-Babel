"use node";

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { compose, composeFromPrompt, CREATURE_SUFFIX, withArena } from "./composer";
import { enrich } from "./enrich";
import * as mint from "./mint";

const MARBLE = "https://api.worldlabs.ai/marble/v1";
const TRIPO = "https://api.tripo3d.ai/v2/openapi";
const FALLBACK_SPLAT = "/worlds/haunted-house.spz";

/** How often a pending generation is re-checked, and when we give up on it. */
const POLL_SECONDS = 20;
const WORLD_DEADLINE_MS = 30 * 60_000;
const MODEL_DEADLINE_MS = 15 * 60_000;

/**
 * Forging a rung: theme tally -> prompts -> world -> creatures.
 *
 * The Mint path is a scheduled state machine rather than one long-running
 * action. A world takes ~15 minutes to generate and a Convex action has a hard
 * duration limit, so an action that sat in a poll loop was killed every time —
 * Mint finished and billed the work while nothing was left holding the handle.
 * Each step here makes one API call and reschedules itself.
 *
 * The alternate providers (World Labs, Tripo) stay inline: they are only
 * reached when MINT_API_KEY is absent, and Tripo models finish inside a single
 * action's budget.
 *
 * Every external step is optional. A missing key or a failed call degrades to a
 * usable rung rather than bricking the ladder, because the tower has to stay
 * climbable during a live demo.
 */
export const generate = internalAction({
  args: { levelId: v.id("levels") },
  handler: async (ctx, { levelId }) => {
    try {
      const level = await ctx.runQuery(internal.levels.getLevel, { levelId });
      if (!level) return;

      // 1. Compose, then optionally reword (OpenAI, best-effort).
      //
      // A floor its architect wrote goes to the world model in their own words;
      // one nobody wrote is composed from what the room voted for. Either way
      // the waves, cards and creature archetypes come from the fixed table.
      const written = Boolean(level.prompt);
      const base = written
        ? composeFromPrompt(level.prompt as string, level.tally)
        : compose(level.tally);
      const spec = await enrich(base, level.tally, { keepWorldPrompt: written });
      // enrich() may rewrite worldPrompt wholesale, so the arena clause is
      // appended after it rather than composed in and hoped for.
      const worldPrompt = withArena(spec.worldPrompt);

      await ctx.runMutation(internal.levels.applyComposition, {
        levelId,
        theme: spec.theme,
        themeTag: spec.themeTag,
        worldPrompt,
        enemyPrompt: spec.enemyPrompt,
        monumentPrompt: spec.monumentPrompt,
        composition: spec.composition,
        cardSkins: spec.cardSkins,
      });

      // 2. The world. Mint hands off to the poller; anything else runs inline.
      if (mint.hasMintKey()) {
        const worldOp =
          level.providerWorldId ?? (await mint.startWorld(worldPrompt, "standard"));
        await ctx.runMutation(internal.levels.rememberProvider, {
          levelId,
          providerWorldId: worldOp,
        });
        await ctx.scheduler.runAfter(POLL_SECONDS * 1000, internal.forge.pollWorld, { levelId });
        return;
      }

      const world = await generateWorldFallback(worldPrompt);
      await ctx.runMutation(internal.levels.applyAssets, {
        levelId,
        splatUrl: world.splatUrl,
        colliderUrl: world.colliderUrl,
        status: "forging:creatures",
      });
      await ctx.scheduler.runAfter(0, internal.forge.startCreatures, { levelId });
    } catch (err) {
      await fail(ctx, levelId, err);
    }
  },
});

export const pollWorld = internalAction({
  args: { levelId: v.id("levels") },
  handler: async (ctx, { levelId }) => {
    try {
      const level = await ctx.runQuery(internal.levels.getLevel, { levelId });
      if (!level || !level.providerWorldId) return;
      if (level.status !== "forging:world") return; // superseded or already done

      const state = await mint.checkOperation(level.providerWorldId);
      if (state.failed) throw new Error(`world generation ${state.status}: ${state.error ?? ""}`);

      if (!state.done) {
        if (Date.now() - (level.forgeStartedAt ?? 0) > WORLD_DEADLINE_MS) {
          throw new Error(`world generation still ${state.status} after 30 minutes`);
        }
        await ctx.scheduler.runAfter(POLL_SECONDS * 1000, internal.forge.pollWorld, { levelId });
        return;
      }

      const world = mint.worldAssetsOf(state.raw);
      await ctx.runMutation(internal.levels.applyAssets, {
        levelId,
        splatUrl: world.splatUrl,
        colliderUrl: world.colliderUrl,
        status: "forging:creatures",
      });
      await ctx.scheduler.runAfter(0, internal.forge.startCreatures, { levelId });
    } catch (err) {
      await fail(ctx, levelId, err);
    }
  },
});

export const startCreatures = internalAction({
  args: { levelId: v.id("levels") },
  handler: async (ctx, { levelId }) => {
    const level = await ctx.runQuery(internal.levels.getLevel, { levelId });
    if (!level) return;

    // The creature carries extra constraints because it gets instanced and
    // normalized; the monument stands alone and is fine as composed.
    const enemyPrompt = (level.enemyPrompt ?? "") + CREATURE_SUFFIX;
    const monumentPrompt = level.monumentPrompt ?? "";

    if (mint.hasMintKey()) {
      const enemy = level.providerEnemyId ?? (await startModelSafely(enemyPrompt));
      const monument = level.providerMonumentId ?? (await startModelSafely(monumentPrompt));

      if (!enemy && !monument) {
        await ctx.runMutation(internal.levels.finishForge, { levelId });
        return;
      }

      await ctx.runMutation(internal.levels.rememberProvider, {
        levelId,
        providerEnemyId: enemy ?? undefined,
        providerMonumentId: monument ?? undefined,
      });
      await ctx.scheduler.runAfter(POLL_SECONDS * 1000, internal.forge.pollCreatures, { levelId });
      return;
    }

    const [enemyUrl, monumentUrl] = await Promise.all([
      generateModelFallback(enemyPrompt),
      generateModelFallback(monumentPrompt),
    ]);
    await ctx.runMutation(internal.levels.applyAssets, {
      levelId,
      enemyUrl: enemyUrl ?? undefined,
      monumentUrl: monumentUrl ?? undefined,
    });
    await ctx.runMutation(internal.levels.finishForge, { levelId });
  },
});

export const pollCreatures = internalAction({
  args: { levelId: v.id("levels") },
  handler: async (ctx, { levelId }) => {
    const level = await ctx.runQuery(internal.levels.getLevel, { levelId });
    if (!level || level.status !== "forging:creatures") return;

    const [enemy, monument] = await Promise.all([
      resolveModel(level.providerEnemyId),
      resolveModel(level.providerMonumentId),
    ]);

    const stillWaiting = enemy === "pending" || monument === "pending";
    const overdue = Date.now() - (level.forgeStartedAt ?? 0) > WORLD_DEADLINE_MS + MODEL_DEADLINE_MS;

    if (stillWaiting && !overdue) {
      await ctx.scheduler.runAfter(POLL_SECONDS * 1000, internal.forge.pollCreatures, { levelId });
      return;
    }

    await ctx.runMutation(internal.levels.applyAssets, {
      levelId,
      enemyUrl: urlOrUndefined(enemy),
      monumentUrl: urlOrUndefined(monument),
    });
    await ctx.runMutation(internal.levels.finishForge, { levelId });
  },
});

/**
 * Attach an already-generated Mint world to a rung.
 *
 * Recovers a forge whose action died after Mint had finished (and billed) the
 * generation — the assets exist, nobody was left holding the handle.
 */
export const adopt = internalAction({
  args: { levelId: v.id("levels"), worldId: v.string() },
  handler: async (ctx, { levelId, worldId }) => {
    try {
      const world = await mint.fetchWorld(worldId);
      await ctx.runMutation(internal.levels.applyAssets, {
        levelId,
        splatUrl: world.splatUrl,
        colliderUrl: world.colliderUrl,
        status: "forging:creatures",
      });
      await ctx.scheduler.runAfter(0, internal.forge.startCreatures, { levelId });
    } catch (err) {
      await fail(ctx, levelId, err);
    }
  },
});

// ---- Mint helpers ----------------------------------------------------------

async function startModelSafely(prompt: string): Promise<string | null> {
  if (!prompt.trim()) return null;
  try {
    return await mint.startModel(prompt, "fast");
  } catch (err) {
    console.warn("mint model start failed:", err);
    return null;
  }
}

/** "pending" while generating, a URL when ready, null when unavailable. */
async function resolveModel(operationId: string | undefined): Promise<string | "pending" | null> {
  if (!operationId) return null;
  try {
    const state = await mint.checkOperation(operationId);
    if (state.failed) return null;
    if (!state.done) return "pending";
    return mint.modelAssetsOf(state.raw)?.glbUrl ?? null;
  } catch (err) {
    console.warn("model check failed:", err);
    return null;
  }
}

function urlOrUndefined(value: string | "pending" | null): string | undefined {
  return typeof value === "string" && value !== "pending" ? value : undefined;
}

// ---- alternate providers (only when MINT_API_KEY is absent) ----------------

interface WorldAssets {
  splatUrl: string;
  colliderUrl?: string;
}

async function generateWorldFallback(prompt: string): Promise<WorldAssets> {
  const key = process.env.WORLDLABS_API_KEY;
  if (!key) {
    console.warn("no world provider key — reusing a seed world for this rung");
    return { splatUrl: FALLBACK_SPLAT };
  }

  const start = await fetchJson(`${MARBLE}/worlds:generate`, {
    method: "POST",
    headers: { "WLT-Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "marble-1.1",
      world_prompt: { type: "text", text_prompt: prompt },
    }),
  });

  const operationId = pickString(start, ["operation_id", "operationId", "name", "id"]);
  if (!operationId) throw new Error("marble: no operation id in generate response");

  const world = await poll(
    async () => fetchJson(`${MARBLE}/operations/${operationId}`, { headers: { "WLT-Api-Key": key } }),
    (op) => op.done === true,
    { timeoutMs: 8 * 60_000, intervalMs: 10_000, label: "marble" },
  );

  const worldId =
    pickString(world, ["world_id", "worldId"]) ??
    pickString((world.response ?? world.result ?? {}) as Json, ["world_id", "worldId", "id"]);

  const detail = worldId
    ? await fetchJson(`${MARBLE}/worlds/${worldId}`, { headers: { "WLT-Api-Key": key } })
    : world;

  // Field names differ across Marble revisions, so select by file extension.
  const urls = collectUrls(detail);
  const splatUrl = pickSplat(urls);
  if (!splatUrl) throw new Error("marble: no .spz asset in world response");

  return { splatUrl, colliderUrl: pickCollider(urls) };
}

async function generateModelFallback(prompt: string): Promise<string | null> {
  const key = process.env.TRIPO_API_KEY;
  if (!key || !prompt.trim()) {
    if (!key) console.warn("no model provider key — skipping model generation");
    return null;
  }

  try {
    const start = await fetchJson(`${TRIPO}/task`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "text_to_model",
        // Verified against the API: "v3.1" is rejected with code 2017, and
        // v2.0 / Turbo-v1.0 are deprecated. v3.0-20250812 is current.
        model_version: "v3.0-20250812",
        prompt: prompt.slice(0, 900),
        texture: true,
        pbr: true,
        // These get instanced a few hundred times; cap the triangle budget.
        face_limit: 20000,
      }),
    });

    const taskId =
      pickString((start.data ?? {}) as Json, ["task_id", "taskId"]) ??
      pickString(start, ["task_id", "taskId"]);
    if (!taskId) throw new Error("tripo: no task id");

    const done = await poll(
      async () =>
        fetchJson(`${TRIPO}/task/${taskId}`, { headers: { Authorization: `Bearer ${key}` } }),
      (t) => {
        const status = pickString((t.data ?? t) as Json, ["status"]);
        if (status === "failed" || status === "banned" || status === "cancelled") {
          throw new Error(`tripo: task ${status}`);
        }
        return status === "success";
      },
      { timeoutMs: 5 * 60_000, intervalMs: 3_000, label: "tripo" },
    );

    // Take the model field explicitly: collectUrls would happily return the
    // rendered preview image or a thumbnail that happens to sort first.
    const output = ((done.data ?? {}) as Json).output as Json | undefined;
    return (
      pickString(output ?? {}, ["pbr_model", "model", "base_model"]) ??
      collectUrls(done).find((u) => u.toLowerCase().includes(".glb")) ??
      null
    );
  } catch (err) {
    // A missing creature is survivable; the level falls back to stock enemies.
    console.warn("tripo generation failed:", err);
    return null;
  }
}

// ---- small helpers ---------------------------------------------------------

type Json = Record<string, unknown>;

// Structurally typing ctx as `(ref: unknown, args: unknown) => …` looks
// permissive but is the opposite: a real ActionCtx.runMutation demands a
// FunctionReference, and a function taking `unknown` cannot stand in for one.
// Naming the generated types is both stricter and what actually compiles.
async function fail(ctx: ActionCtx, levelId: Id<"levels">, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error("forge failed:", message);
  await ctx.runMutation(internal.levels.setStatus, {
    levelId,
    status: "failed",
    error: message.slice(0, 400),
  });
}

async function fetchJson(url: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error(`${url} -> non-JSON response ${text.slice(0, 120)}`);
  }
}

async function poll(
  fn: () => Promise<Json>,
  done: (value: Json) => boolean,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<Json> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: Json = {};
  while (Date.now() < deadline) {
    last = await fn();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`${opts.label}: timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
}

function pickString(obj: Json, keys: string[]): string | undefined {
  for (const k of keys) {
    const value = obj?.[k];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Walk an arbitrary JSON tree and collect every http(s) URL in it. */
function collectUrls(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://")) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, out);
  }
  return out;
}

function pickSplat(urls: string[]): string | undefined {
  const spz = urls.filter((u) => u.toLowerCase().includes(".spz"));
  if (spz.length === 0) return undefined;
  // Prefer the mid-resolution tier: fast to stream, still looks good.
  return (
    spz.find((u) => /500k|500_000|medium/i.test(u)) ??
    spz.find((u) => !/100k|full|high/i.test(u)) ??
    spz[0]
  );
}

function pickCollider(urls: string[]): string | undefined {
  const glb = urls.filter((u) => u.toLowerCase().includes(".glb"));
  return glb.find((u) => /collider|collision|proxy/i.test(u)) ?? glb[0];
}
