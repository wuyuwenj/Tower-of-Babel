import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import { ARENA_RADIUS } from "./balance";

const GRID = 64;
/** Ignore splats this far above the local floor when sampling — ceilings, foliage. */
const FLOOR_PERCENTILE = 0.12;

export interface Terrain {
  /** Shift applied to the splat so its floor sits at y = 0. */
  yOffset: number;
  /** Row-major GRID x GRID heights covering [-extent, extent] on x and z. */
  heights: Float32Array;
  extent: number;
  filled: boolean;
}

/**
 * Marble and Mint worlds arrive in arbitrary vertical alignment, and a splat is
 * not geometry we can raycast. So sample the splat cloud directly: bucket
 * points into a grid, take a low percentile of each cell's heights as its
 * floor, and use that both to align the world and — when no collider mesh
 * shipped with it — to build a Rapier heightfield to walk on.
 */
export function sampleTerrain(splat: SplatMesh, flipped: boolean): Terrain {
  const extent = ARENA_RADIUS;
  const cells: number[][] = Array.from({ length: GRID * GRID }, () => []);
  const all: number[] = [];

  const sign = flipped ? -1 : 1;
  let seen = 0;

  splat.forEachSplat((_index, center) => {
    // Cheap stride: dense worlds have millions of splats and we only need shape.
    if ((seen++ & 3) !== 0) return;

    const x = sign * center.x;
    const y = sign * center.y;
    const z = center.z;

    if (Math.abs(x) > extent || Math.abs(z) > extent) return;

    const cx = Math.min(GRID - 1, Math.max(0, Math.floor(((x + extent) / (extent * 2)) * GRID)));
    const cz = Math.min(GRID - 1, Math.max(0, Math.floor(((z + extent) / (extent * 2)) * GRID)));
    cells[cz * GRID + cx].push(y);
    all.push(y);
  });

  if (all.length === 0) {
    return { yOffset: 0, heights: new Float32Array(GRID * GRID), extent, filled: false };
  }

  all.sort((a, b) => a - b);
  const globalFloor = all[Math.floor(all.length * FLOOR_PERCENTILE)];

  const heights = new Float32Array(GRID * GRID);
  const known = new Uint8Array(GRID * GRID);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.length < 4) continue;
    cell.sort((a, b) => a - b);
    heights[i] = cell[Math.floor(cell.length * FLOOR_PERCENTILE)] - globalFloor;
    known[i] = 1;
  }

  fillGaps(heights, known);
  smooth(heights);

  return { yOffset: -globalFloor, heights, extent, filled: true };
}

/** Nearest-known fill so sparse corners do not become holes in the floor. */
function fillGaps(heights: Float32Array, known: Uint8Array): void {
  const queue: number[] = [];
  for (let i = 0; i < known.length; i++) if (known[i]) queue.push(i);
  if (queue.length === 0) return;

  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % GRID;
    const z = (i / GRID) | 0;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= GRID || nz >= GRID) continue;
      const n = nz * GRID + nx;
      if (known[n]) continue;
      known[n] = 1;
      heights[n] = heights[i];
      queue.push(n);
    }
  }
}

function smooth(heights: Float32Array): void {
  const copy = Float32Array.from(heights);
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      let sum = 0;
      let n = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= GRID || nz >= GRID) continue;
          sum += copy[nz * GRID + nx];
          n++;
        }
      }
      heights[z * GRID + x] = sum / n;
    }
  }
}

export const TERRAIN_GRID = GRID;

/** Debug helper: a wireframe of the sampled floor, toggled with the ~ key. */
export function terrainWireframe(terrain: Terrain): THREE.LineSegments {
  const geom = new THREE.PlaneGeometry(
    terrain.extent * 2,
    terrain.extent * 2,
    GRID - 1,
    GRID - 1,
  );
  geom.rotateX(-Math.PI / 2);
  const pos = geom.getAttribute("position");
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrain.heights[i]);
  pos.needsUpdate = true;
  return new THREE.LineSegments(
    new THREE.WireframeGeometry(geom),
    new THREE.LineBasicMaterial({ color: 0x39ff9a, transparent: true, opacity: 0.35 }),
  );
}
