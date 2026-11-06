/**
 * Line laser triangulation with the calibrated camera. The laser sits on the spindle head and
 * throws a sheet of light; in machine coordinates the sheet is the plane n·(X − p) = k, where p is
 * the machine position (it moves with the spindle) and n, k are found once by calibration. Each
 * pixel of the laser line seen by the camera is a ray; where the ray meets the sheet is a point on
 * whatever the light falls on. Moving the machine sweeps the line across the work: a height map.
 */
import { add, mulMV, pixelToRay, transpose, type Lens, type Pose, type V2, type V3 } from './geometry.ts';

export interface LaserPlane {
  /** Unit normal, machine coordinates. */
  n: V3;
  /** n·(X − p) = k for points X of the sheet with the machine at p. */
  k: number;
}

/** An RGBA picture. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/**
 * The laser line in a picture, against one without it: pixels whose red rose and whose green and
 * blue did not (a moving tool or a change of light changes all three), and for each column (or
 * row, for a line running up and down) the centre of each piece of line in it, to a fraction of
 * a pixel.
 */
export function extractLine(on: Rgba, off: Rgba, threshold = 25): V2[] {
  const { width: w, height: h } = on;
  const red = new Float32Array(w * h);
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    const dr = on.data[i * 4]! - off.data[i * 4]!;
    const dg = on.data[i * 4 + 1]! - off.data[i * 4 + 1]!;
    const db = on.data[i * 4 + 2]! - off.data[i * 4 + 2]!;
    // red up, green and blue not: a grey change (the tool moving, the light) is not the laser. A line
    // that saturates the camera (bright metal, too much exposure) turns white and gets lost: keep the
    // exposure down, or put a red filter on the camera
    const v = dr - Math.max(dg, db, 0);
    if (v > threshold) {
      red[i] = v;
      const x = i % w;
      const y = (i - x) / w;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      n++;
    }
  }
  if (n < 10) return [];
  // which way the line runs: compare its spread in x and y
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  const out: V2[] = [];
  const along = vx >= vy ? w : h;
  const across = vx >= vy ? h : w;
  const at = (a: number, c: number) => (vx >= vy ? red[c * w + a]! : red[a * w + c]!);
  for (let a = 0; a < along; a++) {
    // every peak across (the line can fall on several surfaces in one column: a clamp and the
    // table behind it), each one's centroid within ±3 px
    for (let c = 0; c < across; c++) {
      const v = at(a, c);
      if (v <= threshold) continue;
      let peak = true;
      for (let k = Math.max(0, c - 3); k <= Math.min(across - 1, c + 3); k++) {
        const u = at(a, k);
        if (u > v || (u === v && k < c)) {
          peak = false;
          break;
        }
      }
      if (!peak) continue;
      let s = 0;
      let m = 0;
      for (let k = Math.max(0, c - 3); k <= Math.min(across - 1, c + 3); k++) {
        const u = at(a, k);
        s += u;
        m += u * k;
      }
      const centre = m / s;
      out.push(vx >= vy ? [a, centre] : [centre, a]);
      c += 3;
    }
  }
  return out;
}

/** The camera's centre and the ray through a pixel, machine coordinates. */
export function ray(lens: Lens, pose: Pose, px: V2): { C: V3; D: V3 } {
  const Rt = transpose(pose.R);
  const C = mulMV(Rt, pose.t).map((v) => -v) as V3;
  const [x, y] = pixelToRay(lens, px[0], px[1]);
  return { C, D: mulMV(Rt, [x, y, 1]) };
}

/** Where a ray meets the plane n·X = c (null when parallel or behind the camera). */
export function hitPlane(C: V3, D: V3, n: V3, c: number): V3 | null {
  const den = n[0] * D[0] + n[1] * D[1] + n[2] * D[2];
  if (Math.abs(den) < 1e-12) return null;
  const t = (c - (n[0] * C[0] + n[1] * C[1] + n[2] * C[2])) / den;
  if (t <= 0) return null;
  return add(C, [D[0] * t, D[1] * t, D[2] * t]);
}

/** The line's pixels as points (machine coordinates), the machine being at p. */
export function triangulate(lens: Lens, pose: Pose, plane: LaserPlane, p: V3, pixels: V2[]): V3[] {
  const c = plane.k + plane.n[0] * p[0] + plane.n[1] * p[1] + plane.n[2] * p[2];
  const out: V3[] = [];
  for (const px of pixels) {
    const { C, D } = ray(lens, pose, px);
    const X = hitPlane(C, D, plane.n, c);
    if (X) out.push(X);
  }
  return out;
}

/**
 * Calibration: the line seen on a flat surface at a known height (machine Z = zTop) with the
 * machine at several positions. Each pixel on the surface is a known point; relative to the
 * machine position they all lie in the sheet: a plane fit through them. `keep` says which points
 * are really on the surface (e.g. inside the block's top).
 */
export function calibratePlane(lens: Lens, pose: Pose, zTop: number, views: { p: V3; pixels: V2[] }[], keep: (X: V3) => boolean): LaserPlane & { rms: number; points: number } {
  const rel: V3[] = [];
  for (const v of views)
    for (const px of v.pixels) {
      const { C, D } = ray(lens, pose, px);
      const X = hitPlane(C, D, [0, 0, 1], zTop);
      if (X && keep(X)) rel.push([X[0] - v.p[0], X[1] - v.p[1], X[2] - v.p[2]]);
    }
  if (rel.length < 30) throw new Error(`The laser line was seen on the top at only ${rel.length} points: is it on, and does it fall on the block?`);
  // the line also lights things that are not the top (the laser's own housing, the table beside
  // the block seen through it): fit, drop what lies far off, fit again
  const fit = fitPlaneRobust(rel);
  if (fit.inliers < 30) throw new Error('The laser line on the top is too scattered to calibrate.');
  // the sheet must not be (nearly) level: then the heights cannot be told apart
  if (Math.abs(fit.n[2]) > 0.97) throw new Error('The laser sheet is almost level: tilt it so it slants down onto the work.');
  return { n: fit.n, k: fit.k, rms: fit.rms, points: fit.inliers };
}

/** A plane through points that may include strays: fits in a narrowing band around the last one. */
export function fitPlaneRobust(pts: V3[], tol = 0.3): { n: V3; k: number; rms: number; inliers: number } {
  let use = pts;
  let fit = fitPlane(use);
  for (const band of [10, 3, 1, tol]) {
    const next = pts.filter((p) => Math.abs(fit.n[0] * p[0] + fit.n[1] * p[1] + fit.n[2] * p[2] - fit.k) <= band);
    if (next.length < 3) break;
    use = next;
    fit = fitPlane(use);
  }
  return { ...fit, inliers: use.length };
}

/** Least-squares plane n·X = k through points: the normal is the direction of least spread. */
export function fitPlane(pts: V3[]): { n: V3; k: number; rms: number } {
  const N = pts.length;
  const c = pts.reduce((s, p) => [s[0] + p[0] / N, s[1] + p[1] / N, s[2] + p[2] / N] as V3, [0, 0, 0] as V3);
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j]! += d[i]! * d[j]!;
  }
  const { vectors, values } = jacobi3(M);
  let k = 0;
  for (let i = 1; i < 3; i++) if (values[i]! < values[k]!) k = i;
  let n: V3 = [vectors[k]!, vectors[3 + k]!, vectors[6 + k]!];
  const l = Math.hypot(...n);
  n = [n[0] / l, n[1] / l, n[2] / l];
  // a consistent sign: facing up
  if (n[2] < 0 || (n[2] === 0 && n[1] < 0)) n = [-n[0], -n[1], -n[2]];
  const kk = n[0] * c[0] + n[1] * c[1] + n[2] * c[2];
  const rms = Math.sqrt(pts.reduce((s, p) => s + (n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - kk) ** 2, 0) / N);
  return { n, k: kk, rms };
}

/** Eigen decomposition of a symmetric 3 × 3 (Jacobi rotations): eigenvectors as columns. */
function jacobi3(A: number[]): { values: number[]; vectors: number[] } {
  const a = [...A];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) off += a[p * 3 + q]! ** 2;
    if (off < 1e-20) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q]!;
      if (Math.abs(apq) < 1e-15) continue;
      const theta = (a[q * 3 + q]! - a[p * 3 + p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p]!;
        const akq = a[k * 3 + q]!;
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k]!;
        const aqk = a[q * 3 + k]!;
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p]!;
        const vkq = v[k * 3 + q]!;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0]!, a[4]!, a[8]!], vectors: v };
}

// ---------- the height map and what is in it ----------

export interface HeightMap {
  /** Work X/Y of the first cell's corner, cell size (mm), cells across and deep. */
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  /** Average height per cell (work Z); NaN where nothing was seen. Single points scatter a few tenths; a cell's average much less. */
  z: Float32Array;
  /** Points per cell. */
  count: Uint16Array;
}

/** Points (work coordinates) into a grid of cells, averaging each cell's heights. */
export function heightMap(points: V3[], cell = 0.5): HeightMap {
  // plain loops: spreading a hundred thousand points into Math.min overflows the stack
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const x0 = Math.floor(minX / cell) * cell;
  const y0 = Math.floor(minY / cell) * cell;
  const nx = Math.ceil((maxX - x0) / cell) + 1;
  const ny = Math.ceil((maxY - y0) / cell) + 1;
  const sum = new Float64Array(nx * ny);
  const count = new Uint16Array(nx * ny);
  for (const [x, y, h] of points) {
    const k = Math.floor((y - y0) / cell) * nx + Math.floor((x - x0) / cell);
    sum[k]! += h;
    count[k]! += 1;
  }
  const z = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) z[k] = count[k] ? sum[k]! / count[k]! : NaN;
  return { x0, y0, cell, nx, ny, z, count };
}

export interface Obstacle {
  /** Work X/Y of its extent and its top (work Z). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  top: number;
}

export interface ScanResult {
  /** The top: points within the block's outline (inset). */
  top: { mean: number; highest: number; lowest: number; slopeX: number; slopeY: number; flatness: number; points: number };
  /** Anything beside the block reaching higher than `minHeight` above the table: clamps, vise jaws, the vise. */
  obstacles: Obstacle[];
}

/**
 * What the scan says about the setup: the block's top (inside its outline, `inset` mm in) and
 * what stands up next to it. `bottom`: work Z of the table (stock bottom).
 */
export function analyseScan(points: V3[], block: { x: number; y: number; top: number; bottom: number }, o: { inset?: number; margin?: number; minHeight?: number; cell?: number } = {}): ScanResult {
  const inset = o.inset ?? 3;
  const margin = o.margin ?? 1.5;
  const minHeight = o.minHeight ?? 2;
  const cell = o.cell ?? 1;
  const top = points.filter(([x, y]) => x > inset && y > inset && x < block.x - inset && y < block.y - inset);
  if (top.length < 50) throw new Error(`Only ${top.length} laser points on the block's top: did the line cross it?`);
  // the top as 2 mm patches, each the average of its points: single points scatter a few tenths
  const hm = heightMap(top, 2);
  const patches: V3[] = [];
  for (let j = 0; j < hm.ny; j++)
    for (let i = 0; i < hm.nx; i++) {
      const k = j * hm.nx + i;
      if (hm.count[k]! >= 4) patches.push([hm.x0 + (i + 0.5) * hm.cell, hm.y0 + (j + 0.5) * hm.cell, hm.z[k]!]);
    }
  if (patches.length < 6) throw new Error('Too little of the top was seen to judge it.');
  const f = fitPlaneRobust(patches, 0.3);
  // as z = a + b x + c y
  const b = -f.n[0] / f.n[2];
  const c = -f.n[1] / f.n[2];
  const a = f.k / f.n[2];
  const zs = Float64Array.from(patches, (p) => p[2]).sort();
  let sum = 0;
  for (const z of zs) sum += z;
  const off = Float64Array.from(patches, (p) => Math.abs(p[2] - (a + b * p[0] + c * p[1]))).sort();
  const topRes = { mean: sum / zs.length, highest: zs[zs.length - 1]!, lowest: zs[0]!, slopeX: b * 100, slopeY: c * 100, flatness: off[off.length - 1]!, points: top.length };

  // beside the block: cells standing up from the table, grouped into connected pieces
  const outside = points.filter(([x, y]) => x < -margin || y < -margin || x > block.x + margin || y > block.y + margin);
  const obstacles: Obstacle[] = [];
  if (outside.length) {
    const om = heightMap(outside, cell);
    const hm = om;
    const up = (k: number) => hm.count[k]! >= 2 && hm.z[k]! > block.bottom + minHeight;
    const seen = new Uint8Array(hm.nx * hm.ny);
    for (let k = 0; k < hm.nx * hm.ny; k++) {
      if (seen[k] || !up(k)) continue;
      // flood fill (4-neighbours, bridging single missing cells)
      const stack = [k];
      seen[k] = 1;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let topZ = -Infinity;
      let count = 0;
      const heights: number[] = [];
      while (stack.length) {
        const cur = stack.pop()!;
        const i = cur % hm.nx;
        const j = (cur - i) / hm.nx;
        count++;
        heights.push(hm.z[cur]!);
        x0 = Math.min(x0, hm.x0 + i * cell);
        y0 = Math.min(y0, hm.y0 + j * cell);
        x1 = Math.max(x1, hm.x0 + (i + 1) * cell);
        y1 = Math.max(y1, hm.y0 + (j + 1) * cell);
        topZ = Math.max(topZ, hm.z[cur]!);
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= hm.nx || jj >= hm.ny) continue;
          const kk = jj * hm.nx + ii;
          if (!seen[kk] && up(kk)) {
            seen[kk] = 1;
            stack.push(kk);
          }
        }
      }
      if (count < 6) continue; // a few stray cells: noise, chips
      // its top: high but not the single highest stray point
      heights.sort((u, v) => u - v);
      obstacles.push({ x0, y0, x1, y1, top: heights[Math.round(0.95 * (heights.length - 1))]! });
    }
  }
  return { top: topRes, obstacles };
}
