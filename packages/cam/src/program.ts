/**
 * The toolpath IR every operation generates and every consumer reads (G-code emitter, checks,
 * material model, 3D preview). Lathe moves use x = radius, y = 0.
 */
import type { MachineKind, Vec3 } from './schema.ts';

export type Move =
  | { type: 'rapid'; to: Vec3 }
  | { type: 'feed'; to: Vec3; f: number }
  /**
   * Arc in the XY plane (G17, mill) or the ZX plane (G18, lathe); `center` is absolute. `cw` is
   * G2: clockwise in the plane's own axes (X→Y for XY, Z→X for ZX, as G-code defines them).
   */
  | { type: 'arc'; to: Vec3; center: Vec3; cw: boolean; f: number; plane?: Plane }
  /** Spindle-synchronised move along Z (G33), `pitch` mm per revolution; `f` is the resulting mm/min, for timing. */
  | { type: 'thread'; to: Vec3; pitch: number; f: number };

export type Plane = 'xy' | 'zx';

/** The plane's first and second axis and the one along it (G17: X Y, Z; G18: Z X, Y). */
export const PLANE_AXES: Record<Plane, [keyof Vec3, keyof Vec3, keyof Vec3]> = { xy: ['x', 'y', 'z'], zx: ['z', 'x', 'y'] };

/** A point in the plane's own frame (x, y = first and second axis, z = the axis along it), and back. */
export function toPlane(p: Vec3, plane: Plane = 'xy'): Vec3 {
  const [a, b, c] = PLANE_AXES[plane];
  return { x: p[a], y: p[b], z: p[c] };
}
export function fromPlane(q: Vec3, plane: Plane = 'xy'): Vec3 {
  const [a, b, c] = PLANE_AXES[plane];
  const p = { x: 0, y: 0, z: 0 };
  p[a] = q.x;
  p[b] = q.y;
  p[c] = q.z;
  return p;
}

export interface Segment {
  opId: string;
  label: string;
  tool: number;
  rpm: number;
  /** Start position of the first move is the end of the previous segment (or Program.home). */
  moves: Move[];
}

export interface Program {
  kind: MachineKind;
  /** Where the tool waits before and after the program. */
  home: Vec3;
  segments: Segment[];
}

export class CamError extends Error {}

export const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Equal steps from `from` to `to` (inclusive of `to`), none larger than `step`. */
export function levels(from: number, to: number, step: number): number[] {
  const span = Math.abs(from - to);
  if (span < 1e-9) return [to];
  const n = Math.max(1, Math.ceil(span / step - 1e-9));
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(from + ((to - from) * i) / n);
  return out;
}

/** Points along an arc, for preview and sampling (end point included, start excluded). */
export function arcPoints(from3: Vec3, m3: Extract<Move, { type: 'arc' }>, maxSeg = 0.5): Vec3[] {
  const plane = m3.plane ?? 'xy';
  // worked out in the plane's own frame, where G2 is clockwise
  const from = toPlane(from3, plane);
  const m = { ...m3, to: toPlane(m3.to, plane), center: toPlane(m3.center, plane) };
  const r = Math.hypot(from.x - m.center.x, from.y - m.center.y);
  let a0 = Math.atan2(from.y - m.center.y, from.x - m.center.x);
  let a1 = Math.atan2(m.to.y - m.center.y, m.to.x - m.center.x);
  if (m.cw) {
    if (a1 >= a0 - 1e-9) a1 -= 2 * Math.PI;
  } else if (a1 <= a0 + 1e-9) a1 += 2 * Math.PI;
  const sweep = a1 - a0;
  const n = Math.max(2, Math.ceil((Math.abs(sweep) * Math.max(r, 1e-6)) / maxSeg));
  const pts: Vec3[] = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    const t = i / n;
    pts.push(fromPlane({ x: m.center.x + r * Math.cos(a), y: m.center.y + r * Math.sin(a), z: from.z + (m.to.z - from.z) * t }, plane));
  }
  // land exactly on the end point
  pts[pts.length - 1] = { ...m3.to };
  return pts;
}

/** Every move of the program in order, with its start point and segment index. */
export function* walk(p: Program): Generator<{ seg: number; index: number; from: Vec3; move: Move }> {
  let at = p.home;
  let index = 0;
  for (let s = 0; s < p.segments.length; s++) {
    for (const move of p.segments[s]!.moves) {
      yield { seg: s, index: index++, from: at, move };
      at = move.to;
    }
  }
}

export function moveLength(from: Vec3, m: Move): number {
  if (m.type !== 'arc') return Math.hypot(m.to.x - from.x, m.to.y - from.y, m.to.z - from.z);
  let len = 0;
  let a = from;
  for (const p of arcPoints(from, m)) {
    len += Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
    a = p;
  }
  return len;
}

/** Cycle time in seconds: path length over feed (rapids at the machine's rapid rate). No acceleration model yet. */
export function estimateSeconds(p: Program, rapidRate: number): number {
  let min = 0;
  for (const { from, move } of walk(p)) {
    const len = moveLength(from, move);
    min += len / (move.type === 'rapid' ? rapidRate : move.f);
  }
  return min * 60;
}
