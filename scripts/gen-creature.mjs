#!/usr/bin/env node
/**
 * Generate a creature GLB from a text prompt with Mint and/or Tripo, download
 * it into public/creatures/, and print what came back (tris, textures, size).
 *
 *   node scripts/gen-creature.mjs --name void --prompt "..." [--provider mint|tripo|both]
 *                                 [--face-limit 20000] [--preset fast|standard|production]
 *
 * Mirrors convex/mint.ts and convex/forge.ts so a model produced here looks the
 * same as one the forge would produce. Reads keys from .env in the repo root.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "public/creatures");
const MINT = "https://api.mint.gg/v1";
const TRIPO = "https://api.tripo3d.ai/v2/openapi";

// ---- args -------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);
const name = args.name;
const prompt = args.prompt;
const provider = args.provider ?? "both";
const faceLimit = Number(args["face-limit"] ?? 20000);
const preset = args.preset ?? "fast";
if (!name || !prompt) {
  console.error("usage: --name <slug> --prompt <text> [--provider mint|tripo|both] [--face-limit N] [--preset P]");
  process.exit(2);
}

// ---- env --------------------------------------------------------------------
for (const file of [".env", ".env.local"]) {
  const p = resolve(ROOT, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ---- providers ------------------------------------------------------------------
async function mint() {
  const key = process.env.MINT_API_KEY;
  if (!key) throw new Error("MINT_API_KEY not set");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const call = async (path, init = {}) => {
    const res = await fetch(`${MINT}/${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`mint ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  const op = await call("models:generate", {
    method: "POST",
    body: JSON.stringify({ prompt, name: `Babel creature ${name}`, generationMode: "auto", generationPreset: preset }),
  });
  log("mint", `operation ${op.id} ${op.status}`);
  let resumed = false;
  const deadline = Date.now() + 8 * 60_000;
  let last = op;
  while (Date.now() < deadline) {
    await sleep(6000);
    last = await call(`operations/${op.id}`);
    if (last.status !== (mint.prev ?? "")) log("mint", `status ${last.status}`);
    mint.prev = last.status;
    if (last.status === "succeeded" || last.status === "partially_succeeded") break;
    if (last.status === "failed" || last.status === "canceled") throw new Error(`mint ${last.status}: ${last.error?.message ?? ""}`);
    if (last.status === "billing_required") {
      if (resumed) throw new Error("mint billing_required after resume");
      resumed = true;
      await call(`operations/${op.id}:resume`, { method: "POST", body: "{}" });
    }
  }
  const a = last.assets ?? {};
  log("mint", `assets: ${Object.keys(a).join(", ")}`);
  const url = a.optimizedGlbUrl ?? a.glbUrl;
  if (!url) throw new Error("mint: no glb url; assets=" + JSON.stringify(a).slice(0, 400));
  return { url, raw: a, alt: a.glbUrl && a.optimizedGlbUrl ? { label: "unoptimized", url: a.glbUrl } : null };
}

async function tripo() {
  const key = process.env.TRIPO_API_KEY;
  if (!key) throw new Error("TRIPO_API_KEY not set");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const call = async (path, init = {}) => {
    const res = await fetch(`${TRIPO}/${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`tripo ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  const body = { type: "text_to_model", model_version: "v3.1", prompt: prompt.slice(0, 900), texture: true, pbr: true };
  if (faceLimit > 0) body.face_limit = faceLimit;
  const start = await call("task", { method: "POST", body: JSON.stringify(body) });
  const id = start.data?.task_id;
  if (!id) throw new Error("tripo: no task id: " + JSON.stringify(start).slice(0, 300));
  log("tripo", `task ${id}`);
  const deadline = Date.now() + 6 * 60_000;
  let d;
  while (Date.now() < deadline) {
    await sleep(4000);
    d = (await call(`task/${id}`)).data;
    const s = `${d.status} ${d.progress ?? ""}`.trim();
    if (s !== tripo.prev) log("tripo", s);
    tripo.prev = s;
    if (d.status === "success") break;
    if (["failed", "banned", "cancelled", "expired", "unknown"].includes(d.status)) throw new Error(`tripo task ${d.status}`);
  }
  const o = d?.output ?? {};
  log("tripo", `output: ${Object.keys(o).join(", ")}`);
  const url = o.pbr_model ?? o.model ?? o.base_model;
  if (!url) throw new Error("tripo: no model url");
  return { url, raw: o, alt: null };
}

// ---- glb stats ----------------------------------------------------------------
function glbStats(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return { error: "not a GLB (magic mismatch)" };
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(Buffer.from(buf.buffer, buf.byteOffset + 20, jsonLen).toString("utf8"));
  const acc = json.accessors ?? [];
  const bv = json.bufferViews ?? [];
  let tris = 0, verts = 0, prims = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of json.meshes ?? []) {
    for (const p of m.primitives ?? []) {
      prims++;
      const pos = acc[p.attributes?.POSITION];
      if (pos) {
        verts += pos.count;
        if (pos.min && pos.max) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], pos.min[i]); max[i] = Math.max(max[i], pos.max[i]); }
      }
      const n = p.indices !== undefined ? acc[p.indices].count : pos?.count ?? 0;
      tris += (p.mode === undefined || p.mode === 4) ? n / 3 : 0;
    }
  }
  const images = (json.images ?? []).map((im) => ({ mime: im.mimeType, bytes: im.bufferView !== undefined ? bv[im.bufferView].byteLength : 0 }));
  const size = [0, 1, 2].map((i) => +(max[i] - min[i]).toFixed(3));
  return {
    generator: json.asset?.generator,
    meshes: (json.meshes ?? []).length, primitives: prims, materials: (json.materials ?? []).length,
    triangles: Math.round(tris), vertices: verts,
    textures: images.length, textureBytes: images.reduce((s, i) => s + i.bytes, 0), textureMimes: [...new Set(images.map((i) => i.mime))],
    size_xyz: size, height: size[1], minY: +min[1].toFixed(3),
    animations: (json.animations ?? []).length, skins: (json.skins ?? []).length,
  };
}

// ---- main --------------------------------------------------------------------------
const t0 = Date.now();
function log(tag, msg) { console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${tag.padEnd(5)} ${msg}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run(tag, fn) {
  const start = Date.now();
  try {
    const { url, raw, alt } = await fn();
    const genSec = (Date.now() - start) / 1000;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    mkdirSync(OUT, { recursive: true });
    const file = resolve(OUT, `${name}.${tag}.glb`);
    writeFileSync(file, buf);
    writeFileSync(resolve(OUT, `${name}.${tag}.json`), JSON.stringify({ prompt, url, raw }, null, 2));
    const stats = glbStats(buf);
    if (alt) {
      const altBuf = Buffer.from(await (await fetch(alt.url)).arrayBuffer());
      stats.alt = { label: alt.label, fileMB: +(altBuf.length / 1e6).toFixed(2), ...glbStats(altBuf) };
    }
    log(tag, `DONE in ${genSec.toFixed(0)}s -> ${file}`);
    return { tag, ok: true, genSec, fileMB: +(buf.length / 1e6).toFixed(2), ...stats };
  } catch (err) {
    log(tag, `FAILED: ${err.message}`);
    return { tag, ok: false, error: err.message };
  }
}

const jobs = [];
if (provider === "mint" || provider === "both") jobs.push(run("mint", mint));
if (provider === "tripo" || provider === "both") jobs.push(run("tripo", tripo));
const results = await Promise.all(jobs);
console.log("\n=== RESULTS ===");
console.log(JSON.stringify(results, null, 2));
