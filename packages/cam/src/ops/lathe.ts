/**
 * Lathe operations (2 axes, X = radius, Z along the spindle). Tools cut towards the chuck
 * (-Z) and face towards the centre. Rapids only happen above the bar (x > stock radius),
 * in front of its face, or inside material this operation has already removed.
 * Tool nose radius compensation is not applied yet (tier 2).
 */
import { CamError, levels, v, type Move } from '../program.ts';
import type { Job, Operation } from '../schema.ts';
import { latheSafe, type OpContext } from './context.ts';
import { buildProfile, tipPath, zAtRadius, type P2 } from './profile.ts';
import { profileFromDrawing } from '../importers/lathe.ts';

type LatheOp = Extract<Operation, { type: `lathe_${string}` }>;

const rapid = (x: number, z: number): Move => ({ type: 'rapid', to: v(x, 0, z) });
const v3 = (x: number, z: number) => v(x, 0, z);

/** The workpiece diameter that sets the spindle speed (largest one the operation cuts). */
export function latheSpeedDiameter(op: LatheOp, job: Job, toolDiameter?: number): number {
  const stockD = job.stock.kind === 'bar' ? job.stock.diameter : 0;
  switch (op.type) {
    case 'lathe_drill':
      return toolDiameter ?? 5;
    case 'lathe_chamfer':
    case 'lathe_thread':
    case 'lathe_bore':
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

    case 'lathe_profile': {
      const fromR = (op.fromDiameter ?? safe.r * 2) / 2;
      let pts = op.points;
      if (op.shape) {
        const sh = ctx.job.shapes.find((x) => x.id === op.shape);
        if (!sh) throw new CamError(`there is no drawing ${op.shape}${ctx.job.shapes.length ? ` (drawings: ${ctx.job.shapes.map((x) => x.id).join(', ')})` : '; import a DXF or SVG first'}`);
        pts = profileFromDrawing(sh, op.face).points;
      }
      if (!pts) throw new CamError('give the profile points or a drawing (shape)');
      const outline = buildProfile(pts);
      if (Math.max(...outline.map((p) => p.x)) > fromR + 1e-9) throw new CamError(`the profile is larger than the material Ø${fromR * 2}`);
      const rn = ctx.tool.noseRadius ?? 0;
      const zs = outline[0]!.z + ctx.c;
      // lead in from the front, and end on the shoulder up to the material, so the offsets
      // (nose radius, allowance) are right at both ends
      const last0 = outline.at(-1)!;
      const profile = [{ x: outline[0]!.x, z: zs }, ...outline, ...(last0.x < fromR - 1e-9 ? [{ x: fromR, z: last0.z }] : [])];
      const rough = tipPath(profile, rn, op.finish);
      const finish = tipPath(profile, rn, 0);
      const doc = op.doc ?? ctx.tool.maxDoc ?? 1;
      const minX = Math.min(...rough.map((p) => p.x));
      const zLast = last0.z;
      // roughing: axial passes, each stopping where the allowance-offset profile is reached
      let did = false;
      if (minX < fromR - 1e-9) {
        for (const rp of levels(fromR, Math.max(minX, 0), doc)) {
          const zEnd = zAtRadius(rough, rp) ?? zLast;
          if (zEnd >= zs - ctx.c - 1e-6) continue; // nothing to cut at this radius
          out.push(rapid(safe.x, zs), rapid(rp, zs));
          out.push(f(rp, zEnd));
          out.push(f(rp + 0.5, zEnd + 0.5));
          out.push(rapid(rp + 0.5, zs));
          did = true;
        }
      }
      const follow = (path: P2[]) => {
        const first = path[0]!;
        out.push(rapid(safe.x, Math.max(first.z, zs)), rapid(Math.max(first.x, 0), Math.max(first.z, zs)));
        for (const p of path.slice(1)) out.push(f(Math.max(p.x, 0), p.z));
        // clear of the material at the end of the shoulder
        const last = path.at(-1)!;
        if (last.x < fromR + 0.5) out.push(f(fromR + 0.5, last.z));
        retract(last.z);
      };
      if (did && op.finish > 0) follow(rough); // semi-finish: takes the roughing steps off evenly
      follow(finish);
      return out;
    }

    case 'lathe_chamfer': {
      const r = op.diameter / 2;
      const s = op.size;
      if (s >= r) throw new CamError(`chamfer ${s} mm is larger than the radius`);
      // The path is for the imaginary tool tip (touched off on diameter and face). On a 45° line
      // the round nose would leave the chamfer short by rn·(2 − √2) on each leg: lengthen both.
      const rn = ctx.tool.noseRadius ?? 0;
      const e = rn * (2 - Math.SQRT2);
      out.push(rapid(safe.x, op.z + ctx.c), rapid(r - s - e, op.z + ctx.c));
      out.push(f(r - s - e, op.z, plunge));
      out.push(f(r, op.z - s - e));
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

    case 'lathe_bore': {
      // Boring: axial passes inside the hole, each cutting outwards by `doc`, then a finishing
      // pass to size that also cleans the bottom shoulder. Retracts go towards the axis.
      const R = op.diameter / 2;
      const r0 = op.fromDiameter / 2;
      if (R <= r0) throw new CamError(`bore Ø${op.diameter} is not larger than the hole Ø${op.fromDiameter}`);
      if (op.zEnd >= op.zStart) throw new CamError('zEnd must be below zStart (more negative)');
      if (ctx.tool.diameter && op.fromDiameter < ctx.tool.diameter - 1e-9) throw new CamError(`T${ctx.tool.id} needs a hole of at least Ø${ctx.tool.diameter}; this one is Ø${op.fromDiameter}`);
      if (ctx.tool.fluteLength && op.zStart - op.zEnd > ctx.tool.fluteLength + 1e-9) throw new CamError(`the bore is ${op.zStart - op.zEnd} mm deep; T${ctx.tool.id} reaches ${ctx.tool.fluteLength} mm`);
      const zs = Math.max(op.zStart, safe.front) + ctx.c;
      const zBottom = op.zEnd;
      const doc = op.doc ?? ctx.tool.maxDoc ?? 0.5;
      let prev = r0;
      for (const rp of R - op.finish > r0 + 1e-9 ? levels(r0, R - op.finish, doc) : []) {
        out.push(rapid(safe.x, zs), rapid(Math.max(prev - 0.5, 0), zs), rapid(rp, zs));
        out.push(f(rp, zBottom + op.finish));
        out.push(f(rp - 0.3, zBottom + op.finish + 0.3));
        out.push(rapid(rp - 0.3, zs));
        prev = rp;
      }
      // finish: down the wall, across the bottom shoulder to the hole, out
      out.push(rapid(safe.x, zs), rapid(Math.max(prev - 0.5, 0), zs), rapid(R, zs));
      out.push(f(R, zBottom));
      out.push(f(Math.max(r0 - 0.2, 0), zBottom));
      out.push(f(Math.max(r0 - 0.4, 0), zBottom + 0.2));
      out.push(rapid(Math.max(r0 - 0.4, 0), zs));
      retract(zs);
      return out;
    }

    case 'lathe_thread': {
      // Thread as G33 passes. Depths follow constant chip area (d·√(i/n)), so the first pass is
      // `firstCut` deep and later ones shallower; spring passes repeat full depth. External threads
      // cut inwards from the major diameter, internal ones outwards from the minor diameter.
      const internal = op.side === 'internal';
      const R = op.diameter / 2;
      const depth = op.depth ?? (internal ? 0.54127 : 0.61343) * op.pitch;
      if (op.zEnd >= op.zStart) throw new CamError('zEnd must be towards the chuck from zStart (more negative)');
      if (depth >= R) throw new CamError(`thread depth ${depth.toFixed(2)} mm is more than the radius`);
      if (internal !== !!ctx.tool.internal) throw new CamError(`T${ctx.tool.id} is an ${ctx.tool.internal ? 'internal' : 'external'} threading tool; this thread is ${op.side}`);
      const rMinor = R - depth;
      if (internal && ctx.tool.diameter && rMinor * 2 < ctx.tool.diameter - 1e-9) throw new CamError(`T${ctx.tool.id} needs a bore of at least Ø${ctx.tool.diameter}; the minor diameter is Ø${(rMinor * 2).toFixed(2)}`);
      if (internal && ctx.tool.fluteLength && op.zStart - op.zEnd > ctx.tool.fluteLength + 1e-9) throw new CamError(`the thread is ${op.zStart - op.zEnd} mm deep; T${ctx.tool.id} reaches ${ctx.tool.fluteLength} mm`);
      const n = Math.min(30, Math.max(3, Math.ceil((depth / op.firstCut) ** 2)));
      const depths = Array.from({ length: n }, (_, i) => depth * Math.sqrt((i + 1) / n));
      for (let k = 0; k < op.springPasses; k++) depths.push(depth);
      // grblHAL does not correct the sync while Z accelerates: start far enough out to be at speed
      const v = (op.pitch * ctx.cut.rpm) / 60;
      const accelDist = (v * v) / (2 * ctx.job.machine.accel);
      const leadIn = Math.max(3 * op.pitch, 1.5 * accelDist + 1);
      const flank = op.infeed === 'flank' ? Math.tan((29.5 * Math.PI) / 180) : 0;
      // where the tool waits between passes: outside the thread, or near the axis for an internal one
      const rOut = internal ? Math.max(rMinor - ctx.c / 2, 0) : R + ctx.c / 2;
      for (const d of depths) {
        const zs = op.zStart + leadIn - d * flank;
        const x = internal ? rMinor + d : R - d;
        out.push(rapid(safe.x, zs), rapid(rOut, zs), rapid(x, zs));
        out.push({ type: 'thread', to: v3(x, op.zEnd), pitch: op.pitch, f: op.pitch * ctx.cut.rpm });
        out.push(rapid(rOut, op.zEnd), rapid(rOut, zs));
      }
      retract(op.zStart + leadIn);
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
