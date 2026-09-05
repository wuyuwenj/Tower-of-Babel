// Generate a world on World Labs Marble from a panorama, wait for it, and pull
// the assets the game needs — including the metric scale and ground plane
// Marble reports, which the forge has been throwing away.
//
//   npx tsx scripts/forge-pano.ts --pano scripts/arena-pano.jpg --name "haunted house" \
//       --prompt "..." [--model marble-1.0-draft|marble-1.1|marble-1.1-plus] [--seed 1] [--out dir]
//
// The operation id is written to <out>/pano-world.json as soon as it exists;
// rerun with the same --out to resume polling instead of paying again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";

const BASE = "https://api.worldlabs.ai/marble/v1";
const args = process.argv.slice(2);
const opt = (k: string, d?: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};

const pano = opt("pano");
const name = opt("name", "Babel arena")!;
const prompt = opt("prompt", "")!;
const model = opt("model", "marble-1.1")!;
const seed = Number(opt("seed", "1"));
const outDir = resolve(opt("out", "scripts/pano-out")!);
if (!pano) throw new Error("--pano <file> is required");
mkdirSync(outDir, { recursive: true });
const record = resolve(outDir, "pano-world.json");

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

interface Record_ { operationId?: string; worldId?: string; model: string; seed: number; pano: string; prompt: string; world?: Json }
let rec: Record_ = existsSync(record)
  ? (JSON.parse(readFileSync(record, "utf8")) as Record_)
  : { model, seed, pano: basename(pano), prompt };
const save = () => writeFileSync(record, JSON.stringify(rec, null, 2) + "\n");

if (!rec.operationId) {
  const ext = pano.toLowerCase().endsWith(".png") ? "png" : "jpg";
  const data_base64 = readFileSync(pano).toString("base64");
  log(`starting ${model} from ${basename(pano)} (${(data_base64.length / 1024).toFixed(0)} KB b64), seed ${seed}`);
  const op = await call("worlds:generate", {
    method: "POST",
    body: JSON.stringify({
      display_name: name.slice(0, 64),
      model,
      seed,
      world_prompt: {
        type: "image",
        image_prompt: { source: "data_base64", data_base64, extension: ext },
        text_prompt: prompt || null,
        // Marble rewrites prompts by default, as enrich() does. Ours says
        // exactly what the arena needs; do not let a third rewrite soften it.
        disable_recaption: true,
        is_pano: "true",
      },
    }),
  });
  rec.operationId = op.operation_id;
  save();
  log(`operation ${rec.operationId}`);
} else {
  log(`resuming operation ${rec.operationId}`);
}

const deadline = Date.now() + 25 * 60_000;
let world: Json | undefined;
let lastProgress = "";
while (Date.now() < deadline) {
  const op = await call(`operations/${rec.operationId}`);
  const progress = JSON.stringify(op.metadata ?? {});
  if (progress !== lastProgress) { lastProgress = progress; log(`progress ${progress}`); }
  if (op.error) throw new Error(`generation failed: ${JSON.stringify(op.error)}`);
  if (op.done) {
    const worldId = op.metadata?.world_id ?? op.response?.world_id ?? op.response?.world?.world_id ?? op.response?.id;
    rec.worldId = worldId;
    if (op.cost) log(`cost ${JSON.stringify(op.cost)}`);
    world = worldId ? ((await call(`worlds/${worldId}`)).world ?? op.response) : op.response;
    break;
  }
  await new Promise((t) => setTimeout(t, 10_000));
}
if (!world) throw new Error("timed out; rerun to resume");
rec.world = world;
save();

const a = world.assets ?? {};
const spz = a.splats?.spz_urls ?? {};
const sem = a.splats?.semantics_metadata ?? {};
console.log("\n=== world ===");
console.log(`id            ${world.world_id}`);
console.log(`marble url    ${world.world_marble_url}`);
console.log(`caption       ${a.caption ?? "-"}`);
console.log(`spz           ${JSON.stringify(spz)}`);
console.log(`collider      ${a.mesh?.collider_mesh_url ?? "-"}`);
console.log(`pano          ${a.imagery?.pano_url ?? "-"}`);
console.log(`metric scale  ${sem.metric_scale_factor ?? "-"}   ground offset ${sem.ground_plane_offset ?? "-"}`);

// Pull what the pre-flight needs.
const dl = async (url: string | undefined, file: string) => {
  if (!url) return;
  const res = await fetch(url);
  if (!res.ok) { log(`download failed ${file}: ${res.status}`); return; }
  writeFileSync(resolve(outDir, file), Buffer.from(await res.arrayBuffer()));
  log(`saved ${file}`);
};
await dl(spz["500k"] ?? Object.values(spz)[0], "world.spz");
await dl(a.mesh?.collider_mesh_url, "world.glb");
await dl(a.thumbnail_url, "thumb.jpg");
console.log(`\nrecord: ${record}`);
