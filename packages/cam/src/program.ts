/**
 * The toolpath IR every operation generates and every consumer reads (G-code emitter, checks,
 * material model, 3D preview). Lathe moves use x = radius, y = 0.
 */
import type { MachineKind, Vec3 } from './schema.ts';

export type Move =
  | { type: 'rapid'; to: Vec3 }
  | { type: 'feed'; to: Vec3; f: number }
  /** Arc in the XY plane (mill only); `center` is absolute. */
  | { type: 'arc'; to: Vec3; center: Vec3; cw: boolean; f: number };

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
export function arcPoints(from: Vec3, m: Extract<Move, { type: 'arc' }>, maxSeg = 0.5): Vec3[] {
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
    pts.push({ x: m.center.x + r * Math.cos(a), y: m.center.y + r * Math.sin(a), z: from.z + (m.to.z - from.z) * t });
  }
  // land exactly on the end point
  pts[pts.length - 1] = { ...m.to };
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
