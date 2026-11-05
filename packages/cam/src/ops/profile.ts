/**
 * 2D lathe profile geometry: a contour from the face towards the chuck, with chamfered or rounded
 * corners, offset for the insert's nose radius (and a finishing allowance), and the roughing
 * boundary. Points are (x = radius, z). The profile must not undercut: going towards the chuck
 * the radius never gets smaller (a right-hand turning tool cannot follow a neck; use a groove).
 */
import { CamError } from '../program.ts';

export interface P2 {
  x: number;
  z: number;
}

export interface ProfilePoint {
  /** Diameter */
  d: number;
  z: number;
  /** 45°-style chamfer at this corner: leg length along both sides. */
  c?: number | undefined;
  /** Corner radius at this vertex. */
  r?: number | undefined;
}

const sub = (a: P2, b: P2): P2 => ({ x: a.x - b.x, z: a.z - b.z });
const add = (a: P2, b: P2): P2 => ({ x: a.x + b.x, z: a.z + b.z });
const mul = (a: P2, k: number): P2 => ({ x: a.x * k, z: a.z * k });
const len = (a: P2) => Math.hypot(a.x, a.z);
const unit = (a: P2): P2 => mul(a, 1 / len(a));
const cross = (a: P2, b: P2) => a.x * b.z - a.z * b.x;

/** Check the vertices and expand chamfers and corner radii into a polyline (arcs as short chords). */
export function buildProfile(points: ProfilePoint[], chord = 0.02): P2[] {
  if (points.length < 2) throw new CamError('a profile needs at least two points');
  const v: P2[] = points.map((p) => ({ x: p.d / 2, z: p.z }));
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1]!;
    const b = v[i]!;
    if (b.z > a.z + 1e-9) throw new CamError(`point ${i + 1} (Z${b.z}) is in front of point ${i} (Z${a.z}): list the profile from the face towards the chuck`);
    if (b.x < a.x - 1e-9) throw new CamError(`point ${i + 1} (Ø${b.x * 2}) is smaller than point ${i} (Ø${a.x * 2}): that is an undercut, use a groove for it`);
    if (Math.abs(b.x - a.x) < 1e-9 && Math.abs(b.z - a.z) < 1e-9) throw new CamError(`points ${i} and ${i + 1} are the same`);
  }
  const out: P2[] = [v[0]!];
  for (let i = 1; i < v.length - 1; i++) {
    const p = v[i]!;
    const { c, r } = points[i]!;
    const d1 = unit(sub(p, v[i - 1]!));
    const d2 = unit(sub(v[i + 1]!, p));
    const turn = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.z * d2.z)));
    if ((!c && !r) || turn < 1e-6) {
      out.push(p);
      continue;
    }
    const l1 = len(sub(p, v[i - 1]!));
    const l2 = len(sub(v[i + 1]!, p));
    if (c) {
      if (c >= l1 || c >= l2) throw new CamError(`the chamfer at point ${i + 1} is longer than its sides`);
      out.push(sub(p, mul(d1, c)), add(p, mul(d2, c)));
      continue;
    }
    // tangent fillet: tangent points at t from the vertex, centre on the bisector
    const t = r! * Math.tan(turn / 2);
    if (t >= l1 || t >= l2) throw new CamError(`the radius at point ${i + 1} does not fit between its neighbours`);
    const a = sub(p, mul(d1, t));
    const b = add(p, mul(d2, t));
    const side = cross(d1, d2) > 0 ? 1 : -1;
    // centre: from the first tangent point, perpendicular towards the inside of the turn
    const nIn = side > 0 ? { x: -d1.z, z: d1.x } : { x: d1.z, z: -d1.x };
    const centre = add(a, mul(nIn, r!));
    const a0 = Math.atan2(a.z - centre.z, a.x - centre.x);
    let a1 = Math.atan2(b.z - centre.z, b.x - centre.x);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    a1 = a0 + sweep;
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(0, 1 - chord / r!)))));
    out.push(a);
    for (let k = 1; k < n; k++) {
      const ang = a0 + (sweep * k) / n;
      out.push({ x: centre.x + r! * Math.cos(ang), z: centre.z + r! * Math.sin(ang) });
    }
    out.push(b);
  }
  out.push(v.at(-1)!);
  return out;
}

/**
 * Offset the profile by `dist` to the tool side (outwards: larger radius, towards the face).
 * Outer (convex) corners get a round join, inner corners the intersection of the offset sides.
 */
export function offsetProfile(pts: P2[], dist: number, chord = 0.02): P2[] {
  if (dist <= 0) return pts.map((p) => ({ ...p }));
  const segs: { a: P2; b: P2; d: P2; n: P2 }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const l = len(sub(b, a));
    if (l < 1e-9) continue;
    const d = mul(sub(b, a), 1 / l);
    const n = { x: -d.z, z: d.x }; // outward for a profile running towards the chuck
    segs.push({ a: add(a, mul(n, dist)), b: add(b, mul(n, dist)), d, n });
  }
  const out: P2[] = [segs[0]!.a];
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!;
    const t = segs[i + 1]!;
    const turn = cross(s.d, t.d);
    if (Math.abs(turn) < 1e-9) {
      out.push(s.b);
      continue;
    }
    if (turn > 0) {
      // inner corner: where the two offset lines meet
      const denom = cross(s.d, t.d);
      const k = cross(sub(t.a, s.a), t.d) / denom;
      out.push(add(s.a, mul(s.d, k)));
    } else {
      // outer corner: arc around the original vertex
      const v = sub(s.b, mul(s.n, dist));
      const a0 = Math.atan2(s.n.z, s.n.x);
      let sweep = Math.atan2(t.n.z, t.n.x) - a0;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      const n = Math.max(1, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(0, 1 - chord / dist)))));
      for (let k = 0; k <= n; k++) {
        const ang = a0 + (sweep * k) / n;
        out.push({ x: v.x + dist * Math.cos(ang), z: v.z + dist * Math.sin(ang) });
      }
    }
  }
  out.push(segs.at(-1)!.b);
  return out;
}

/** The tip path for a nose radius `rn` and allowance `stock`: nose centre path minus (rn, rn). */
export function tipPath(profile: P2[], rn: number, stock = 0): P2[] {
  return offsetProfile(profile, rn + stock).map((p) => ({ x: p.x - rn, z: p.z - rn }));
}

/**
 * Where a roughing pass at radius `r` must stop: the first Z (coming from the face) where the
 * boundary reaches `r`. Null when the boundary never gets that big (the pass runs the whole length).
 */
export function zAtRadius(boundary: P2[], r: number): number | null {
  for (let i = 1; i < boundary.length; i++) {
    const a = boundary[i - 1]!;
    const b = boundary[i]!;
    if ((a.x <= r && b.x >= r) || (a.x >= r && b.x <= r)) {
      if (Math.abs(b.x - a.x) < 1e-12) return Math.max(a.z, b.z);
      return a.z + ((r - a.x) * (b.z - a.z)) / (b.x - a.x);
    }
  }
  return boundary[0]!.x >= r ? boundary[0]!.z : null;
}
