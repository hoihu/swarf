/**
 * 2.5D mill operations with a flat endmill (or a drill for holes). Climb milling with M3:
 * pockets and inside contours run counter-clockwise, outside contours clockwise.
 * Entry into each level is a ramp along the first pass (pockets, contours) or a helix (circular
 * pockets) at a shallow angle, or a straight plunge at the plunge feed if asked for (that needs a
 * centre-cutting endmill).
 */
import { CamError, levels, v, type Move } from '../program.ts';
import type { Operation } from '../schema.ts';
import { millSafeZ, type OpContext } from './context.ts';

type MillOp = Extract<Operation, { type: `mill_${string}` }>;

export function generateMill(op: MillOp, ctx: OpContext): Move[] {
  const { job, tool, cut } = ctx;
  if (job.stock.kind !== 'block') throw new CamError('mill operation needs block stock');
  const stock = job.stock;
  const safeZ = millSafeZ(job);
  const d = tool.diameter;
  if (!d) throw new CamError(`tool T${tool.id} has no diameter`);
  const r = d / 2;
  const out: Move[] = [];
  const rapid = (x: number, y: number, z: number) => out.push({ type: 'rapid', to: v(x, y, z) });
  const feed = (x: number, y: number, z: number, f = cut.feed) => out.push({ type: 'feed', to: v(x, y, z), f });
  const arc = (x: number, y: number, z: number, cx: number, cy: number, cw: boolean) =>
    out.push({ type: 'arc', to: v(x, y, z), center: v(cx, cy, z), cw, f: cut.feed });

  // up to the safe plane first
  rapid(ctx.from.x, ctx.from.y, Math.max(ctx.from.z, safeZ));
  /** Over (x, y) at the safe plane, then down to just above the material. */
  const approach = (x: number, y: number, zTop: number) => {
    rapid(x, y, safeZ);
    if (zTop + 1 < safeZ) rapid(x, y, zTop + 1);
  };
  const zTopOf = (o: { zTop?: number | undefined }) => o.zTop ?? stock.top;

  /**
   * From (ax, ay, zFrom) down to zTo, zigzagging along a→b at the ramp angle; ends at a.
   * Falls back to a plunge when the run is too short to ramp along.
   */
  const rampDown = (ax: number, ay: number, bx: number, by: number, zFrom: number, zTo: number, angle: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < r * 0.5) {
      feed(ax, ay, zTo, cut.plunge);
      return;
    }
    const drop = len * Math.tan((angle * Math.PI) / 180);
    let z = zFrom;
    let atA = true;
    while (z > zTo + 1e-9) {
      z = Math.max(zTo, z - drop);
      if (atA) feed(bx, by, z);
      else feed(ax, ay, z);
      atA = !atA;
    }
    if (!atA) feed(ax, ay, zTo);
  };

  /** Helix down around (cx, cy) with radius rh from zFrom to zTo, then one flat lap; ends at (cx + rh, cy). */
  const helixDown = (cx: number, cy: number, rh: number, zFrom: number, zTo: number, angle: number) => {
    const perHalf = Math.PI * rh * Math.tan((angle * Math.PI) / 180);
    feed(cx + rh, cy, zFrom, cut.plunge);
    let z = zFrom;
    let side = 1;
    while (z > zTo + 1e-9) {
      z = Math.max(zTo, z - perHalf);
      side = -side;
      arc(cx + side * rh, cy, z, cx, cy, false);
    }
    // flat lap at the bottom so the floor is clean, back on the +X side
    if (side < 0) arc(cx + rh, cy, zTo, cx, cy, false);
    arc(cx - rh, cy, zTo, cx, cy, false);
    arc(cx + rh, cy, zTo, cx, cy, false);
  };
  const stepOf = (o: { stepDown?: number | undefined }) => o.stepDown ?? tool.maxDoc ?? r;
  const checkDepth = (zTop: number, zBottom: number) => {
    if (zBottom >= zTop) throw new CamError(`zBottom ${zBottom} is not below the top ${zTop}`);
  };

  switch (op.type) {
    case 'mill_face': {
      const fromZ = op.fromZ ?? stock.top;
      if (op.z > fromZ + 1e-9) throw new CamError(`face Z${op.z} is above the material top Z${fromZ}`);
      const step = op.stepDown ?? Math.min(tool.maxDoc ?? 1, 1);
      const x0 = -r - ctx.c;
      const x1 = stock.x + r + ctx.c;
      const rows = [0, ...levels(0, stock.y, op.stepover * d)];
      rapid(x0, 0, safeZ);
      for (const zl of levels(fromZ, op.z, step)) {
        rapid(x0, 0, zl);
        rows.forEach((y, i) => {
          const [a, b] = i % 2 === 0 ? [x0, x1] : [x1, x0];
          if (i > 0) feed(a, y, zl);
          feed(b, y, zl);
        });
        const endX = rows.length % 2 === 1 ? x1 : x0;
        rapid(endX, stock.y, zl + 1);
        rapid(x0, 0, zl + 1);
      }
      rapid(x0, 0, safeZ);
      return out;
    }

    case 'mill_pocket_rect': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      if (op.w < d - 1e-9 || op.h < d - 1e-9) throw new CamError(`pocket ${op.w}×${op.h} is smaller than the Ø${d} tool`);
      const [x0, x1, y0, y1] = [op.x + r, op.x + op.w - r, op.y + r, op.y + op.h - r];
      const rows = y1 - y0 < 1e-9 ? [y0] : [y0, ...levels(y0, y1, op.stepover * d)];
      approach(x0, y0, zTop);
      // ramp along the first row, or up the side when the pocket is one tool wide
      const [bx, by] = x1 - x0 >= y1 - y0 ? [x1, y0] : [x0, y1];
      let zPrev = zTop + 0.2;
      feed(x0, y0, zPrev, cut.plunge);
      for (const zl of levels(zTop, op.zBottom, stepOf(op))) {
        if (op.entry === 'ramp') rampDown(x0, y0, bx, by, zPrev, zl, op.rampAngle);
        else feed(x0, y0, zl, cut.plunge);
        zPrev = zl;
        rows.forEach((y, i) => {
          const [a, b] = i % 2 === 0 ? [x0, x1] : [x1, x0];
          if (i > 0) feed(a, y, zl);
          feed(b, y, zl);
        });
        // finishing lap around the walls, counter-clockwise
        feed(x0, y0, zl);
        feed(x1, y0, zl);
        feed(x1, y1, zl);
        feed(x0, y1, zl);
        feed(x0, y0, zl);
      }
      rapid(x0, y0, safeZ);
      return out;
    }

    case 'mill_pocket_circle': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      const R = op.diameter / 2 - r;
      if (R < -1e-9) throw new CamError(`hole Ø${op.diameter} is smaller than the Ø${d} tool`);
      const rings = R < 1e-6 ? [] : levels(0, R, op.stepover * d);
      approach(op.cx, op.cy, zTop);
      // helix radius: inside the hole, small enough to stay near the centre
      const rh = Math.min(R, d * 0.35);
      const helix = op.entry === 'helix' && rh >= d * 0.1;
      let zPrev = zTop + 0.2;
      feed(op.cx, op.cy, zPrev, cut.plunge);
      for (const zl of levels(zTop, op.zBottom, stepOf(op))) {
        if (helix) {
          helixDown(op.cx, op.cy, rh, zPrev, zl, op.rampAngle);
          feed(op.cx, op.cy, zl);
        } else feed(op.cx, op.cy, zl, cut.plunge);
        zPrev = zl;
        for (const ri of rings) {
          feed(op.cx + ri, op.cy, zl);
          arc(op.cx - ri, op.cy, zl, op.cx, op.cy, false);
          arc(op.cx + ri, op.cy, zl, op.cx, op.cy, false);
        }
        if (rings.length) feed(op.cx, op.cy, zl);
      }
      rapid(op.cx, op.cy, safeZ);
      return out;
    }

    case 'mill_contour_rect': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      const o = op.side === 'outside' ? r : -r;
      const [x0, x1, y0, y1] = [op.x - o, op.x + op.w + o, op.y - o, op.y + op.h + o];
      if (x1 - x0 < -1e-9 || y1 - y0 < -1e-9) throw new CamError(`rectangle ${op.w}×${op.h} is smaller than the Ø${d} tool`);
      // outside: clockwise (up the left side first); inside: counter-clockwise
      const loop = op.side === 'outside'
        ? [[x0, y1], [x1, y1], [x1, y0], [x0, y0]]
        : [[x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      approach(x0, y0, zTop);
      let zPrev = zTop + 0.2;
      feed(x0, y0, zPrev, cut.plunge);
      const [fx, fy] = loop[0]!;
      for (const zl of levels(zTop, op.zBottom, stepOf(op))) {
        if (op.entry === 'ramp') rampDown(x0, y0, fx!, fy!, zPrev, zl, op.rampAngle);
        else feed(x0, y0, zl, cut.plunge);
        zPrev = zl;
        for (const [x, y] of loop) feed(x!, y!, zl);
      }
      rapid(x0, y0, safeZ);
      return out;
    }

    case 'mill_drill': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      const zIn = zTop + 1;
      for (const p of op.points) {
        rapid(p.x, p.y, safeZ);
        rapid(p.x, p.y, zIn);
        const peck = op.peck ?? zIn - op.zBottom;
        let at = zIn;
        while (at > op.zBottom + 1e-9) {
          const next = Math.max(op.zBottom, at - peck);
          feed(p.x, p.y, next, cut.plunge);
          if (next > op.zBottom + 1e-9) {
            rapid(p.x, p.y, zIn);
            rapid(p.x, p.y, next + 0.3);
          }
          at = next;
        }
        rapid(p.x, p.y, safeZ);
      }
      return out;
    }
  }
}
