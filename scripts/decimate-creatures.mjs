#!/usr/bin/env node
/**
 * Reduce the triangle count of creature GLBs, in place.
 *
 *   node scripts/decimate-creatures.mjs public/creatures/*.glb [--target 3500]
 *
 * A swarm enemy is instanced up to 220 times, so SWARM_TRIANGLE_BUDGET caps a
 * creature at 4000 triangles before enemies.ts reserves the generated model for
 * tank and boss only. Mint returns ~19k, so the six need decimating to actually
 * reach the swarm.
 *
 * meshoptimizer's simplifier only emits a smaller index buffer over the EXISTING
 * vertices — it never invents new ones — so POSITION, NORMAL and TEXCOORD_0 stay
 * byte-identical and the textures keep mapping correctly. Only the indices are
 * rewritten. Unused vertices are left in place: they cost a little memory and
 * nothing in draw time, and compacting them would mean rebuilding every accessor.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { MeshoptSimplifier } from "meshoptimizer";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const TARGET = flag("target", 3500);
const ERROR = flag("error", 0.2);
const FLAGS = args.includes("--lock-border") ? ["LockBorder"] : [];
const files = args.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")),
);

if (files.length === 0) {
  console.error("usage: decimate-creatures.mjs <file.glb...> [--target 3500] [--error 0.2]");
  process.exit(2);
}

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const pad4 = (n) => (n + 3) & ~3;

const COMPONENT = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

await MeshoptSimplifier.ready;

for (const file of files) {
  const buf = readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) {
    console.error(`${file}: not a GLB, skipped`);
    continue;
  }

  // ---- split chunks ---------------------------------------------------------
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

  const view = (i) => {
    const v = json.bufferViews[i];
    return { offset: v.byteOffset ?? 0, length: v.byteLength };
  };
  const readAccessor = (index) => {
    const acc = json.accessors[index];
    const Ctor = COMPONENT[acc.componentType];
    const per = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
    const { offset } = view(acc.bufferView);
    const start = bin.byteOffset + offset + (acc.byteOffset ?? 0);
    return new Ctor(bin.buffer, start, acc.count * per);
  };

  let before = 0;
  let after = 0;
  const replacement = new Map(); // bufferView index -> new bytes

  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.indices === undefined) {
        console.error(`${file}: non-indexed primitive, skipped`);
        continue;
      }
      const indexAcc = json.accessors[prim.indices];
      const positions = new Float32Array(readAccessor(prim.attributes.POSITION));
      const indices = new Uint32Array(readAccessor(prim.indices));
      const vertexCount = json.accessors[prim.attributes.POSITION].count;

      before += indices.length / 3;
      const targetIndexCount = Math.min(indices.length, TARGET * 3);

      // Prune first: these creatures carry small floating shells (cloth scraps,
      // eye spheres) that the topology-preserving pass cannot collapse, and
      // which otherwise hold the whole mesh above the target.
      const pruned = MeshoptSimplifier.simplifyPrune(indices, positions, 3, 0.02);

      let [simplified, error] = MeshoptSimplifier.simplify(
        pruned,
        positions,
        3,
        targetIndexCount,
        ERROR,
        FLAGS,
      );

      // simplify() will not break topology, so a shell-heavy mesh can stall
      // above the target. That floor is respected rather than forced:
      // simplifySloppy() reaches any target but collapsed these creatures to
      // nothing, which is worse than carrying a few thousand extra triangles.
      after += simplified.length / 3;

      // Write the new indices back into the same bufferView slot.
      const Ctor = vertexCount > 65535 ? Uint32Array : Uint16Array;
      const out = new Ctor(simplified);
      replacement.set(indexAcc.bufferView, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
      indexAcc.count = simplified.length;
      indexAcc.componentType = Ctor === Uint32Array ? 5125 : 5123;
      indexAcc.byteOffset = 0;
      console.log(
        `  ${file}: ${indices.length / 3} -> ${simplified.length / 3} tris (error ${error.toFixed(4)})`,
      );
    }
  }

  // ---- rebuild the binary chunk --------------------------------------------
  const parts = [];
  let cursor = 0;
  for (const [index, v] of json.bufferViews.entries()) {
    const data = replacement.get(index) ?? bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    parts.push(data);
    v.byteOffset = cursor;
    v.byteLength = data.length;
    cursor = pad4(cursor + data.length);
    const padding = cursor - (v.byteOffset + data.length);
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  const newBin = Buffer.concat(parts);
  json.buffers = [{ byteLength: newBin.length }];

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

  writeFileSync(
    file,
    Buffer.concat([header, jsonHeader, jsonBytes, jsonPad, binHeader, newBin, binPad]),
  );
  const mb = (n) => (n / 1e6).toFixed(2);
  console.log(`${file}: ${before} -> ${after} tris, ${mb(buf.length)}MB -> ${mb(readFileSync(file).length)}MB`);
}
