/**
 * The toolpath as the machine must run it for the block as it was measured (mill): turned about
 * X0 Y0 by the angle the block sits at, and, for operations that follow the top, raised and
 * lowered with the touched surface. The checks and the preview work on the block as drawn; this
 * is applied when the G-code is written.
 */
import { withIds, type Diagnostic } from './generate.ts';
import { arcPoints, type Move, type Program } from './program.ts';
import type { Job, Vec3 } from './schema.ts';

type P3 = { x: number; y: number; z: number };

/**
 * The touched top as a surface: a plane through the points (least squares) plus what each point
 * is off it, spread to its surroundings by inverse distance (to the fourth power). Exact at the points, the
 * plane far from them. Null with fewer than three points (or all on one line).
 */
export function surfaceAt(points: P3[]): ((x: number, y: number) => number) | null {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (const p of points) {
    sx += p.x; sy += p.y; sz += p.z;
    sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sxz += p.x * p.z; syz += p.y * p.z;
  }
  // centred normal equations
  const mx = sx / n, my = sy / n, mz = sz / n;
  const cxx = sxx - n * mx * mx, cyy = syy - n * my * my, cxy = sxy - n * mx * my;
  const cxz = sxz - n * mx * mz, cyz = syz - n * my * mz;
  const det = cxx * cyy - cxy * cxy;
  if (Math.abs(det) < 1e-9 * Math.max(1, cxx * cyy)) return null;
  const b = (cxz * cyy - cyz * cxy) / det;
  const c = (cyz * cxx - cxz * cxy) / det;
  const plane = (x: number, y: number) => mz + b * (x - mx) + c * (y - my);
  const off = points.map((p) => p.z - plane(p.x, p.y));
  return (x, y) => {
    let w = 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d2 = (points[i]!.x - x) ** 2 + (points[i]!.y - y) ** 2;
      if (d2 < 1e-12) return points[i]!.z;
      // (the fourth power of the distance: the nearest points count, the far ones hardly)
      w += 1 / (d2 * d2);
      s += off[i]! / (d2 * d2);
    }
    return plane(x, y) + s / w;
  };
}

/** The operations that follow the top (with the ids the generator gives them). */
const followOps = (job: Job) => withIds(job.operations).filter((o) => 'follow' in o && o.follow);
const followed = (job: Job): Set<string> => new Set(followOps(job).map((o) => o.id ?? ''));

/** Is anything measured applied to this job's G-code? */
export function isAligned(job: Job): boolean {
  const m = job.measured;
  if (!m || job.machine.kind !== 'mill') return false;
  return Math.abs(m.angle) > 1e-9 || (followed(job).size > 0 && surfaceAt(m.top) !== null);
}

/** In a few words, what is applied (for the G-code's head, the setup sheet, the panel). */
export function alignmentLines(job: Job): string[] {
  const m = job.measured;
  if (!m || job.machine.kind !== 'mill') return [];
  const out: string[] = [];
  if (Math.abs(m.angle) > 1e-9) out.push(`toolpath turned ${m.angle.toFixed(2)} deg about X0 Y0, as the block was measured`);
  const f = followed(job);
  if (f.size && surfaceAt(m.top)) out.push(`${[...f].join(', ')} follow${f.size === 1 ? 's' : ''} the top as touched at ${m.top.length} points`);
  return out;
}

/** The program for the block as measured. The same segments; followed cuts come in short pieces. */
export function alignProgram(job: Job, program: Program, step = 1): Program {
  return alignPieces(job, program, step).program;
}

/** As alignProgram, and into how many moves each of the drawn program's moves went (null: one each). */
export function alignPieces(job: Job, program: Program, step = 1): { program: Program; pieces: number[] | null } {
  const m = job.measured;
  if (!m || program.kind !== 'mill' || !isAligned(job)) return { program, pieces: null };
  const pieces: number[] = [];
  const a = (m.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const turn = (p: Vec3): Vec3 => (a === 0 ? p : { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos, z: p.z });
  const surface = surfaceAt(m.top);
  const ref = job.stock.kind === 'block' ? job.stock.top : 0;
  const follow = followed(job);
  // the surface was touched in the machine's (turned) frame: look it up where the tool really is
  const lift = (p: Vec3): Vec3 => {
    const q = turn(p);
    return { ...q, z: q.z + surface!(q.x, q.y) - ref };
  };

  let at = program.home;
  const segments = program.segments.map((seg) => {
    const fol = surface !== null && follow.has(seg.opId);
    const moves: Move[] = [];
    for (const mv of seg.moves) {
      const from = at;
      at = mv.to;
      if (!fol || mv.type === 'rapid') {
        if (mv.type === 'arc') moves.push({ ...mv, to: turn(mv.to), center: turn(mv.center) });
        else moves.push({ ...mv, to: turn(mv.to) });
        pieces.push(1);
        continue;
      }
      // a cut that follows the top: in pieces no longer than `step`, each at its own height
      const pts: Vec3[] = [];
      if (mv.type === 'arc') pts.push(...arcPoints(from, mv, Math.min(step, 0.5)));
      else {
        const len = Math.hypot(mv.to.x - from.x, mv.to.y - from.y);
        const k = Math.max(1, Math.ceil(len / step));
        for (let i = 1; i <= k; i++) pts.push({ x: from.x + ((mv.to.x - from.x) * i) / k, y: from.y + ((mv.to.y - from.y) * i) / k, z: from.z + ((mv.to.z - from.z) * i) / k });
      }
      for (const q of pts) moves.push({ type: 'feed', to: lift(q), f: mv.f });
      pieces.push(pts.length);
    }
    return { ...seg, moves };
  });
  return { program: { ...program, home: turn(program.home), segments }, pieces };
}

/** What the checks should say about measured things being applied (they ran on the block as drawn). */
export function alignmentChecks(job: Job, program: Program): Diagnostic[] {
  const out: Diagnostic[] = [];
  const m = job.measured;
  if (job.machine.kind !== 'mill' || job.stock.kind !== 'block') return out;
  const follow = followOps(job);
  const surface = m ? surfaceAt(m.top) : null;
  for (const o of follow) {
    if (!surface) out.push({ severity: 'warning', code: 'FOLLOW_NO_TOP', message: 'This operation is to follow the measured top, but no top is kept with the job: touch the top at the machine (Setting up, "Check the top") and keep it. Until then it is cut as if the top were flat.', opId: o.id });
  }
  if (!m) return out;
  if (surface && follow.length) {
    const ids = new Set(follow.map((o) => o.id));
    const xs = m.top.map((p) => p.x);
    const ys = m.top.map((p) => p.y);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    const far = new Map<string, number>();
    let hi = -Infinity;
    for (const seg of program.segments) {
      if (!ids.has(seg.opId)) continue;
      for (const mv of seg.moves) {
        if (mv.type === 'rapid') continue;
        const d = Math.max(box.x0 - mv.to.x, mv.to.x - box.x1, box.y0 - mv.to.y, mv.to.y - box.y1, 0);
        if (d > (far.get(seg.opId) ?? 0)) far.set(seg.opId, d);
        hi = Math.max(hi, surface(mv.to.x, mv.to.y) - job.stock.top);
      }
    }
    for (const [opId, d] of far) {
      if (d > 10) out.push({ severity: 'warning', code: 'FOLLOW_OUTSIDE', message: `This operation cuts up to ${d.toFixed(0)} mm outside the area that was touched: there the top is only guessed from its slope. Touch the top again over the whole area.`, opId });
    }
    if (hi > job.machine.clearance - 0.5) out.push({ severity: 'error', code: 'FOLLOW_HIGH', message: `The top as touched stands ${hi.toFixed(2)} mm above where the job has it; the tool travels only ${job.machine.clearance} mm above that. Set the Z zero on the top again (or raise the clearance in the machine settings).` });
  }
  if (Math.abs(m.angle) > 1e-9) {
    let r = 0;
    let at = program.home;
    for (const seg of program.segments) for (const mv of seg.moves) { r = Math.max(r, Math.hypot(at.x, at.y), Math.hypot(mv.to.x, mv.to.y)); at = mv.to; }
    const shift = r * Math.abs((m.angle * Math.PI) / 180);
    if (shift > 0.5) out.push({ severity: 'warning', code: 'TURNED', message: `The G-code is turned ${m.angle.toFixed(2)}° with the block as measured: moves land up to ${shift.toFixed(1)} mm from where the checks and the preview have them. Clamps and travel limits were checked for the block as drawn; keep that much to spare.` });
  }
  return out;
}
