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
  /** It reaches over the block's top (a strap, a clamp's nose): in the way of facing it. */
  overTop?: boolean;
}

export interface ScanResult {
  /** The top: points within the block's outline (inset), leaving out what lies on it. */
  top: { mean: number; highest: number; lowest: number; slopeX: number; slopeY: number; flatness: number; points: number; /** Square millimetres of the top left out: something lies on them. */ covered: number };
  /** What stands up beside the block, or lies on its top: clamps, straps, bolts, vise jaws. A
   * thing with steps (a strap with a nut and a bolt on it) is one box per step, each as high as
   * that step. */
  obstacles: Obstacle[];
}

/** A plane z = a + b x + c y, robustly through 2 mm patches of points (each the average of its points: single points scatter a few tenths). */
function topPlane(points: V3[], keep: (x: number, y: number) => boolean) {
  const hm = heightMap(points, 2);
  const patches: V3[] = [];
  for (let j = 0; j < hm.ny; j++)
    for (let i = 0; i < hm.nx; i++) {
      const k = j * hm.nx + i;
      const x = hm.x0 + (i + 0.5) * hm.cell;
      const y = hm.y0 + (j + 0.5) * hm.cell;
      if (hm.count[k]! >= 4 && keep(x, y)) patches.push([x, y, hm.z[k]!]);
    }
  if (patches.length < 6) throw new Error('Too little of the top was seen to judge it.');
  const f = fitPlaneRobust(patches, 0.3);
  const b = -f.n[0] / f.n[2];
  const c = -f.n[1] / f.n[2];
  const a = f.k / f.n[2];
  return { at: (x: number, y: number) => a + b * x + c * y, b, c, patches };
}

const pct = (a: number[], q: number) => {
  const s = [...a].sort((u, v) => u - v);
  return s[Math.round(q * (s.length - 1))]!;
};

/**
 * What the scan says about the setup: the block's top (inside its outline, `inset` mm in, leaving
 * out whatever lies on it) and what stands up beside it or lies on it. `bottom`: work Z of the
 * stock's bottom (what holds the block is what rises more than `minHeight` above it; on the top,
 * more than `onTop` above the top).
 */
export function analyseScan(
  points: V3[],
  block: { x: number; y: number; top: number; bottom: number },
  o: { inset?: number; margin?: number; minHeight?: number; onTop?: number; cell?: number } = {},
): ScanResult {
  const inset = o.inset ?? 3;
  const margin = o.margin ?? 1.5;
  const minHeight = o.minHeight ?? 2;
  const onTop = o.onTop ?? 1.5;
  const cell = o.cell ?? 1;
  const within = (x: number, y: number, m: number) => x > m && y > m && x < block.x - m && y < block.y - m;
  const top = points.filter(([x, y]) => within(x, y, inset));
  if (top.length < 50) throw new Error(`Only ${top.length} laser points on the block's top: did the line cross it?`);
  // a first look at the top (what lies on it is far off the plane and left out by the robust fit)
  const first = topPlane(top, () => true);

  // everything standing up, in 1 mm cells: beside the block, above the stock's bottom; on the
  // block, above its top. The band along the block's sides (its side faces, half seen) is left out.
  const hm = heightMap(points, cell);
  const N = hm.nx * hm.ny;
  const up = new Uint8Array(N);
  const cx = (i: number) => hm.x0 + (i + 0.5) * cell;
  const cy = (j: number) => hm.y0 + (j + 0.5) * cell;
  for (let j = 0; j < hm.ny; j++)
    for (let i = 0; i < hm.nx; i++) {
      const k = j * hm.nx + i;
      if (hm.count[k]! < 2) continue;
      const x = cx(i);
      const y = cy(j);
      const z = hm.z[k]!;
      if (within(x, y, -margin)) {
        if (within(x, y, margin) && z > first.at(x, y) + onTop) up[k] = 1;
      } else if (z > block.bottom + minHeight) up[k] = 1;
    }

  // the top again, without the patches near anything lying on it
  const near = (x: number, y: number) => {
    const i0 = Math.floor((x - 3 - hm.x0) / cell);
    const j0 = Math.floor((y - 3 - hm.y0) / cell);
    for (let j = Math.max(0, j0); j <= Math.min(hm.ny - 1, j0 + Math.ceil(6 / cell)); j++)
      for (let i = Math.max(0, i0); i <= Math.min(hm.nx - 1, i0 + Math.ceil(6 / cell)); i++) if (up[j * hm.nx + i]) return true;
    return false;
  };
  const clear = top.filter(([x, y]) => !near(x, y));
  if (clear.length < 50) throw new Error('Hardly any of the top is free: what lies on it covers nearly all of it.');
  const plane = topPlane(clear, () => true);
  const zs = plane.patches.map((p) => p[2]).sort((u, v) => u - v);
  const off = plane.patches.map((p) => Math.abs(p[2] - plane.at(p[0], p[1]))).sort((u, v) => u - v);
  const covered = first.patches.filter(([x, y]) => near(x, y)).length * 4;
  const topRes = {
    mean: zs.reduce((s, z) => s + z, 0) / zs.length,
    highest: zs[zs.length - 1]!,
    lowest: zs[0]!,
    slopeX: plane.b * 100,
    slopeY: plane.c * 100,
    flatness: off[off.length - 1]!,
    points: clear.length,
    covered,
  };

  // the pieces: connected cells standing up (bridging single missing cells), each split by its steps
  const obstacles: Obstacle[] = [];
  const seen = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (seen[k] || !up[k]) continue;
    const piece: number[] = [];
    const stack = [k];
    seen[k] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      piece.push(cur);
      const i = cur % hm.nx;
      const j = (cur - i) / hm.nx;
      for (const [di, dj] of NEIGHBOURS_BRIDGING) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= hm.nx || jj >= hm.ny) continue;
        const kk = jj * hm.nx + ii;
        if (!seen[kk] && up[kk]) {
          seen[kk] = 1;
          stack.push(kk);
        }
      }
    }
    if (piece.length < 6) continue; // a few stray cells: noise, chips
    obstacles.push(...steps(hm, piece));
  }
  for (const ob of obstacles) {
    // beside the block and reaching into the band along its side: it reaches the side (a vise jaw, a stop)
    const overX = ob.x1 > 0 && ob.x0 < block.x;
    const overY = ob.y1 > 0 && ob.y0 < block.y;
    const reach = margin + 1.5 * cell;
    if (overY && ob.x1 <= 0 && ob.x1 > -reach) ob.x1 = 0;
    if (overY && ob.x0 >= block.x && ob.x0 < block.x + reach) ob.x0 = block.x;
    if (overX && ob.y1 <= 0 && ob.y1 > -reach) ob.y1 = 0;
    if (overX && ob.y0 >= block.y && ob.y0 < block.y + reach) ob.y0 = block.y;
    // over the top by more than its own growth and the block's being a little off
    if (Math.min(ob.x1, block.x) - Math.max(ob.x0, 0) > 3 && Math.min(ob.y1, block.y) - Math.max(ob.y0, 0) > 3) ob.overTop = true;
  }
  return { top: topRes, obstacles };
}

const NEIGHBOURS_BRIDGING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]] as const;

/**
 * A piece of cells as boxes, one per step, peeled from the top: the highest part (a bolt) as high
 * as it is, then what is left as high as it is (a nut, the strap), up to four steps; the lowest
 * step is the whole piece. A step is 2.5 mm or more below the one above it. Side faces seen at an
 * angle smear heights into the cells beside them: the steps' tops are 95th percentiles, and each
 * step but the lowest is grown by a cell (its edge cells average it and what is below).
 */
function steps(hm: HeightMap, piece: number[]): Obstacle[] {
  const cell = hm.cell;
  const z = (k: number) => hm.z[k]!;
  const levels: number[] = [];
  let rest = piece;
  while (rest.length >= 3 && levels.length < 4) {
    const L = pct(rest.map(z), 0.95);
    levels.push(L);
    rest = rest.filter((k) => z(k) < L - 2.5);
  }
  const box = (cells: number[], grow: number, top: number): Obstacle => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const k of cells) {
      const i = k % hm.nx;
      const j = (k - i) / hm.nx;
      x0 = Math.min(x0, hm.x0 + i * cell);
      y0 = Math.min(y0, hm.y0 + j * cell);
      x1 = Math.max(x1, hm.x0 + (i + 1) * cell);
      y1 = Math.max(y1, hm.y0 + (j + 1) * cell);
    }
    return { x0: x0 - grow, y0: y0 - grow, x1: x1 + grow, y1: y1 + grow, top };
  };
  const out: Obstacle[] = [];
  // under a higher step, or right beside it (its side faces, smeared into the cells around it)
  const under = (k: number, m = 1.5 * cell) => {
    const i = k % hm.nx;
    const j = (k - i) / hm.nx;
    const x = hm.x0 + (i + 0.5) * cell;
    const y = hm.y0 + (j + 0.5) * cell;
    return out.some((o) => x > o.x0 - m && x < o.x1 + m && y > o.y0 - m && y < o.y1 + m);
  };
  for (const [s, L] of levels.entries()) {
    const ceiling = s ? levels[s - 1]! - 2.5 : Infinity;
    // this step's own cells, for its height: not those of the steps above, nor right beside them
    const own = (cells: number[]) => cells.filter((k) => z(k) < ceiling && !under(k)).map(z);
    if (s === levels.length - 1) {
      // the lowest: the whole piece, unless the steps above cover it already (all but the smear beside them)
      const h = own(piece);
      const beyond = piece.filter((k) => z(k) < ceiling && !under(k, 2.5 * cell)).length;
      if (s === 0 || (h.length >= 3 && beyond >= 3)) out.push(box(piece, 0, h.length ? pct(h, 0.95) : L));
      break;
    }
    // what stands at this height or higher, as connected parts (two bolts are two boxes)
    const inStep = new Set(piece.filter((k) => z(k) >= L - 1.5));
    const done = new Set<number>();
    const parts: { cells: number[]; o: Obstacle }[] = [];
    for (const k of inStep) {
      if (done.has(k)) continue;
      const part: number[] = [];
      const stack = [k];
      done.add(k);
      while (stack.length) {
        const cur = stack.pop()!;
        part.push(cur);
        const i = cur % hm.nx;
        for (const [di, dj] of NEIGHBOURS_BRIDGING) {
          if (i + di < 0 || i + di >= hm.nx) continue;
          const kk = cur + dj * hm.nx + di;
          if (inStep.has(kk) && !done.has(kk)) {
            done.add(kk);
            stack.push(kk);
          }
        }
      }
      parts.push({ cells: part, o: box(part, cell, 0) });
    }
    // parts within 4 mm are one thing seen in pieces (shadows, what the camera cannot see)
    for (let merged = true; merged; ) {
      merged = false;
      for (let a = 0; a < parts.length && !merged; a++)
        for (let b = a + 1; b < parts.length && !merged; b++) {
          const p = parts[a]!.o;
          const q = parts[b]!.o;
          if (p.x0 - 4 < q.x1 && q.x0 - 4 < p.x1 && p.y0 - 4 < q.y1 && q.y0 - 4 < p.y1) {
            const cells = [...parts[a]!.cells, ...parts[b]!.cells];
            parts[a] = { cells, o: box(cells, cell, 0) };
            parts.splice(b, 1);
            merged = true;
          }
        }
    }
    for (const { cells, o } of parts) {
      // a step that is only the smear beside the one above it is no step
      if (s > 0 && cells.filter((q) => z(q) < ceiling && !under(q, 2.5 * cell)).length < 3) continue;
      const h = own(cells);
      out.push({ ...o, top: h.length ? pct(h, 0.95) : L });
    }
  }
  return out;
}
