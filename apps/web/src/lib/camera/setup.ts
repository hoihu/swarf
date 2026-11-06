/**
 * Checking the setup against the job from one calibrated camera: where the block really is and
 * how big. The top of the stock lies in a known plane (work Z = stock top), so each pixel there
 * has one point on that plane. For each of the block's four top edges as the job has them, the
 * picture is searched across the edge (in millimetres on the top plane) for the strongest step in
 * brightness; a robust line through the hits is the real edge. Their crossings are the corners.
 *
 * It assumes Z zero is touched off on the top (a block 1 mm higher reads up to about 1 mm off,
 * depending on the view), and only measures in X and Y: the height is not seen this way.
 */
import { project, type Lens, type Pose, type V2, type V3 } from './geometry.ts';

/** A grey picture: luminance 0..255, row by row. */
export interface Grey {
  width: number;
  height: number;
  lum: Float32Array;
}

export interface EdgeFit {
  /** Which edge: front (Y min), right (X max), back (Y max), left (X min). */
  side: 'front' | 'right' | 'back' | 'left';
  /** Hits used / searched. */
  used: number;
  searched: number;
  /** Scatter of the hits about the line, mm. */
  rms: number;
  /** Two points of the fitted line (work X, Y). */
  a: V2;
  b: V2;
  /** The hits (work X, Y), for drawing. */
  hits: V2[];
}

export interface BlockFit {
  /** Front-left corner of the top (work coordinates): where the job has X0 Y0. */
  corner: V2;
  /** Length along the block's own X, width along its Y. */
  x: number;
  y: number;
  /** Turned against the machine's X axis, degrees (counter-clockwise positive). */
  angle: number;
  /** The four corners: front-left, front-right, back-right, back-left. */
  corners: [V2, V2, V2, V2];
  edges: EdgeFit[];
}

/** RGBA picture → luminance, lightly smoothed (3 × 3 box) against noise. */
export function toGrey(img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): Grey {
  const { width: w, height: h, data } = img;
  const raw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
  const lum = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += raw[(y + dy) * w + x + dx]!;
      lum[y * w + x] = s / 9;
    }
  return { width: w, height: h, lum };
}

/** Bilinear sample; NaN off the picture. */
function sample(g: Grey, u: number, v: number): number {
  if (u < 1 || v < 1 || u > g.width - 2 || v > g.height - 2) return NaN;
  const x = Math.floor(u);
  const y = Math.floor(v);
  const fx = u - x;
  const fy = v - y;
  const i = y * g.width + x;
  const L = g.lum;
  return (L[i]! * (1 - fx) + L[i + 1]! * fx) * (1 - fy) + (L[i + g.width]! * (1 - fx) + L[i + g.width + 1]! * fx) * fy;
}

export interface MeasureOptions {
  /** How far either side of the job's edge to look, mm. */
  range?: number;
  /** Search lines per edge. */
  lines?: number;
  /** Step along a search line, mm. */
  step?: number;
}

/**
 * Measure the block's top. `pose` maps machine coordinates into the camera; `wco` is the
 * machine position of work zero ([0, 0, 0] when the pose is in work coordinates).
 */
export function measureBlock(g: Grey, lens: Lens, pose: Pose, wco: V3, stock: { x: number; y: number; top: number }, o: MeasureOptions = {}): BlockFit {
  const range = o.range ?? 15;
  const lines = o.lines ?? 48;
  const step = o.step ?? 0.1;
  // the picture may be at another size than the calibration
  const k = g.width / lens.width;
  const px = (p: V2): V2 | null => {
    const q = project(lens, pose, [p[0] + wco[0], p[1] + wco[1], stock.top + wco[2]]);
    return q ? [q[0] * k, q[1] * k] : null;
  };
  const { x: sx, y: sy } = stock;
  const sides: { side: EdgeFit['side']; from: V2; to: V2; n: V2 }[] = [
    { side: 'front', from: [0, 0], to: [sx, 0], n: [0, -1] },
    { side: 'right', from: [sx, 0], to: [sx, sy], n: [1, 0] },
    { side: 'back', from: [sx, sy], to: [0, sy], n: [0, 1] },
    { side: 'left', from: [0, sy], to: [0, 0], n: [-1, 0] },
  ];
  const edges: EdgeFit[] = [];
  for (const e of sides) {
    const len = Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1]);
    const d: V2 = [(e.to[0] - e.from[0]) / len, (e.to[1] - e.from[1]) / len];
    const n = Math.round((2 * range) / step);
    // each search line: the brightness step's position for either sign of the step
    const found: { u: number; s: number; g: number }[][] = [[], []];
    let searched = 0;
    for (let i = 0; i < lines; i++) {
      // keep off the corners, where the neighbouring edge interferes
      const u = len * (0.08 + (0.84 * i) / (lines - 1));
      const base: V2 = [e.from[0] + d[0] * u, e.from[1] + d[1] * u];
      const prof: number[] = [];
      const first = px([base[0] - e.n[0] * range, base[1] - e.n[1] * range]);
      const last = px([base[0] + e.n[0] * range, base[1] + e.n[1] * range]);
      for (let j = 0; j <= n; j++) {
        const s = -range + j * step;
        const q = px([base[0] + e.n[0] * s, base[1] + e.n[1] * s]);
        prof.push(q ? sample(g, q[0], q[1]) : NaN);
      }
      if (prof.some((v) => Number.isNaN(v)) || !first || !last) continue;
      searched++;
      // how many steps make a pixel here: the edge is blurred over a pixel or two
      const pxPerStep = Math.hypot(last[0] - first[0], last[1] - first[1]) / n;
      const stepsPerPx = 1 / Math.max(pxPerStep, 1e-6);
      // the brightness step across one pixel either side, so a blurred edge still reads as one step
      const w = Math.max(1, Math.round(stepsPerPx));
      let best = [{ j: -1, g: 0 }, { j: -1, g: 0 }];
      for (let j = w; j <= n - w; j++) {
        const grad = prof[j + w]! - prof[j - w]!;
        if (grad > best[0]!.g) best[0] = { j, g: grad };
        if (-grad > best[1]!.g) best[1] = { j, g: -grad };
      }
      best.forEach((b, sign) => {
        if (b.j < 0) return;
        // where the brightness crosses halfway between the two sides (each averaged over two pixels,
        // two pixels away from the peak): steadier than the gradient's peak on a soft, noisy edge
        const mean = (from: number, to: number) => {
          const a = Math.max(0, Math.round(from));
          const z = Math.min(n, Math.round(to));
          let t = 0;
          for (let j = a; j <= z; j++) t += prof[j]!;
          return t / Math.max(1, z - a + 1);
        };
        const lo = mean(b.j - 4 * stepsPerPx, b.j - 2 * stepsPerPx);
        const hi = mean(b.j + 2 * stepsPerPx, b.j + 4 * stepsPerPx);
        const mid = (lo + hi) / 2;
        let at = b.j;
        const reach = Math.round(2 * stepsPerPx);
        for (let d = 0; d <= reach; d++) {
          // the crossing nearest the peak, either way
          for (const j of [b.j + d, b.j - d - 1]) {
            if (j < 0 || j >= n) continue;
            const p0 = prof[j]! - mid;
            const p1 = prof[j + 1]! - mid;
            if (p0 === 0 || p0 * p1 < 0) {
              at = j + (p0 === 0 ? 0 : p0 / (p0 - p1));
              d = reach + 1;
              break;
            }
          }
        }
        found[sign]!.push({ u, s: -range + at * step, g: b.g });
      });
    }
    // the edge's polarity: the sign with the stronger steps (block lighter or darker than behind it)
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
    const pick = median(found[0]!.map((f) => f.g)) >= median(found[1]!.map((f) => f.g)) ? found[0]! : found[1]!;
    const strong = median(pick.map((f) => f.g)) * 0.4;
    const hits = pick.filter((f) => f.g >= strong);
    const fit = robustLine(hits.map((h) => [h.u, h.s] as V2), 0.4);
    const used = fit.inliers.length;
    const at = (u: number): V2 => {
      const s = fit.a + fit.b * u;
      return [e.from[0] + d[0] * u + e.n[0] * s, e.from[1] + d[1] * u + e.n[1] * s];
    };
    edges.push({
      side: e.side,
      used,
      searched,
      rms: fit.rms,
      a: at(0),
      b: at(len),
      hits: fit.inliers.map(([u, s]) => [e.from[0] + d[0] * u + e.n[0] * s, e.from[1] + d[1] * u + e.n[1] * s] as V2),
    });
  }
  const bad = edges.filter((e) => e.used < Math.max(6, e.searched * 0.3));
  if (bad.length) {
    throw new Error(
      `The camera does not find the block's ${bad.map((e) => e.side).join(' and ')} edge${bad.length > 1 ? 's' : ''} near where the job has ${bad.length > 1 ? 'them' : 'it'}` +
        ` (searched ±${range} mm). Is the block in view and lit, Z zero on its top, and within ${range} mm of the job's position?`,
    );
  }
  const cross = (p: EdgeFit, q: EdgeFit): V2 => {
    const r: V2 = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
    const s: V2 = [q.b[0] - q.a[0], q.b[1] - q.a[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    const t = ((q.a[0] - p.a[0]) * s[1] - (q.a[1] - p.a[1]) * s[0]) / den;
    return [p.a[0] + t * r[0], p.a[1] + t * r[1]];
  };
  const [front, right, back, left] = edges as [EdgeFit, EdgeFit, EdgeFit, EdgeFit];
  const corners: [V2, V2, V2, V2] = [cross(left, front), cross(front, right), cross(right, back), cross(back, left)];
  const dist = (p: V2, q: V2) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  const ang = (p: V2, q: V2) => Math.atan2(q[1] - p[1], q[0] - p[0]);
  // the block's X direction: front and back edges averaged (back runs the other way)
  const a1 = ang(corners[0], corners[1]);
  const a2 = ang(corners[3], corners[2]);
  const angle = (Math.atan2(Math.sin(a1) + Math.sin(a2), Math.cos(a1) + Math.cos(a2)) * 180) / Math.PI;
  return {
    corner: corners[0],
    x: (dist(corners[0], corners[1]) + dist(corners[3], corners[2])) / 2,
    y: (dist(corners[0], corners[3]) + dist(corners[1], corners[2])) / 2,
    angle,
    corners,
    edges,
  };
}

/** Line s = a + b·u through points, ignoring those more than `tol` off (RANSAC, then least squares on the inliers). */
function robustLine(pts: V2[], tol: number): { a: number; b: number; rms: number; inliers: V2[] } {
  const ls = (p: V2[]) => {
    const n = p.length;
    const mu = p.reduce((s, q) => s + q[0], 0) / n;
    const ms = p.reduce((s, q) => s + q[1], 0) / n;
    let num = 0;
    let den = 0;
    for (const [u, s] of p) {
      num += (u - mu) * (s - ms);
      den += (u - mu) ** 2;
    }
    const b = den > 1e-12 ? num / den : 0;
    return { a: ms - b * mu, b };
  };
  if (pts.length < 2) return { a: 0, b: 0, rms: Infinity, inliers: [] };
  let best: V2[] = [];
  // deterministic sampling: every pair a fixed stride apart, enough for a few dozen points
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j += Math.max(1, Math.floor(pts.length / 8))) {
      const [u1, s1] = pts[i]!;
      const [u2, s2] = pts[j]!;
      if (Math.abs(u2 - u1) < 1e-9) continue;
      const b = (s2 - s1) / (u2 - u1);
      const a = s1 - b * u1;
      const inl = pts.filter(([u, s]) => Math.abs(a + b * u - s) <= tol);
      if (inl.length > best.length) best = inl;
    }
  if (best.length < 2) best = pts;
  let fit = ls(best);
  // refine: inliers of the least-squares line, fitted again
  const inliers = pts.filter(([u, s]) => Math.abs(fit.a + fit.b * u - s) <= tol);
  if (inliers.length >= 2) fit = ls(inliers);
  const rms = Math.sqrt(inliers.reduce((t, [u, s]) => t + (fit.a + fit.b * u - s) ** 2, 0) / Math.max(1, inliers.length));
  return { ...fit, rms, inliers };
}
