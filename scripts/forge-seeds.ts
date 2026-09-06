// Regenerate the four seed worlds through Mint with the arena clause, so the
// first rungs anyone plays actually have the empty clearing the ring assumes.
//
//   npm run forge:seeds            # start (or resume) all four, wait, print URLs
//
// Results land in scripts/seed-worlds.json as they arrive. A seed that already
// has an operation id there is polled rather than started again, so a killed
// run never pays for a second generation. Mirrors convex/mint.ts deliberately:
// this is a one-off tool, and importing the Convex module would drag its
// runtime along.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { withArena } from "../convex/composer";

const BASE = "https://api.mint.gg/v1";
const PRESET = "standard"; // what the forge uses for a real rung
const TIMEOUT_MS = 25 * 60_000;
const POLL_MS = 6_000;
const OUT = resolve(import.meta.dirname, "seed-worlds.json");

interface Seed {
  file: string; // matches the basename in SEED_LEVELS and fetch-worlds.sh
  name: string;
  prompt: string;
}

// Each prompt describes the seed's existing theme as a place with a ring of
// set dressing around an open middle. The arena clause is appended verbatim.
const SEEDS: Seed[] = [
  {
    file: "haunted-house",
    name: "haunted house",
    prompt:
      "the grounds of a derelict haunted manor at night: a wide flat courtyard of cracked flagstones, " +
      "ringed by the manor's dark facade with lit windows, leaning iron fences, dead trees and " +
      "crumbling stone walls, moonlight and drifting mist",
  },
  {
    file: "cozy-ship",
    name: "cozy ship",
    prompt:
      "the broad open main deck of a warm, lantern-lit wooden sailing ship at dusk, flat planked " +
      "decking, ringed by the ship's railings, coiled rope, barrels, masts and the raised stern cabin, " +
      "calm sea beyond",
  },
  {
    file: "cozy-cottage",
    name: "cozy cottage",
    prompt:
      "a wide flat grassy clearing in front of a cozy stone cottage at golden hour, ringed by the " +
      "cottage, a low wooden fence, flower beds, a well and thick trees, soft warm light",
  },
  {
    file: "derelict-spaceship",
    name: "derelict spaceship",
    prompt:
      "the vast open landing bay of an abandoned spacecraft, flat scuffed metal decking, ringed by " +
      "bulkheads, exposed cabling, stacked cargo crates and flickering panel lights",
  },
];

interface Result {
  file: string;
  name: string;
  prompt: string;
  opId?: string;
  status?: string;
  splatUrl?: string;
  colliderUrl?: string;
  radUrl?: string;
  caption?: string;
  error?: string;
}

interface Operation {
  id: string;
  status: string;
  assets?: Record<string, unknown> | null;
  error?: { message?: string } | null;
}

function apiKey(): string {
  if (process.env.MINT_API_KEY) return process.env.MINT_API_KEY;
  const env = resolve(import.meta.dirname, "..", ".env");
  if (existsSync(env)) {
    const m = readFileSync(env, "utf8").match(/^MINT_API_KEY=(.+)$/m);
    if (m?.[1]) return m[1].trim();
  }
  throw new Error("MINT_API_KEY is not set (env or .env)");
}

const KEY = apiKey();

async function call(path: string, init: RequestInit = {}): Promise<Operation> {
  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`mint ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as Operation;
}

/** SPZ tiers are keyed by quality; take the middle one, as the forge does. */
function pickSpz(urls: Record<string, string> | null | undefined): string | undefined {
  if (!urls) return undefined;
  const entries = Object.entries(urls);
  if (entries.length === 0) return undefined;
  const byKey = (re: RegExp) => entries.find(([k]) => re.test(k))?.[1];
  return byKey(/500|med|standard/i) ?? byKey(/^(?!.*(100k|full|high)).*$/i) ?? entries[0][1];
}

function load(): Result[] {
  if (!existsSync(OUT)) return SEEDS.map((s) => ({ file: s.file, name: s.name, prompt: withArena(s.prompt) }));
  const prev = JSON.parse(readFileSync(OUT, "utf8")) as Result[];
  return SEEDS.map((s) => prev.find((r) => r.file === s.file) ?? { file: s.file, name: s.name, prompt: withArena(s.prompt) });
}

let results = load();
function save(): void {
  writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
}

function log(r: Result, msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${r.name.padEnd(20)} ${msg}`);
}

async function forge(r: Result): Promise<void> {
  if (r.splatUrl) {
    log(r, `already done: ${r.splatUrl}`);
    return;
  }
  if (!r.opId) {
    const op = await call("worlds:generate", {
      method: "POST",
      body: JSON.stringify({
        prompt: r.prompt.slice(0, 2000),
        name: `Babel seed: ${r.name}`,
        generationMode: "auto",
        generationPreset: PRESET,
      }),
    });
    r.opId = op.id;
    r.status = op.status;
    save();
    log(r, `started ${op.id}`);
  } else {
    log(r, `resuming ${r.opId}`);
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let resumed = false;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await new Promise((t) => setTimeout(t, POLL_MS));
    const op = await call(`operations/${r.opId}`);
    if (op.status !== lastStatus) {
      lastStatus = op.status;
      r.status = op.status;
      save();
      log(r, op.status);
    }
    switch (op.status) {
      case "succeeded":
      case "partially_succeeded": {
        const assets = (op.assets ?? {}) as {
          spzUrls?: Record<string, string> | null;
          colliderMeshUrl?: string | null;
          radUrl?: string | null;
          caption?: string | null;
        };
        const splatUrl = pickSpz(assets.spzUrls);
        if (!splatUrl) throw new Error("finished without an spz url");
        r.splatUrl = splatUrl;
        r.colliderUrl = assets.colliderMeshUrl ?? undefined;
        r.radUrl = assets.radUrl ?? undefined;
        r.caption = assets.caption ?? undefined;
        save();
        log(r, `DONE ${splatUrl}`);
        return;
      }
      case "failed":
      case "canceled":
        throw new Error(`${op.status} ${op.error?.message ?? ""}`.trim());
      case "billing_required":
        if (resumed) throw new Error("billing_required after resume");
        resumed = true;
        await call(`operations/${r.opId}:resume`, { method: "POST", body: "{}" });
        log(r, "resumed after billing_required");
        break;
      default:
        break; // queued | running | preview_ready
    }
  }
  throw new Error(`timed out after ${Math.round(TIMEOUT_MS / 60_000)} min (op ${r.opId} may still finish; rerun to resume)`);
}

const settled = await Promise.allSettled(
  results.map((r) =>
    forge(r).catch((err) => {
      r.error = err instanceof Error ? err.message : String(err);
      save();
      log(r, `FAILED ${r.error}`);
      throw err;
    }),
  ),
);

console.log("\n=== seed worlds ===");
for (const r of results) {
  console.log(`${r.name.padEnd(20)} ${r.splatUrl ?? `(${r.error ?? r.status ?? "pending"})`}`);
  if (r.colliderUrl) console.log(`${"".padEnd(20)} collider ${r.colliderUrl}`);
}
console.log(`\nwritten to ${OUT}`);
process.exit(settled.some((s) => s.status === "rejected") ? 1 : 0);
