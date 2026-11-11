/**
 * Measuring round things from one calibrated camera: a cutter in the spindle, the bar in the
 * chuck. Their axis is known (the spindle's), so the picture only has to give the outline: across
 * the axis, the two edges of the silhouette give the diameter; along it, where the body ends
 * gives the tip of the cutter or the face of the bar.
 *
 * Everything is searched along lines laid out in millimetres in space and projected through the
 * lens, never in pixels, so the camera may look from any side and distort as it likes.
 */
import { cameraCenter, project, type Lens, type Pose, type V3 } from './geometry.ts';
import type { Grey } from './setup.ts';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const along = (p: V3, d: V3, s: number): V3 => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
const unit = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

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

/** Brightness along a line in space: at `from + dir · s` for s = s0, s0 + ds, …, s1. NaN where it leaves the picture. */
function profile(g: Grey, lens: Lens, pose: Pose, from: V3, dir: V3, s0: number, s1: number, ds: number): number[] {
  const out: number[] = [];
  for (let s = s0; s <= s1 + 1e-9; s += ds) {
    const px = project(lens, pose, along(from, dir, s));
    out.push(px ? sample(g, px[0], px[1]) : NaN);
  }
  return out;
}

/** Steps in a profile: the change in brightness over `h` samples either side, per sample. */
function steps(p: number[], h: number): number[] {
  const out = new Array<number>(p.length).fill(0);
  for (let i = h; i < p.length - h; i++) {
    let a = 0;
    let b = 0;
    for (let k = 1; k <= h; k++) {
      a += p[i - k]!;
      b += p[i + k]!;
    }
    const d = (b - a) / h;
    out[i] = Number.isFinite(d) ? d : 0;
  }
  return out;
}

/** The strongest step between samples i0 and i1, to a fraction of a sample (parabola through the peak). Null below `min`. */
function strongest(d: number[], i0: number, i1: number, min: number): { i: number; size: number } | null {
  let best = -1;
  let size = min;
  for (let i = Math.max(1, i0); i <= Math.min(d.length - 2, i1); i++) {
    if (Math.abs(d[i]!) > size) {
      size = Math.abs(d[i]!);
      best = i;
    }
  }
  if (best < 0) return null;
  const a = Math.abs(d[best - 1]!);
  const b = Math.abs(d[best]!);
  const c = Math.abs(d[best + 1]!);
  const den = a - 2 * b + c;
  return { i: best + (Math.abs(den) > 1e-9 ? (0.5 * (a - c)) / den : 0), size: d[best]! };
}

export interface CylinderFit {
  /** mm; NaN when it could not be seen. */
  diameter: number;
  /** How much the stations disagree (median distance from the median), mm. */
  scatter: number;
  /** The outline's middle off the expected axis, across the view, mm. */
  offset: number;
  used: number;
  searched: number;
  /** Per station: its place along the axis and the radius found there (null: no clear edges). */
  stations: { t: number; r: number | null }[];
}

export interface CaliperOptions {
  /** Smallest step in brightness (grey levels across the edge) taken for an edge. */
  contrast?: number;
  /** Sample spacing, mm. */
  ds?: number;
}

/**
 * The diameter of a round body about a known axis (`p0 + u · t`), from its outline at the
 * stations `ts`. Each station looks across the axis, square to the line of sight, up to `reach`
 * mm either side, for the strongest edge on each side; the half-width seen there is turned into
 * a radius (the outline of a cylinder seen from a distance D is a little inside its widest part).
 */
export function measureCylinder(g: Grey, lens: Lens, pose: Pose, p0: V3, axis: V3, ts: number[], reach: number, o: CaliperOptions = {}): CylinderFit {
  const u = unit(axis);
  const C = cameraCenter(pose);
  const ds = o.ds ?? Math.max(0.05, reach / 400);
  const h = 3;
  const min = (o.contrast ?? 10) / 2;
  const stations: CylinderFit['stations'] = [];
  const rs: number[] = [];
  const cs: number[] = [];
  for (const t of ts) {
    const P = along(p0, u, t);
    const toCam: V3 = [C[0] - P[0], C[1] - P[1], C[2] - P[2]];
    const n = unit(cross(u, toCam));
    // the camera's distance from the axis, in the plane square to it
    const ax = dot(toCam, u);
    const D = Math.hypot(toCam[0] - u[0] * ax, toCam[1] - u[1] * ax, toCam[2] - u[2] * ax);
    const p = profile(g, lens, pose, P, n, -reach, reach, ds);
    const d = steps(p, h);
    const mid = Math.round(reach / ds);
    const lo = strongest(d, h, mid - 1, min);
    const hi = strongest(d, mid + 1, d.length - 1 - h, min);
    // the two edges are opposite steps (into the body, out of it)
    if (!lo || !hi || Math.sign(lo.size) === Math.sign(hi.size)) {
      stations.push({ t, r: null });
      continue;
    }
    const s0 = -reach + lo.i * ds;
    const s1 = -reach + hi.i * ds;
    const w = (s1 - s0) / 2;
    const r = (D * w) / Math.hypot(D, w);
    stations.push({ t, r });
    rs.push(r);
    cs.push((s0 + s1) / 2);
  }
  if (rs.length < Math.max(2, Math.ceil(ts.length / 3))) return { diameter: NaN, scatter: NaN, offset: NaN, used: rs.length, searched: ts.length, stations };
  const r = median(rs);
  const scatter = median(rs.map((x) => Math.abs(x - r)));
  // stations far off the others (a chip, a flute's shadow, the holder) do not count
  const keep = rs.map((x, i) => ({ x, c: cs[i]! })).filter((e) => Math.abs(e.x - r) <= Math.max(0.3, 3 * scatter));
  const rr = keep.reduce((s, e) => s + e.x, 0) / keep.length;
  return { diameter: 2 * rr, scatter: 2 * scatter, offset: median(keep.map((e) => e.c)), used: keep.length, searched: ts.length, stations };
}

/**
 * Where a round body about the axis ends: the strongest step in brightness along the axis between
 * `t0` and `t1` (averaged over the middle of the body's width). `inside` says on which side of
 * the end the body is (+1: towards larger t). A camera on the body's side of the end sees past
 * the rim, so the end looks further out than it is: by r · (camera's distance along the axis
 * from the end) / (its distance from the axis); that is taken off.
 */
export function findEnd(g: Grey, lens: Lens, pose: Pose, p0: V3, axis: V3, t0: number, t1: number, radius: number, inside: 1 | -1, o: CaliperOptions = {}): number | null {
  const u = unit(axis);
  const C = cameraCenter(pose);
  const ds = o.ds ?? 0.1;
  const toCam: V3 = [C[0] - p0[0], C[1] - p0[1], C[2] - p0[2]];
  const n = unit(cross(u, toCam));
  const ax = dot(toCam, u);
  const D = Math.hypot(toCam[0] - u[0] * ax, toCam[1] - u[1] * ax, toCam[2] - u[2] * ax);
  // three lines along the axis, across the middle third of the body
  let sum: number[] | null = null;
  for (const k of [-0.3, 0, 0.3]) {
    const p = profile(g, lens, pose, along(p0, n, k * radius), u, t0, t1, ds);
    if (!sum) sum = p.map(() => 0);
    for (let i = 0; i < p.length; i++) sum[i]! += p[i]! / 3;
  }
  const d = steps(sum!, 3);
  const hit = strongest(d, 3, d.length - 4, (o.contrast ?? 10) / 2);
  if (!hit) return null;
  const seen = t0 + hit.i * ds;
  // the camera's place along the axis from the end as seen, towards the body
  const behind = (ax - seen) * inside;
  return behind > 0 ? seen + inside * ((radius * behind) / D) : seen;
}

/**
 * Where something larger about the same axis begins (the chuck behind the bar, the collet nut
 * above the cutter): the strongest step in brightness along two lines on the body's own surface,
 * on the side that faces the camera. Up to the shoulder the lines lie on the body; behind it they
 * are inside the larger thing, and the picture shows that instead. The camera must look at the
 * shoulder's face (stand on the body's side of it).
 */
export function findShoulder(g: Grey, lens: Lens, pose: Pose, p0: V3, axis: V3, t0: number, t1: number, radius: number, o: CaliperOptions = {}): number | null {
  const u = unit(axis);
  const C = cameraCenter(pose);
  const ds = o.ds ?? 0.1;
  const toCam: V3 = [C[0] - p0[0], C[1] - p0[1], C[2] - p0[2]];
  const ax = dot(toCam, u);
  // towards the camera, square to the axis; and square to both
  const m = unit([toCam[0] - u[0] * ax, toCam[1] - u[1] * ax, toCam[2] - u[2] * ax]);
  const n = cross(u, m);
  const found: number[] = [];
  for (const deg of [-25, 25]) {
    const a = (deg * Math.PI) / 180;
    const dir: V3 = [m[0] * Math.cos(a) + n[0] * Math.sin(a), m[1] * Math.cos(a) + n[1] * Math.sin(a), m[2] * Math.cos(a) + n[2] * Math.sin(a)];
    const d = steps(profile(g, lens, pose, along(p0, dir, radius), u, t0, t1, ds), 3);
    const hit = strongest(d, 3, d.length - 4, (o.contrast ?? 10) / 2);
    if (hit) found.push(t0 + hit.i * ds);
  }
  if (!found.length) return null;
  return found.reduce((s, v) => s + v, 0) / found.length;
}
