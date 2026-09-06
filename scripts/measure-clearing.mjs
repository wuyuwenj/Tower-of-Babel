// Measure the clearing around the origin in a collider GLB, in the game's
// frame: the pre-flight gate from WORLD-GENERATION.md step 5. Prints bounds,
// the floor height under the origin, and the horizontal distance from the
// origin to the nearest body-height geometry — the "clear radius" — overall
// and per 45° sector. Plain trimesh GLBs only (Marble colliders are); no
// dependencies.
//
//   node scripts/measure-clearing.mjs scripts/pano-out/world.glb [--eye 1.6] [--no-flip]
//
// The metre estimate assumes the world was generated from a panorama whose
// camera stood at --eye metres above the floor: with the camera at the
// origin, the floor's depth below it calibrates raw units to metres. Marble's
// metric_scale_factor replaces that guess when a model returns it.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args[0];
if (!file) throw new Error("usage: measure-clearing.mjs <collider.glb> [--eye 1.6] [--no-flip]");
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const EYE = Number(opt("eye", 1.6));
const FLIP = !args.includes("--no-flip"); // world.ts applies rotation.x = π to the collider

// ---------------------------------------------------------------------------
// GLB → world-space vertices.
const buf = readFileSync(file);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
let off = 12, json, bin;
while (off < buf.length) {
  const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
  const chunk = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
  else if (type === 0x004e4942) bin = chunk;
  off += 8 + len;
}
const TYPED = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const accessor = (i) => {
  const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
  const T = TYPED[a.componentType], n = WIDTH[a.type];
  const start = bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = bv.byteStride;
  if (!stride || stride === n * T.BYTES_PER_ELEMENT) return new T(bin.buffer, start, a.count * n);
  const out = new T(a.count * n);
  for (let k = 0; k < a.count; k++)
    for (let c = 0; c < n; c++) out[k * n + c] = new T(bin.buffer, start + k * stride + c * T.BYTES_PER_ELEMENT, 1)[0];
  return out;
};
// Column-major 4x4, as glTF stores them.
const mul = (A, B) => {
  const M = Array.from({ length: 16 }, () => 0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) M[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
  return M;
};
const local = (n) => {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
};
const pts = [];
let tris = 0;
const visit = (ni, parent) => {
  const n = json.nodes[ni], M = mul(parent, local(n));
  if (n.mesh !== undefined) {
    for (const p of json.meshes[n.mesh].primitives) {
      const P = accessor(p.attributes.POSITION);
      tris += p.indices !== undefined ? accessor(p.indices).length / 3 : P.length / 9;
      for (let k = 0; k < P.length; k += 3) {
        const x = P[k], y = P[k + 1], z = P[k + 2];
        pts.push([
          M[0] * x + M[4] * y + M[8] * z + M[12],
          M[1] * x + M[5] * y + M[9] * z + M[13],
          M[2] * x + M[6] * y + M[10] * z + M[14],
        ]);
      }
    }
  }
  for (const c of n.children ?? []) visit(c, M);
};
const scene = json.scenes?.[json.scene ?? 0];
for (const n of scene?.nodes ?? json.nodes.map((_, i) => i)) visit(n, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
if (FLIP) for (const p of pts) { p[1] = -p[1]; p[2] = -p[2]; }

// ---------------------------------------------------------------------------
// Measure.
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
const f2 = (v) => v.toFixed(2);
console.log(`vertices ${pts.length}  triangles ${tris}  frame ${FLIP ? "game (flipped)" : "raw"}`);
console.log(`bounds x [${f2(lo[0])}, ${f2(hi[0])}]  y [${f2(lo[1])}, ${f2(hi[1])}]  z [${f2(lo[2])}, ${f2(hi[2])}]`);

const under = pts.filter((p) => Math.hypot(p[0], p[2]) < 1);
if (under.length === 0) throw new Error("no geometry within 1 m of the origin: no floor to stand on");
const floor = Math.min(...under.map((p) => p[1]));
const U = -floor / EYE; // raw units per metre
console.log(`floor under origin y ${f2(floor)} (${under.length} vertices within 1 m)`);
console.log(`scale: camera at origin, eye ${EYE} m → 1 raw unit ≈ ${(1 / U).toFixed(2)} m`);

// Body band: 0.3–2.5 m above the floor, so the floor itself and anything
// overhead are ignored and only what you would walk into counts.
const body = pts.filter((p) => p[1] > floor + 0.3 * U && p[1] < floor + 2.5 * U);
let nearest = Infinity, at = null;
const sector = Array.from({ length: 8 }, () => Infinity);
for (const p of body) {
  const d = Math.hypot(p[0], p[2]);
  if (d < nearest) { nearest = d; at = p; }
  const s = (Math.floor(((Math.atan2(p[2], p[0]) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4))) % 8;
  if (d < sector[s]) sector[s] = d;
}
console.log(`clear radius at origin ${f2(nearest)} raw ≈ ${(nearest / U).toFixed(1)} m  (nearest at ${at.map(f2).join(", ")})`);
console.log(`per 45° sector from +x: ${sector.map((v) => (v / U).toFixed(1) + " m").join("  ")}`);
