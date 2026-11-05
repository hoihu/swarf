/**
 * Arc fitting for the mill: runs of short feed moves that lie on a circle in XY (within `tol`),
 * with Z constant or changing evenly along it (a helix, as in ramps), become one G2/G3 arc. Imported drawings and offset outlines arrive as many short
 * lines; as arcs the program is much shorter and grblHAL moves smoothly instead of planning a
 * corner at every point.
 */
import type { Move } from './program.ts';
import type { Vec3 } from './schema.ts';

type Feed = Extract<Move, { type: 'feed' }>;

function circle(a: Vec3, b: Vec3, c: Vec3): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

const cross = (o: Vec3, a: Vec3, b: Vec3) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/**
 * Does the polyline pts[0..n] lie on one arc? Every point within tol of the circle, every chord
 * turning the same way, each chord short enough that its middle stays within tol too, and less
 * than a full turn in total.
 */
function fits(pts: Vec3[], tol: number, maxR: number): { x: number; y: number; r: number; cw: boolean } | null {
  if (pts.length < 4) return null;
  const c = circle(pts[0]!, pts[Math.floor(pts.length / 2)]!, pts.at(-1)!);
  if (!c || c.r > maxR || c.r < tol * 10) return null;
  const ctr = { x: c.x, y: c.y, z: 0 };
  const dir = Math.sign(cross(ctr, pts[0]!, pts[1]!));
  if (!dir) return null;
  let sweep = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - c.r) > tol) return null;
    if (i === 0) continue;
    const q = pts[i - 1]!;
    if (Math.sign(cross(ctr, q, p)) !== dir) return null;
    const chord = Math.hypot(p.x - q.x, p.y - q.y);
    if (c.r - Math.sqrt(Math.max(c.r * c.r - (chord / 2) ** 2, 0)) > tol) return null;
    sweep += 2 * Math.asin(Math.min(1, chord / (2 * c.r)));
  }
  if (sweep > 2 * Math.PI - 1e-3) return null;
  // Z must follow the angle evenly (flat, or a helix)
  const z0 = pts[0]!.z;
  const z1 = pts.at(-1)!.z;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i - 1]!;
    const p = pts[i]!;
    acc += 2 * Math.asin(Math.min(1, Math.hypot(p.x - q.x, p.y - q.y) / (2 * c.r)));
    if (Math.abs(z0 + ((z1 - z0) * acc) / sweep - p.z) > tol) return null;
  }
  return { ...c, cw: dir < 0 };
}

/** Replace runs of feed moves that lie on arcs. `from` is where the first move starts. */
export function fitArcs(moves: Move[], from: Vec3, tol = 0.005, maxR = 2000): Move[] {
  const out: Move[] = [];
  let at = from;
  let i = 0;
  while (i < moves.length) {
    const m = moves[i]!;
    // a run of feeds with one feed rate and some XY travel each
    const xy = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y) > 1e-9;
    if (m.type === 'feed' && xy(at, m.to)) {
      let j = i;
      const pts: Vec3[] = [at];
      while (j < moves.length) {
        const n = moves[j]! as Feed;
        if (n.type !== 'feed' || n.f !== m.f || !xy(pts.at(-1)!, n.to)) break;
        pts.push(n.to);
        j++;
      }
      // greedy: from each start, the longest arc that fits (binary search on the end, then confirm)
      let k = 0;
      while (k < pts.length - 1) {
        let best = -1;
        let arc: ReturnType<typeof fits> = null;
        let lo = k + 3;
        let hi = pts.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const f = fits(pts.slice(k, mid + 1), tol, maxR);
          if (f) {
            best = mid;
            arc = f;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        if (best > 0 && arc) {
          const end = pts[best]!;
          out.push({ type: 'arc', to: { ...end }, center: { x: arc.x, y: arc.y, z: end.z }, cw: arc.cw, f: m.f });
          k = best;
        } else {
          out.push({ type: 'feed', to: { ...pts[k + 1]! }, f: m.f });
          k++;
        }
      }
      at = pts.at(-1)!;
      i = j;
      continue;
    }
    out.push(m);
    at = m.to;
    i++;
  }
  return out;
}
