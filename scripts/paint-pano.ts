// Paint a photoreal RGB panorama onto a depth panorama with Marble's
// pano:depth_to_rgb — the layout is ours, the art is theirs. Step 2 of
// WORLD-GENERATION.md; ~80 credits.
//
//   npx tsx scripts/paint-pano.ts --depth scripts/arena-depth.png --prompt "..." \
//       [--z-min 0.01] [--z-max 80] [--seed 1] [--out scripts/pano-out/painted.png]
//
// The depth PNG is 16-bit, normalized to [0, 1] over [z_min, z_max] metres —
// the convention arena-pano.mjs --depth writes. z_min must be > 0 for the API.
// The operation id is written next to the output as <out>.json as soon as it
// exists; rerun with the same --out to resume polling instead of paying again.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";

const BASE = "https://api.worldlabs.ai/marble/v1";
const args = process.argv.slice(2);
const opt = (k: string, d?: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};

const depth = opt("depth");
const prompt = opt("prompt", "")!;
const zMin = Number(opt("z-min", "0.01"));
const zMax = Number(opt("z-max", "80"));
const seed = Number(opt("seed", "1"));
const out = resolve(opt("out", "scripts/pano-out/painted.png")!);
if (!depth) throw new Error("--depth <file> is required");
if (!prompt) throw new Error("--prompt is required");
const record = `${out}.json`;

function apiKey(): string {
  if (process.env.WORLDLABS_API_KEY) return process.env.WORLDLABS_API_KEY;
  const env = resolve(import.meta.dirname, "..", ".env");
  if (existsSync(env)) {
    const m = readFileSync(env, "utf8").match(/^WORLDLABS_API_KEY=(.+)$/m);
    if (m?.[1]) return m[1].trim().replace(/^"|"$/g, "");
  }
  throw new Error("WORLDLABS_API_KEY is not set (env or .env)");
}
const KEY = apiKey();

type Json = Record<string, any>;
async function call(path: string, init: RequestInit = {}): Promise<Json> {
  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: { "WLT-Api-Key": KEY, "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as Json;
}
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

interface Record_ { operationId?: string; depth: string; prompt: string; zMin: number; zMax: number; seed: number; panoUrl?: string }
let rec: Record_ = existsSync(record)
  ? (JSON.parse(readFileSync(record, "utf8")) as Record_)
  : { depth: basename(depth), prompt, zMin, zMax, seed };
const save = () => writeFileSync(record, JSON.stringify(rec, null, 2) + "\n");

if (!rec.operationId) {
  const data_base64 = readFileSync(depth).toString("base64");
  log(`painting ${basename(depth)} (${(data_base64.length / 1024).toFixed(0)} KB b64), z ${zMin}..${zMax} m, seed ${seed}`);
  const op = await call("pano:depth_to_rgb", {
    method: "POST",
    body: JSON.stringify({
      depth_pano_image: { source: "data_base64", data_base64, extension: "png" },
      text_prompt: prompt,
      z_min: zMin,
      z_max: zMax,
      seed,
    }),
  });
  rec.operationId = op.operation_id;
  save();
  log(`operation ${rec.operationId}`);
} else {
  log(`resuming operation ${rec.operationId}`);
}

const deadline = Date.now() + 15 * 60_000;
let panoUrl: string | undefined;
let lastProgress = "";
const visibleBy = Date.now() + 60_000;
while (Date.now() < deadline) {
  // A freshly created operation can 404 for a moment before it is readable.
  let op: Json;
  try {
    op = await call(`operations/${rec.operationId}`);
  } catch (err) {
    if (Date.now() < visibleBy && String(err).includes("404")) {
      await new Promise((t) => setTimeout(t, 3_000));
      continue;
    }
    throw err;
  }
  const progress = JSON.stringify(op.metadata ?? {});
  if (progress !== lastProgress) { lastProgress = progress; log(`progress ${progress}`); }
  if (op.error) throw new Error(`painting failed: ${JSON.stringify(op.error)}`);
  if (op.done) {
    if (op.cost) log(`cost ${JSON.stringify(op.cost)}`);
    // The pano operation reuses the world response shape.
    panoUrl = op.response?.assets?.imagery?.pano_url ?? op.response?.pano_url;
    break;
  }
  await new Promise((t) => setTimeout(t, 5_000));
}
if (!panoUrl) throw new Error("timed out or no pano_url; rerun to resume");
rec.panoUrl = panoUrl;
save();

const res = await fetch(panoUrl);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
log(`saved ${out}`);
console.log(`\npano url: ${panoUrl}\nrecord:   ${record}`);
