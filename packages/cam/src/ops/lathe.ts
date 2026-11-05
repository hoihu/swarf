/**
 * Lathe operations (2 axes, X = radius, Z along the spindle). Tools cut towards the chuck
 * (-Z) and face towards the centre. Rapids only happen above the bar (x > stock radius),
 * in front of its face, or inside material this operation has already removed.
 * Tool nose radius compensation is not applied yet (tier 2).
 */
import { CamError, levels, v, type Move } from '../program.ts';
import type { Job, Operation } from '../schema.ts';
import { latheSafe, type OpContext } from './context.ts';

type LatheOp = Extract<Operation, { type: `lathe_${string}` }>;

const rapid = (x: number, z: number): Move => ({ type: 'rapid', to: v(x, 0, z) });

/** The workpiece diameter that sets the spindle speed (largest one the operation cuts). */
export function latheSpeedDiameter(op: LatheOp, job: Job, toolDiameter?: number): number {
  const stockD = job.stock.kind === 'bar' ? job.stock.diameter : 0;
  switch (op.type) {
    case 'lathe_drill':
      return toolDiameter ?? 5;
    case 'lathe_chamfer':
      return op.diameter;
    default:
      return op.fromDiameter ?? stockD;
  }
}

export function generateLathe(op: LatheOp, ctx: OpContext): Move[] {
  const safe = latheSafe(ctx.job);
  const { feed, plunge } = ctx.cut;
  const f = (x: number, z: number, fr = feed): Move => ({ type: 'feed', to: v(x, 0, z), f: fr });
  // leave the previous position: out above the bar first, then to the safe corner
  const out: Move[] = [rapid(Math.max(ctx.from.x, safe.x), ctx.from.z), rapid(safe.x, safe.z)];
  /** Out above the bar at this Z, then back to the safe corner. */
  const retract = (z: number) => out.push(rapid(safe.x, z), rapid(safe.x, safe.z));

  switch (op.type) {
    case 'lathe_face': {
      const fromR = (op.fromDiameter ?? safe.r * 2) / 2;
      const fromZ = op.fromZ ?? safe.front;
      if (op.z > fromZ + 1e-9) throw new CamError(`face Z${op.z} is in front of the material face Z${fromZ}`);
      const step = op.stepDown ?? Math.min(ctx.tool.maxDoc ?? 1, 1);
      let lastZ = fromZ;
      for (const zp of levels(fromZ, op.z, step)) {
        out.push(rapid(safe.x, zp), rapid(fromR + ctx.c / 2, zp));
        out.push(f(0, zp));
        out.push(f(0, zp + 0.5, plunge));
        out.push(rapid(fromR + ctx.c / 2, zp + 0.5));
        lastZ = zp;
      }
      retract(lastZ + 0.5);
      return out;
    }

    case 'lathe_turn': {
      const fromR = (op.fromDiameter ?? safe.r * 2) / 2;
      const r = op.diameter / 2;
      if (r > fromR + 1e-9) throw new CamError(`target Ø${op.diameter} is larger than the material Ø${fromR * 2}`);
      if (op.zEnd >= op.zStart) throw new CamError('zEnd must be towards the chuck from zStart (more negative)');
      const doc = op.doc ?? ctx.tool.maxDoc ?? 1;
      const zs = op.zStart + ctx.c;
      const roughTo = r + op.finish;
      let prev = fromR;
      if (roughTo < fromR - 1e-9) {
        for (const rp of levels(fromR, roughTo, doc)) {
          out.push(rapid(safe.x, zs), rapid(rp, zs));
          out.push(f(rp, op.zEnd));
          out.push(f(rp + 0.5, op.zEnd + 0.5));
          out.push(rapid(rp + 0.5, zs));
          prev = rp;
        }
      }
      // finishing pass: along the diameter, then up the shoulder
      out.push(rapid(safe.x, zs), rapid(r, zs));
      out.push(f(r, op.zEnd));
      out.push(f(Math.max(prev, fromR), op.zEnd));
      out.push(f(fromR + 0.5, op.zEnd + 0.5));
      retract(op.zEnd + 0.5);
      return out;
    }

    case 'lathe_chamfer': {
      const r = op.diameter / 2;
      const s = op.size;
      if (s >= r) throw new CamError(`chamfer ${s} mm is larger than the radius`);
      out.push(rapid(safe.x, op.z + ctx.c), rapid(r - s, op.z + ctx.c));
      out.push(f(r - s, op.z, plunge));
      out.push(f(r, op.z - s));
      out.push(f(r + ctx.c / 2, op.z - s));
      retract(op.z - s);
      return out;
    }

    case 'lathe_groove':
    case 'lathe_partoff': {
      const w = ctx.tool.width;
      if (!w) throw new CamError(`tool T${ctx.tool.id} has no blade width`);
      const fromR = (op.fromDiameter ?? safe.r * 2) / 2;
      const bottom = (op.type === 'lathe_groove' ? op.diameter : op.toDiameter) / 2;
      const width = op.type === 'lathe_groove' ? op.width : w;
      if (width < w - 1e-9) throw new CamError(`groove ${width} mm is narrower than the ${w} mm blade`);
      if (bottom >= fromR) throw new CamError('groove bottom is not below the material');
      const lastRef = op.z - width + w;
      const refs = width - w < 1e-9 ? [op.z] : [op.z, ...levels(op.z, lastRef, w * 0.8)];
      const start = fromR + 0.5;
      for (const zr of refs) {
        out.push(rapid(safe.x, zr), rapid(start, zr));
        if (op.peck) {
          let at = start;
          while (at > bottom + 1e-9) {
            const next = Math.max(bottom, at - op.peck);
            out.push(f(next, zr));
            if (next > bottom + 1e-9) out.push(rapid(next + 0.3, zr), rapid(next + 0.05, zr));
            at = next;
          }
        } else out.push(f(bottom, zr));
        out.push(rapid(start, zr));
      }
      retract(refs.at(-1)!);
      return out;
    }

    case 'lathe_drill': {
      const zIn = safe.front + 0.5;
      const target = -op.depth;
      out.push(rapid(0, safe.z), rapid(0, zIn));
      const peck = op.peck ?? op.depth + safe.front;
      let at = zIn;
      while (at > target + 1e-9) {
        const next = Math.max(target, at - peck);
        out.push(f(0, next));
        if (next > target + 1e-9) out.push(rapid(0, zIn), rapid(0, next + 0.3));
        at = next;
      }
      out.push(rapid(0, safe.z));
      return out;
    }
  }
}
