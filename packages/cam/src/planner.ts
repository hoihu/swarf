/**
 * Cycle time the way grbl's planner sees it: every move accelerates and decelerates
 * (trapezoidal profile, one acceleration for all axes), and corners are taken at the junction
 * speed the junction-deviation rule allows. Forward and backward passes over the whole program,
 * as in grbl's planner_recalculate. Dwell and pauses (M0) are not counted.
 */
import { arcPoints, walk, type Program } from './program.ts';
import type { Vec3 } from './schema.ts';

export interface PlannerSettings {
  /** mm/s² */
  accel: number;
  /** mm (grbl $11) */
  junctionDeviation: number;
  /** mm/min */
  rapidRate: number;
}

interface Block {
  len: number;
  /** Unit direction. */
  dir: [number, number, number];
  /** Nominal speed, mm/s. */
  v: number;
  /** Highest entry speed allowed by the junction with the previous block. */
  vJunction: number;
  entry: number;
}

const unit = (a: Vec3, b: Vec3): [number, number, number] | null => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dy, dz);
  return l < 1e-9 ? null : [dx / l, dy / l, dz / l];
};

/** Lines the planner gets (arcs are segmented like grbl's mc_arc), with lathe X as written (radius here; the factor is the same for both axes). */
function blocks(p: Program, rapidRate: number): Block[] {
  const out: Block[] = [];
  const add = (a: Vec3, b: Vec3, feed: number) => {
    const d = unit(a, b);
    if (!d) return;
    out.push({ len: Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), dir: d, v: feed / 60, vJunction: 0, entry: 0 });
  };
  for (const { from, move } of walk(p)) {
    const f = move.type === 'rapid' ? rapidRate : move.f;
    if (move.type === 'arc') {
      let a = from;
      for (const q of arcPoints(from, move, 0.2)) {
        add(a, q, f);
        a = q;
      }
    } else add(from, move.to, f);
  }
  return out;
}

/** Seconds for one block with entry speed v0, exit v1, cruise vMax and acceleration a. */
function blockTime(len: number, v0: number, v1: number, vMax: number, a: number): number {
  // peak speed reachable in this length
  const vPeak = Math.sqrt((2 * a * len + v0 * v0 + v1 * v1) / 2);
  if (vPeak <= vMax) return (vPeak - v0) / a + (vPeak - v1) / a;
  const dAcc = (vMax * vMax - v0 * v0) / (2 * a);
  const dDec = (vMax * vMax - v1 * v1) / (2 * a);
  return (vMax - v0) / a + (vMax - v1) / a + (len - dAcc - dDec) / vMax;
}

export function plannedSeconds(p: Program, s: PlannerSettings): number {
  const a = s.accel;
  const bl = blocks(p, s.rapidRate);
  // junction speeds (grbl: v² = a · δ · sin(θ/2) / (1 − sin(θ/2)))
  for (let i = 1; i < bl.length; i++) {
    const prev = bl[i - 1]!.dir;
    const cur = bl[i]!.dir;
    const cos = -(prev[0] * cur[0] + prev[1] * cur[1] + prev[2] * cur[2]);
    let vj: number;
    if (cos > 0.999999) vj = 0; // reversal
    else if (cos < -0.999999) vj = Infinity; // straight on
    else {
      const sinHalf = Math.sqrt((1 - cos) / 2);
      vj = Math.sqrt((a * s.junctionDeviation * sinHalf) / (1 - sinHalf));
    }
    bl[i]!.vJunction = Math.min(vj, bl[i]!.v, bl[i - 1]!.v);
  }
  // backward pass: each block must be able to slow down to the next one's entry (0 at the end)
  let next = 0;
  for (let i = bl.length - 1; i >= 0; i--) {
    const b = bl[i]!;
    b.entry = Math.min(b.vJunction, Math.sqrt(next * next + 2 * a * b.len));
    next = b.entry;
  }
  // forward pass: and to speed up from its own entry
  for (let i = 0; i < bl.length - 1; i++) {
    const b = bl[i]!;
    const n = bl[i + 1]!;
    n.entry = Math.min(n.entry, Math.sqrt(b.entry * b.entry + 2 * a * b.len));
  }
  let t = 0;
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i]!;
    const exit = i + 1 < bl.length ? bl[i + 1]!.entry : 0;
    t += blockTime(b.len, b.entry, exit, b.v, a);
  }
  return t;
}

/** One segment of a program as the review and the setup sheet see it. */
export interface SegmentStats {
  seconds: number;
  /** Fastest cutting feed, mm/min (0: no cut). */
  feed: number;
  /** Lowest Z and X of the cutting moves (arcs followed); Infinity when it does not cut. */
  zMin: number;
  xMin: number;
  cuts: boolean;
  /** The box round all its moves, rapids too (null: no moves). */
  box: { min: Vec3; max: Vec3 } | null;
}

/** Time, fastest feed, deepest point and extent of each segment, in order. */
export function segmentStats(p: Program, s: PlannerSettings): SegmentStats[] {
  let at = p.home;
  return p.segments.map((seg) => {
    const g: SegmentStats = { seconds: plannedSeconds({ ...p, home: at, segments: [seg] }, s), feed: 0, zMin: Infinity, xMin: Infinity, cuts: false, box: null };
    for (const m of seg.moves) {
      const pts = m.type === 'arc' ? arcPoints(at, m, 0.5) : [m.to];
      for (const q of pts) {
        const b = g.box;
        g.box = b
          ? { min: { x: Math.min(b.min.x, q.x), y: Math.min(b.min.y, q.y), z: Math.min(b.min.z, q.z) }, max: { x: Math.max(b.max.x, q.x), y: Math.max(b.max.y, q.y), z: Math.max(b.max.z, q.z) } }
          : { min: { ...q }, max: { ...q } };
      }
      if (m.type !== 'rapid') {
        g.cuts = true;
        g.feed = Math.max(g.feed, m.f);
        for (const q of pts) {
          g.zMin = Math.min(g.zMin, q.z);
          g.xMin = Math.min(g.xMin, q.x);
        }
      }
      at = m.to;
    }
    return g;
  });
}
