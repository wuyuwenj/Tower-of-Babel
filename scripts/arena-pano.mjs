// Ray-trace an equirectangular panorama of an arena: the camera stands at eye
// height in the exact centre of an empty floor, with every wall, tree and
// building in a ring at ARENA metres. Fed to Marble as an image prompt, it pins
// the one thing a text prompt cannot: where the origin is and what is (not)
// around it. No WebGL, no dependencies; writes a PNG.
//
//   node scripts/arena-pano.mjs out.png [--arena 12] [--size 2048] [--theme haunted] [--depth depth.png]
//
// --depth also writes a 16-bit depth panorama (metres, linear 0..DEPTH_MAX) for
// Marble's pano:depth_to_rgb, which paints a photoreal pano onto this exact
// geometry — the layout is ours, the art is theirs.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const out = args[0] ?? "arena-pano.png";
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const ARENA = Number(opt("arena", 12));
const W = Number(opt("size", 2048));
const H = W / 2;
const THEME = opt("theme", "haunted");
const EYE = 1.6;

// ---------------------------------------------------------------------------
// Scene: axis-aligned boxes on a ring, plus a facade with windows.
const boxes = []; // {min, max, color, windows?}
const push = (cx, cz, w, h, d, yaw, color, extra = {}) => {
  // Approximate yaw by widening the box footprint; AABBs keep the tracer trivial.
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  const hw = (w * c + d * s) / 2, hd = (w * s + d * c) / 2;
  boxes.push({ min: [cx - hw, 0, cz - hd], max: [cx + hw, h, cz + hd], color, ...extra });
};

const rand = (() => { let s = 1337; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();

if (THEME === "haunted") {
  // The manor: a wide dark facade straight ahead (-Z), lit windows.
  push(0, -(ARENA + 5), 18, 9, 4, 0, [0.16, 0.14, 0.18], { windows: true });
  push(-11, -(ARENA + 4), 5, 12, 5, 0, [0.14, 0.12, 0.16]); // tower
  // Crumbling walls and iron fences around the rest of the ring, with gaps.
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    if (Math.abs(((a + Math.PI) % (2 * Math.PI)) - Math.PI) < 0.55) continue; // leave the manor side
    if (rand() < 0.2) continue; // gaps
    const r = ARENA + 0.6 + rand() * 1.2;
    const h = 1.2 + rand() * 1.6;
    push(Math.sin(a) * r, -Math.cos(a) * r, 3.2, h, 0.5, a, [0.22, 0.2, 0.19]);
  }
  // Dead trees: thin tall posts with a blob on top.
  for (let i = 0; i < 9; i++) {
    const a = rand() * Math.PI * 2, r = ARENA + 2 + rand() * 4;
    const x = Math.sin(a) * r, z = -Math.cos(a) * r;
    push(x, z, 0.5, 5 + rand() * 3, 0.5, 0, [0.1, 0.09, 0.09]);
    push(x, z, 2.5 + rand() * 2, 1.5, 2.5, 0, [0.12, 0.11, 0.1], { lift: 4.5 + rand() * 2 });
  }
}
for (const b of boxes) if (b.lift) { b.min[1] += b.lift; b.max[1] += b.lift; }

// ---------------------------------------------------------------------------
function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = ((h ^ (h >> 13)) * 1274126177) | 0; return ((h ^ (h >> 16)) >>> 0) / 4294967295; }

function rayBox(o, d, b) {
  let t0 = -Infinity, t1 = Infinity, axis = -1;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / d[i];
    let a = (b.min[i] - o[i]) * inv, c = (b.max[i] - o[i]) * inv;
    if (a > c) [a, c] = [c, a];
    if (a > t0) { t0 = a; axis = i; }
    if (c < t1) t1 = c;
    if (t0 > t1) return null;
  }
  if (t0 < 0.01) return null;
  return { t: t0, axis };
}

const DEPTH_MAX = 80;
function shade(px, py, dir) {
  const o = [0, EYE, 0];
  // Nearest box
  let best = null;
  for (const b of boxes) { const h = rayBox(o, dir, b); if (h && (!best || h.t < best.t)) best = { ...h, b }; }
  // Ground
  let tg = Infinity;
  if (dir[1] < 0) tg = -EYE / dir[1];

  let col;
  let dist = DEPTH_MAX;
  if (best && best.t < tg) {
    dist = best.t;
    const b = best.b, p = [o[0] + dir[0] * best.t, o[1] + dir[1] * best.t, o[2] + dir[2] * best.t];
    const nShade = [0.75, 1.0, 0.6][best.axis];
    col = b.color.map((c) => c * nShade);
    if (b.windows && best.axis === 2) {
      // Rows of lit windows on the facade.
      const u = (p[0] - b.min[0]) / (b.max[0] - b.min[0]), v = p[1] / b.max[1];
      const wu = (u * 9) % 1, wv = (v * 3) % 1;
      if (wu > 0.3 && wu < 0.7 && wv > 0.35 && wv < 0.8 && hash(Math.floor(u * 9), Math.floor(v * 3)) > 0.35) col = [0.95, 0.75, 0.35];
    }
    const fog = Math.min(1, best.t / 60);
    col = col.map((c, i) => c * (1 - fog) + [0.05, 0.05, 0.08][i] * fog);
  } else if (tg < Infinity) {
    dist = Math.min(tg, DEPTH_MAX);
    const p = [o[0] + dir[0] * tg, o[2] + dir[2] * tg];
    const r = Math.hypot(p[0], p[1]);
    // Cracked flagstones: cell tint plus mortar lines.
    const cx = Math.floor(p[0] / 1.3), cz = Math.floor(p[1] / 1.3);
    const fx = p[0] / 1.3 - cx, fz = p[1] / 1.3 - cz;
    const mortar = fx < 0.05 || fz < 0.05 ? 0.55 : 1;
    const tint = 0.16 + hash(cx, cz) * 0.08;
    col = [tint * 1.05, tint, tint * 1.15].map((c) => c * mortar);
    if (r > ARENA) col = col.map((c) => c * 0.8); // beyond the ring: darker, weedier
    const fog = Math.min(1, tg / 80);
    col = col.map((c, i) => c * (1 - fog) + [0.05, 0.05, 0.08][i] * fog);
  } else {
    // Night sky: gradient, a moon, sparse stars.
    const up = dir[1];
    col = [0.03 + 0.05 * (1 - up), 0.03 + 0.04 * (1 - up), 0.08 + 0.1 * (1 - up)];
    const moon = [Math.sin(-0.9) * Math.cos(0.6), Math.sin(0.6), -Math.cos(-0.9) * Math.cos(0.6)];
    const dm = dir[0] * moon[0] + dir[1] * moon[1] + dir[2] * moon[2];
    if (dm > 0.9992) col = [0.95, 0.95, 0.85]; else if (dm > 0.995) col = col.map((c) => c + (dm - 0.995) * 60);
    if (hash(px, py) > 0.9985 && up > 0.1) col = [0.8, 0.8, 0.9];
  }
  return [col, dist];
}

// ---------------------------------------------------------------------------
const rgb = Buffer.alloc(W * H * 3);
const depth = new Uint16Array(W * H);
for (let y = 0; y < H; y++) {
  const lat = (0.5 - (y + 0.5) / H) * Math.PI;
  for (let x = 0; x < W; x++) {
    const lon = ((x + 0.5) / W - 0.5) * Math.PI * 2;
    const dir = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), -Math.cos(lat) * Math.cos(lon)];
    const [c, dist] = shade(x, y, dir);
    depth[y * W + x] = Math.min(65535, Math.round((dist / DEPTH_MAX) * 65535));
    const i = (y * W + x) * 3;
    rgb[i] = Math.min(255, Math.max(0, c[0] * 255)) | 0;
    rgb[i + 1] = Math.min(255, Math.max(0, c[1] * 255)) | 0;
    rgb[i + 2] = Math.min(255, Math.max(0, c[2] * 255)) | 0;
  }
}

// Minimal PNG encoder.
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(file, rows, bytesPerRow, bitDepth, colorType) {
  const raw = Buffer.alloc((bytesPerRow + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (bytesPerRow + 1)] = 0; rows.copy(raw, y * (bytesPerRow + 1) + 1, y * bytesPerRow, (y + 1) * bytesPerRow); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
png(out, rgb, W * 3, 8, 2);
console.log(`wrote ${out} (${W}x${H}, arena ${ARENA} m, ${boxes.length} boxes)`);
const depthOut = opt("depth");
if (depthOut) {
  const d16 = Buffer.alloc(W * H * 2);
  for (let i = 0; i < depth.length; i++) d16.writeUInt16BE(depth[i], i * 2); // PNG is big-endian
  png(depthOut, d16, W * 2, 16, 0);
  console.log(`wrote ${depthOut} (16-bit depth, z_min 0, z_max ${DEPTH_MAX} m)`);
}
