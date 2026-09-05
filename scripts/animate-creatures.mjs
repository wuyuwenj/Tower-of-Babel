#!/usr/bin/env node
/**
 * Rig the baked creatures and give each one a looping walk, with Tripo.
 *
 *   node scripts/animate-creatures.mjs [--only fire,ice] [--source baked|original] [--check] [--force]
 *
 *   --check    rig-check only (free): prints riggable + recommended rig type
 *   --source   baked (default): upload public/creatures/<tag>.glb, the decimated mesh we ship
 *              original: hand Tripo the full-resolution Mint URL from <tag>.json instead
 *   --rig-type override the rig type and rig even when rig-check says riggable=false
 *              (biped|quadruped|hexapod|octopod|serpentine|aquatic); the check is advisory
 *   --force    ignore the resume file and redo rig + retarget (spends credits)
 *
 * For each public/creatures/<tag>.glb:
 *   upload -> rig-check (free) -> rig (25 cr) -> retarget walk (20 cr) -> download
 *
 * The rigged, animated GLB replaces <tag>.glb only after it is verified to carry
 * a skin and an animation; the previous mesh stays in git. Every Tripo task id
 * is written to <tag>.rig.json as it is created, so a run that dies mid-way
 * resumes from the last paid step instead of paying for it again.
 *
 * The walk is retargeted in place (no root motion) because enemies.ts moves the
 * instance itself; the clip only has to move the legs. Reads keys from .env in
 * the repo root, like gen-creature.mjs.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = resolve(ROOT, "public/creatures");
const TRIPO = "https://openapi.tripo3d.ai/v3";
const RIG_MODEL = "v2.5-20260210"; // the only snapshot that rigs non-humanoids

/** Walk preset per rig type (v2.5). Unknown types are reported, not guessed. */
const WALK = {
  biped: "preset:walk",
  quadruped: "preset:quadruped:walk",
  hexapod: "preset:hexapod:walk",
  octopod: "preset:octopod:walk",
  serpentine: "preset:serpentine:march",
  aquatic: "preset:aquatic:march",
  avian: "preset:avian:walk",
};

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const CHECK_ONLY = flag("check");
const FORCE = flag("force");
const only = opt("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const SOURCE = opt("source") ?? "baked";
const RIG_TYPE = opt("rig-type");
if (RIG_TYPE && !(RIG_TYPE in WALK)) {
  console.error(`--rig-type must be one of ${Object.keys(WALK).join("|")}`);
  process.exit(2);
}
if (SOURCE !== "baked" && SOURCE !== "original") {
  console.error("--source must be baked or original");
  process.exit(2);
}
/** Tripo allows a handful of tasks in flight per key; the 6th returns 429. */
const CONCURRENCY = 3;

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

async function upload(file) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)], { type: "model/gltf-binary" }), file.split("/").pop());
  const data = await api("files", { method: "POST", body: form });
  if (!data.file_token) throw new Error("upload: no file_token in " + JSON.stringify(data));
  return data.file_token;
}

/** Poll a task to completion; returns data (status, output, credits_consumed). */
async function waitFor(tag, taskId, minutes = 10) {
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
    meshes: (json.meshes ?? []).length,
    skins: (json.skins ?? []).length,
    joints: (json.skins ?? []).reduce((s, k) => s + (k.joints?.length ?? 0), 0),
    animations: (json.animations ?? []).map((a) => a.name ?? "?"),
    images: (json.images ?? []).length,
  };
}

// ---- per creature ---------------------------------------------------------------
async function animate(tag) {
  const glb = resolve(DIR, `${tag}.glb`);
  const stateFile = resolve(DIR, `${tag}.rig.json`);
  // One resume record per source, so a baked attempt and an original attempt
  // never reuse each other's tokens or task ids.
  const all = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  const state = (!FORCE && all[SOURCE]) || {};
  all[SOURCE] = state;
  const save = () => writeFileSync(stateFile, JSON.stringify(all, null, 2) + "\n");

  // A file that already carries a walk is done; nothing to buy.
  const current = glbStats(readFileSync(glb));
  if (!FORCE && current.skins > 0 && current.animations.length > 0) {
    log(tag, `already rigged + animated (${current.animations.join(", ")}), skipping`);
    return { tag, ok: true, skipped: true, ...current };
  }

  if (!state.input) {
    if (SOURCE === "original") {
      const meta = JSON.parse(readFileSync(resolve(DIR, `${tag}.json`), "utf8"));
      if (!meta.url) throw new Error(`${tag}.json has no url`);
      state.input = meta.url;
    } else {
      state.input = await upload(glb);
    }
    save();
    log(tag, `input (${SOURCE}) -> ${state.input}`);
  }

  if (!state.rigCheck) {
    const t = await post("animations/rig-check", { input: state.input });
    const d = await waitFor(tag, t.task_id, 5);
    state.rigCheck = { taskId: t.task_id, ...d.output };
    save();
  }
  const { riggable, rig_type: checked } = state.rigCheck;
  log(tag, `rig-check: riggable=${riggable} rig_type=${checked}`);
  const rigType = RIG_TYPE ?? checked;
  if (!riggable && !RIG_TYPE) return { tag, ok: false, error: "not riggable", rigType };
  if (!riggable) log(tag, `rig-check said no; forcing rig_type=${rigType} anyway`);
  const preset = WALK[rigType];
  if (!preset) return { tag, ok: false, error: `no walk preset known for rig type ${rigType}` };
  // A forced type is a different job from the checked one: keep its own record.
  if (RIG_TYPE && state.rigType && state.rigType !== RIG_TYPE) {
    delete state.rigTaskId; delete state.riggedUrl; delete state.walkTaskId; delete state.walkUrl;
  }
  state.rigType = rigType;
  save();
  if (CHECK_ONLY) return { tag, ok: true, checkOnly: true, rigType, preset };

  if (!state.rigTaskId) {
    const t = await post("animations/rig", {
      input: state.input,
      model: RIG_MODEL,
      rig_type: rigType,
      spec: "tripo",
      out_format: "glb",
    });
    state.rigTaskId = t.task_id;
    save();
    log(tag, `rig task ${t.task_id}`);
  }
  if (!state.riggedUrl) {
    const d = await waitFor(tag, state.rigTaskId);
    state.riggedUrl = d.output?.model_url;
    state.rigCredits = d.credits_consumed;
    save();
    if (!state.riggedUrl) throw new Error("rig: no model_url in " + JSON.stringify(d.output));
  }

  if (!state.walkTaskId) {
    const t = await post("animations/retarget", {
      input: state.rigTaskId,
      animation: preset,
      out_format: "glb",
      bake_animation: true,
      animate_in_place: true,
    });
    state.walkTaskId = t.task_id;
    state.preset = preset;
    save();
    log(tag, `retarget task ${t.task_id} (${preset})`);
  }
  if (!state.walkUrl) {
    const d = await waitFor(tag, state.walkTaskId);
    state.walkUrl = d.output?.model_url;
    state.walkCredits = d.credits_consumed;
    save();
    if (!state.walkUrl) throw new Error("retarget: no model_url in " + JSON.stringify(d.output));
  }

  // Download beside the original, verify, then swap it in.
  const buf = Buffer.from(await (await fetch(state.walkUrl)).arrayBuffer());
  const stats = glbStats(buf);
  const tmp = resolve(DIR, `${tag}.walk.glb`);
  writeFileSync(tmp, buf);
  if (stats.error || stats.skins === 0 || stats.animations.length === 0) {
    return { tag, ok: false, error: `output lacks skin/animation, left at ${tmp}`, ...stats };
  }
  renameSync(tmp, glb);
  log(tag, `DONE -> ${glb} (${(buf.length / 1e6).toFixed(2)} MB, ${stats.triangles} tris, ${stats.joints} joints, ${stats.animations.join(", ")})`);
  return {
    tag, ok: true, rigType, preset,
    credits: (state.rigCredits ?? 0) + (state.walkCredits ?? 0),
    fileMB: +(buf.length / 1e6).toFixed(2),
    ...stats,
  };
}

// ---- main --------------------------------------------------------------------------
const t0 = Date.now();
function log(tag, msg) { console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${tag.padEnd(7)} ${msg}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const tags = readdirSync(DIR)
  .filter((f) => f.endsWith(".glb") && !f.endsWith(".walk.glb"))
  .map((f) => f.replace(/\.glb$/, ""))
  .filter((t) => !only || only.includes(t));
if (tags.length === 0) {
  console.error("no creatures matched");
  process.exit(2);
}

const queue = [...tags];
const results = [];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let tag = queue.shift(); tag; tag = queue.shift()) {
      results.push(await animate(tag).catch((err) => ({ tag, ok: false, error: err.message })));
    }
  }),
);
results.sort((a, b) => a.tag.localeCompare(b.tag));
console.log("\n=== RESULTS ===");
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
