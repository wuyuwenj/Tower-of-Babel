#!/usr/bin/env node
/**
 * Generate the player character with Tripo and animate it: idle, run, jump.
 *
 *   node scripts/gen-player.mjs [--name wanderer] [--prompt "..."] [--force]
 *
 * text-to-model -> rig (biped) -> retarget idle / run / jump, each in place.
 * Outputs land in public/player/ under --name (default: wanderer):
 *   <name>.glb        the character, carrying the idle clip
 *   <name>.run.glb    same rig, run clip
 *   <name>.jump.glb   same rig, jump clip
 *
 * Three files rather than one because a single multi-animation retarget's
 * output shape is undocumented; one clip per task is a known quantity, and the
 * runtime binds clips to the character by bone name anyway (player.ts).
 *
 * Every task id is written to public/player/<name>.rig.json as it is
 * created, so a run that dies mid-way resumes from the last paid step. Reads
 * TRIPO_API_KEY from .env in the repo root, like the other scripts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = resolve(ROOT, "public/player");
const TRIPO = "https://openapi.tripo3d.ai/v3";
const GEN_MODEL = "v3.1-20260211";
const RIG_MODEL = "v2.5-20260210";

/**
 * A plain human. Nothing on the back, nothing on the head, nothing in the
 * hands: from a chase camera 13 units up, accessories read as lumps. The
 * A-pose and the clear-limbs language are for the rigger, not the art.
 */
const PROMPT =
  "a young human adventurer, stylized game character with realistic proportions, standing upright in a " +
  "relaxed A-pose with arms slightly away from the body and legs apart, plain fitted linen shirt with " +
  "rolled sleeves, dark trousers, leather boots, short dark hair, bare head, no accessories, " +
  "full body, facing forward, clean silhouette, game asset, no base, no background";
const NEGATIVE =
  "hood, hat, helmet, cape, robe, backpack, weapon, sitting, crouching, extra limbs, pedestal, base, text, blurry";

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const FORCE = flag("force");
const NAME = opt("name") ?? "wanderer";
const prompt = opt("prompt") ?? PROMPT;

const CLIPS = [
  { tag: "idle", preset: "preset:idle", file: `${NAME}.glb` },
  { tag: "run", preset: "preset:run", file: `${NAME}.run.glb` },
  { tag: "jump", preset: "preset:jump", file: `${NAME}.jump.glb` },
];

// ---- env --------------------------------------------------------------------
for (const file of [".env", ".env.local"]) {
  const p = resolve(ROOT, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const KEY = process.env.TRIPO_API_KEY;
if (!KEY) {
  console.error("TRIPO_API_KEY not set (looked in .env / .env.local at the repo root)");
  process.exit(2);
}

// ---- tripo ------------------------------------------------------------------
async function api(path, init = {}) {
  const res = await fetch(`${TRIPO}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, ...init.headers },
  });
  const text = await res.text();
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after")) || 15;
    await sleep(wait * 1000);
    return api(path, init);
  }
  if (!res.ok) throw new Error(`tripo ${path} -> ${res.status} ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (json.code !== 0) throw new Error(`tripo ${path} -> code ${json.code} ${text.slice(0, 300)}`);
  return json.data;
}

const post = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function waitFor(tag, taskId, minutes = 12) {
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(4000);
    const d = await api(`tasks/${taskId}`);
    const s = `${d.status} ${d.progress ?? ""}`.trim();
    if (s !== last) log(tag, `${taskId} ${s}`);
    last = s;
    if (d.status === "success") return d;
    if (["failed", "banned", "cancelled", "expired", "unknown"].includes(d.status)) {
      throw new Error(`task ${taskId} ${d.status}${d.error ? ": " + JSON.stringify(d.error).slice(0, 200) : ""}`);
    }
  }
  throw new Error(`task ${taskId} timed out after ${minutes} min`);
}

// ---- glb check --------------------------------------------------------------
function glbStats(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return { error: "not a GLB" };
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(Buffer.from(buf.buffer, buf.byteOffset + 20, jsonLen).toString("utf8"));
  const acc = json.accessors ?? [];
  let tris = 0;
  for (const m of json.meshes ?? []) {
    for (const p of m.primitives ?? []) {
      const n = p.indices !== undefined ? acc[p.indices].count : acc[p.attributes?.POSITION]?.count ?? 0;
      tris += (p.mode === undefined || p.mode === 4) ? n / 3 : 0;
    }
  }
  return {
    triangles: Math.round(tris),
    skins: (json.skins ?? []).length,
    joints: (json.skins ?? []).reduce((s, k) => s + (k.joints?.length ?? 0), 0),
    animations: (json.animations ?? []).map((a) => a.name ?? "?"),
    images: (json.images ?? []).length,
  };
}

// ---- main -------------------------------------------------------------------
const t0 = Date.now();
function log(tag, msg) { console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${tag.padEnd(6)} ${msg}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

mkdirSync(DIR, { recursive: true });
const stateFile = resolve(DIR, `${NAME}.rig.json`);
const state = !FORCE && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");

// 1. Generate.
if (!state.genTaskId) {
  const t = await post("generation/text-to-model", {
    prompt,
    negative_prompt: NEGATIVE,
    model: GEN_MODEL,
    texture: true,
    pbr: true,
    face_limit: 15000,
  });
  state.prompt = prompt;
  state.genTaskId = t.task_id;
  save();
  log("gen", `task ${t.task_id}`);
}
if (!state.modelUrl) {
  const d = await waitFor("gen", state.genTaskId);
  const o = d.output ?? {};
  state.modelUrl = o.pbr_model_url ?? o.model_url ?? o.base_model_url;
  state.previewUrl = o.rendered_image_url;
  state.genCredits = d.credits_consumed;
  save();
  if (!state.modelUrl) throw new Error("gen: no model url in " + JSON.stringify(o));
  log("gen", `model ${state.modelUrl}`);
  if (state.previewUrl) log("gen", `preview ${state.previewUrl}`);
}

// 2. Rig. The generated task id is the input; no upload needed.
if (!state.rigTaskId) {
  const t = await post("animations/rig", {
    input: state.genTaskId,
    model: RIG_MODEL,
    rig_type: "biped",
    spec: "tripo",
    out_format: "glb",
  });
  state.rigTaskId = t.task_id;
  save();
  log("rig", `task ${t.task_id}`);
}
if (!state.riggedUrl) {
  const d = await waitFor("rig", state.rigTaskId);
  state.riggedUrl = d.output?.model_url;
  state.rigCredits = d.credits_consumed;
  save();
  if (!state.riggedUrl) throw new Error("rig: no model_url in " + JSON.stringify(d.output));
}

// 3. One retarget per clip, in place, then download and verify each.
state.clips ??= {};
const results = [];
for (const clip of CLIPS) {
  const c = (state.clips[clip.tag] ??= {});
  const out = resolve(DIR, clip.file);
  if (!FORCE && c.url && existsSync(out)) {
    const stats = glbStats(readFileSync(out));
    if (stats.animations.length > 0) {
      log(clip.tag, `already have ${clip.file} (${stats.animations.join(", ")})`);
      results.push({ tag: clip.tag, ok: true, skipped: true, file: clip.file, ...stats });
      continue;
    }
  }
  if (!c.taskId) {
    const t = await post("animations/retarget", {
      input: state.rigTaskId,
      animation: clip.preset,
      out_format: "glb",
      bake_animation: true,
      animate_in_place: true,
    });
    c.taskId = t.task_id;
    save();
    log(clip.tag, `retarget task ${t.task_id} (${clip.preset})`);
  }
  if (!c.url) {
    const d = await waitFor(clip.tag, c.taskId);
    c.url = d.output?.model_url;
    c.credits = d.credits_consumed;
    save();
    if (!c.url) throw new Error(`${clip.tag}: no model_url in ` + JSON.stringify(d.output));
  }
  const buf = Buffer.from(await (await fetch(c.url)).arrayBuffer());
  const stats = glbStats(buf);
  if (stats.error || stats.skins === 0 || stats.animations.length === 0) {
    results.push({ tag: clip.tag, ok: false, error: "output lacks skin/animation", ...stats });
    continue;
  }
  writeFileSync(out, buf);
  log(clip.tag, `DONE -> ${out} (${(buf.length / 1e6).toFixed(2)} MB, ${stats.triangles} tris, ${stats.joints} joints, ${stats.animations.join(", ")})`);
  results.push({ tag: clip.tag, ok: true, file: clip.file, fileMB: +(buf.length / 1e6).toFixed(2), ...stats });
}

const credits =
  (state.genCredits ?? 0) + (state.rigCredits ?? 0) +
  Object.values(state.clips).reduce((s, c) => s + (c.credits ?? 0), 0);
console.log("\n=== RESULTS ===");
console.log(JSON.stringify({ preview: state.previewUrl, credits, clips: results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
