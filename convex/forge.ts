"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { compose } from "./composer";
import { enrich } from "./enrich";
import * as mint from "./mint";

const MARBLE = "https://api.worldlabs.ai/marble/v1";
const TRIPO = "https://api.tripo3d.ai/v2/openapi";

const FALLBACK_SPLAT =
  "https://storage.googleapis.com/forge-dev-public/hackathon-260227/haunted-house.spz";

/**
 * Forges one level: theme tally -> prompts -> Marble world -> Tripo creatures.
 *
 * Every external step is optional. A missing key or a failed call degrades to
 * a usable level rather than bricking the rung, because the ladder must stay
 * climbable during a live demo.
 */
export const generate = internalAction({
  args: { levelId: v.id("levels") },
  handler: async (ctx, { levelId }) => {
    try {
      const level = await ctx.runQuery(internal.levels.getLevel, { levelId });
      if (!level) return;

      // 1. Compose (deterministic) and optionally reword (OpenAI, best-effort).
      const base = compose(level.tally);
      const spec = await enrich(base, level.tally);

      await ctx.runMutation(internal.levels.applyComposition, {
        levelId,
        theme: spec.theme,
        themeTag: spec.themeTag,
        worldPrompt: spec.worldPrompt,
        enemyPrompt: spec.enemyPrompt,
        monumentPrompt: spec.monumentPrompt,
        composition: spec.composition,
        cardSkins: spec.cardSkins,
      });

      // 2. Marble builds the world.
      const world = await generateWorld(spec.worldPrompt);
      await ctx.runMutation(internal.levels.applyAssets, {
        levelId,
        splatUrl: world.splatUrl,
        colliderUrl: world.colliderUrl,
        status: "forging:creatures",
      });

      // 3. Tripo builds what lives in it.
      const [enemyUrl, monumentUrl] = await Promise.all([
        generateModel(spec.enemyPrompt),
        generateModel(spec.monumentPrompt),
      ]);
      await ctx.runMutation(internal.levels.applyAssets, {
        levelId,
        enemyUrl: enemyUrl ?? undefined,
        monumentUrl: monumentUrl ?? undefined,
      });

      await ctx.runMutation(internal.levels.finishForge, { levelId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("forge failed:", message);
      await ctx.runMutation(internal.levels.setStatus, {
        levelId,
        status: "failed",
        error: message.slice(0, 400),
      });
    }
  },
});

// ---------------------------------------------------------------------------

interface WorldAssets {
  splatUrl: string;
  colliderUrl?: string;
}

async function generateWorld(prompt: string): Promise<WorldAssets> {
  // Mint is the primary provider: one key covers worlds and models, and its
  // worlds come back as SPZ + collider mesh, exactly what Spark and Rapier want.
  if (mint.hasMintKey()) {
    const world = await mint.generateWorld(prompt, "standard");
    return { splatUrl: world.splatUrl, colliderUrl: world.colliderUrl };
  }

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

  // ~5 minutes typical; give it 12 before declaring the rung failed.
  const world = await poll(
    async () => fetchJson(`${MARBLE}/operations/${operationId}`, { headers: { "WLT-Api-Key": key } }),
    (op) => op.done === true,
    { timeoutMs: 12 * 60_000, intervalMs: 10_000, label: "marble" },
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

async function generateModel(prompt: string): Promise<string | null> {
  if (mint.hasMintKey()) {
    const model = await mint.generateModel(prompt, "fast");
    return model?.glbUrl ?? null;
  }

  const key = process.env.TRIPO_API_KEY;
  if (!key) {
    console.warn("no model provider key — skipping model generation");
    return null;
  }

  try {
    const start = await fetchJson(`${TRIPO}/task`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "text_to_model",
        model_version: "v3.1",
        prompt: prompt.slice(0, 900),
        texture: true,
      }),
    });

    const taskId =
      pickString((start.data ?? {}) as Json, ["task_id", "taskId"]) ??
      pickString(start, ["task_id", "taskId"]);
    if (!taskId) throw new Error("tripo: no task id");

    const done = await poll(
      async () => fetchJson(`${TRIPO}/task/${taskId}`, { headers: { Authorization: `Bearer ${key}` } }),
      (t) => {
        const status = pickString((t.data ?? t) as Json, ["status"]);
        if (status === "failed" || status === "banned" || status === "cancelled") {
          throw new Error(`tripo: task ${status}`);
        }
        return status === "success";
      },
      { timeoutMs: 5 * 60_000, intervalMs: 3_000, label: "tripo" },
    );

    const urls = collectUrls(done);
    return urls.find((u) => u.toLowerCase().includes(".glb")) ?? null;
  } catch (err) {
    // A missing creature is survivable; the level falls back to stock enemies.
    console.warn("tripo generation failed:", err);
    return null;
  }
}

// ---- small helpers ---------------------------------------------------------

type Json = Record<string, unknown>;

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
