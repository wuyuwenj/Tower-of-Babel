#!/usr/bin/env node
/**
 * Downscale the textures embedded in a GLB, in place.
 *
 *   node scripts/shrink-textures.mjs public/creatures/*.glb [--size 512] [--quality 82]
 *
 * Mint returns 4096x4096 maps. An enemy is instanced a few hundred times and
 * drawn a few dozen pixels tall, so three 4K maps cost ~268 MB of VRAM each to
 * render detail nobody can see. 512 is plenty at that size and cuts both the
 * download and the GPU upload by ~64x.
 *
 * Uses `sips` (macOS built-in) so this needs no dependency. Rewrites the whole
 * binary chunk because changing an image's length shifts every bufferView after
 * it — offsets are recomputed, not patched.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
// Drop both the flags and the values they consume, so the rest are filenames.
const files = args.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")),
);
const SIZE = flag("size", 512);
const QUALITY = flag("quality", 82);

if (files.length === 0) {
  console.error("usage: shrink-textures.mjs <file.glb...> [--size 512] [--quality 82]");
  process.exit(2);
}

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const pad4 = (n) => (n + 3) & ~3;

for (const file of files) {
  const buf = readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) {
    console.error(`${file}: not a GLB, skipped`);
    continue;
  }

  // ---- split the two chunks -------------------------------------------------
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString("utf8"));
    else if (type === BIN_CHUNK) bin = data;
    off += 8 + pad4(len);
  }
  if (!json || !bin) {
    console.error(`${file}: missing JSON or BIN chunk, skipped`);
    continue;
  }

  const images = json.images ?? [];
  if (images.length === 0) {
    console.log(`${file}: no embedded images, skipped`);
    continue;
  }

  // ---- resize each image ----------------------------------------------------
  const tmp = mkdtempSync(join(tmpdir(), "glb-shrink-"));
  const replacement = new Map(); // bufferView index -> new bytes
  let before = 0;
  let after = 0;
  try {
    for (const [i, image] of images.entries()) {
      if (image.bufferView === undefined) continue;
      const view = json.bufferViews[image.bufferView];
      const src = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      const ext = image.mimeType === "image/png" ? "png" : "jpg";
      const path = join(tmp, `${i}.${ext}`);
      writeFileSync(path, src);
      execFileSync("sips", [
        "-Z", String(SIZE),
        "-s", "format", "jpeg",
        "-s", "formatOptions", String(QUALITY),
        path,
        "--out", join(tmp, `${i}.out.jpg`),
      ], { stdio: "ignore" });
      const out = readFileSync(join(tmp, `${i}.out.jpg`));
      replacement.set(image.bufferView, out);
      image.mimeType = "image/jpeg";
      before += src.length;
      after += out.length;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // ---- rebuild the binary chunk, recomputing every offset -------------------
  const parts = [];
  let cursor = 0;
  for (const [index, view] of json.bufferViews.entries()) {
    const data =
      replacement.get(index) ??
      bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    parts.push(data);
    view.byteOffset = cursor;
    view.byteLength = data.length;
    cursor = pad4(cursor + data.length);
    const padding = cursor - (view.byteOffset + data.length);
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  const newBin = Buffer.concat(parts);
  json.buffers = [{ byteLength: newBin.length }];

  // ---- reassemble the container --------------------------------------------
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = Buffer.alloc(pad4(jsonBytes.length) - jsonBytes.length, 0x20);
  const binPad = Buffer.alloc(pad4(newBin.length) - newBin.length, 0);
  const jsonLen = jsonBytes.length + jsonPad.length;
  const binLen = newBin.length + binPad.length;

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonLen + 8 + binLen, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonLen, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binLen, 0);
  binHeader.writeUInt32LE(BIN_CHUNK, 4);

  const out = Buffer.concat([header, jsonHeader, jsonBytes, jsonPad, binHeader, newBin, binPad]);
  writeFileSync(file, out);

  const mb = (n) => (n / 1e6).toFixed(2);
  console.log(
    `${file}: ${mb(buf.length)}MB -> ${mb(out.length)}MB  ` +
      `(textures ${mb(before)}MB -> ${mb(after)}MB, ${images.length} maps @ ${SIZE}px)`,
  );
}
