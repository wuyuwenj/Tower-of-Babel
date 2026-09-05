/**
 * Mint API client.
 *
 * Mint covers the whole forge with one key: `worlds:generate` returns SPZ
 * splats plus a collider mesh (exactly what Spark and Rapier need), and
 * `models:generate` returns a Y-up, +Z-forward GLB for creatures and monuments.
 */

const BASE = "https://api.mint.gg/v1";

export type Preset = "fast" | "standard" | "production";

export interface WorldResult {
  splatUrl: string;
  colliderUrl?: string;
  radUrl?: string;
  caption?: string;
}

export interface ModelResult {
  glbUrl: string;
  fbxUrl?: string;
  /** Height in metres, when Mint measured it — lets us skip renormalizing. */
  heightMeters?: number;
}

interface Operation {
  id: string;
  status: string;
  assets?: Record<string, unknown> | null;
  resource?: { type: string; id: string } | null;
  error?: { message?: string } | null;
  credits?: { estimated?: number; finalized?: number } | null;
}

export function hasMintKey(): boolean {
  return Boolean(process.env.MINT_API_KEY);
}

/**
 * Start a world generation and hand back its id immediately, so the caller can
 * persist it before the long wait. A forge interrupted by a restart can then
 * resume the generation already paid for.
 */
export async function startWorld(prompt: string, preset: Preset = "standard"): Promise<string> {
  const op = await start("worlds:generate", { prompt, preset, name: "Babel level" });
  return op.id;
}

export async function startModel(prompt: string, preset: Preset = "fast"): Promise<string> {
  const op = await start("models:generate", { prompt, preset, name: "Babel asset" });
  return op.id;
}

/** Read a finished world straight off the resource, bypassing its operation. */
export async function fetchWorld(worldId: string): Promise<WorldResult> {
  return readWorldAssets(await call(`worlds/${worldId}`));
}

export async function awaitWorld(operationId: string): Promise<WorldResult> {
  return readWorldAssets(await awaitOperation(operationId, 20 * 60_000, "mint world"));
}

function readWorldAssets(done: Operation): WorldResult {
  const assets = (done.assets ?? {}) as {
    spzUrls?: Record<string, string> | null;
    colliderMeshUrl?: string | null;
    radUrl?: string | null;
    caption?: string | null;
  };

  const splatUrl = pickSpz(assets.spzUrls);
  if (!splatUrl) throw new Error("mint world finished without an spz url");

  return {
    splatUrl,
    colliderUrl: assets.colliderMeshUrl ?? undefined,
    radUrl: assets.radUrl ?? undefined,
    caption: assets.caption ?? undefined,
  };
}

export async function generateWorld(prompt: string, preset: Preset = "standard") {
  return await awaitWorld(await startWorld(prompt, preset));
}

export async function awaitModel(operationId: string): Promise<ModelResult | null> {
  try {
    const done = await awaitOperation(operationId, 12 * 60_000, "mint model");
    const assets = (done.assets ?? {}) as {
      glbUrl?: string | null;
      optimizedGlbUrl?: string | null;
      fbxUrl?: string | null;
      bounds?: { min?: number[]; max?: number[] } | null;
    };

    // Prefer the optimized GLB: these are instanced a few hundred times.
    const glbUrl = assets.optimizedGlbUrl ?? assets.glbUrl;
    if (!glbUrl) return null;

    const min = assets.bounds?.min;
    const max = assets.bounds?.max;
    const heightMeters =
      Array.isArray(min) && Array.isArray(max) && min.length > 1 && max.length > 1
        ? max[1] - min[1]
        : undefined;

    return { glbUrl, fbxUrl: assets.fbxUrl ?? undefined, heightMeters };
  } catch (err) {
    // A missing creature is survivable; the level falls back to stock shapes.
    console.warn("mint model generation failed:", err);
    return null;
  }
}

export async function generateModel(prompt: string, preset: Preset = "fast") {
  try {
    return await awaitModel(await startModel(prompt, preset));
  } catch (err) {
    console.warn("mint model start failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------

async function start(
  path: string,
  { prompt, preset, name }: { prompt: string; preset: Preset; name: string },
): Promise<Operation> {
  return await call(path, {
    method: "POST",
    body: JSON.stringify({
      prompt: prompt.slice(0, 2000),
      name,
      generationMode: "auto",
      generationPreset: preset,
    }),
  });
}

async function awaitOperation(id: string, timeoutMs: number, label: string): Promise<Operation> {
  const deadline = Date.now() + timeoutMs;
  let resumed = false;

  while (Date.now() < deadline) {
    await sleep(6_000);
    const op = await call(`operations/${id}`);

    switch (op.status) {
      case "succeeded":
      case "partially_succeeded":
        return op;
      case "failed":
      case "canceled":
        throw new Error(`${label}: ${op.status} ${op.error?.message ?? ""}`.trim());
      case "billing_required":
        // generationMode "auto" still pauses if a charge needs confirming.
        if (resumed) throw new Error(`${label}: billing_required after resume`);
        resumed = true;
        await call(`operations/${id}:resume`, { method: "POST", body: "{}" });
        break;
      default:
        break; // queued | running | preview_ready
    }
  }
  throw new Error(`${label}: timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function call(path: string, init: RequestInit = {}): Promise<Operation> {
  const key = process.env.MINT_API_KEY;
  if (!key) throw new Error("MINT_API_KEY is not set");

  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`mint ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as Operation;
}

/** SPZ tiers are keyed by quality; take the middle one for fast streaming. */
function pickSpz(urls: Record<string, string> | null | undefined): string | undefined {
  if (!urls) return undefined;
  const entries = Object.entries(urls);
  if (entries.length === 0) return undefined;

  const byKey = (re: RegExp) => entries.find(([k]) => re.test(k))?.[1];
  return byKey(/500|med|standard/i) ?? byKey(/^(?!.*(100k|full|high)).*$/i) ?? entries[0][1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
