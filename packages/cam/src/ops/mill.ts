/**
 * 2.5D mill operations with a flat endmill (or a drill for holes). Climb milling with M3:
 * pockets and inside contours run counter-clockwise, outside contours clockwise.
 * Entry into each level is a ramp along the first pass (pockets, contours) or a helix (circular
 * pockets) at a shallow angle, or a straight plunge at the plunge feed if asked for (that needs a
 * centre-cutting endmill).
 */
import { CamError, levels, v, type Move } from '../program.ts';
import type { Operation, Shape } from '../schema.ts';
import { dedupe, offsetRegion, orient, type Loop, type Pt } from '../geom2d.ts';
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

  /**
   * One closed loop cut down to `zl` from `zFrom`, starting and ending at loop[0]: a ramp along the
   * path itself (like a helix following the outline) until the level is reached, then one full lap
   * at the level so the ramp is cleaned up. Over holding tabs the tool stays at the tab top.
   */
  const cutLoop = (loop: Loop, zFrom: number, zl: number, o: { ramp: boolean; angle: number; tabs?: [number, number][]; zTab?: number }) => {
    const pts: Pt[] = [...loop, loop[0]!];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
    const per = cum.at(-1)!;
    if (per < 1e-6) return;
    const slope = Math.tan((o.angle * Math.PI) / 180);
    const rampLen = o.ramp && per > r * 0.5 ? (zFrom - zl) / slope : 0;
    if (!rampLen) feed(loop[0]![0], loop[0]![1], zl, cut.plunge);
    // at least one full lap at depth after the ramp, ending back at the start point
    const total = Math.ceil((rampLen + per) / per - 1e-9) * per;
    const tabs = o.tabs && o.zTab !== undefined && zl < o.zTab - 1e-9 ? o.tabs : [];
    const posAt = (s: number): Pt => {
      const u = ((s % per) + per) % per;
      let i = 1;
      while (i < cum.length - 1 && cum[i]! < u) i++;
      const t = (u - cum[i - 1]!) / Math.max(cum[i]! - cum[i - 1]!, 1e-12);
      return [pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * t, pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * t];
    };
    const inTab = (s: number) => tabs.some(([a, b]) => {
      const u = ((s % per) + per) % per;
      return u > a && u < b;
    });
    const zAt = (s: number) => {
      const z = rampLen ? Math.max(zl, zFrom - s * slope) : zl;
      return inTab(s) ? Math.max(z, o.zTab!) : z;
    };
    // break points: vertices of every lap travelled, the ramp's end, tab edges
    const marks = new Set<number>([total]);
    for (let lap = 0; lap * per < total; lap++) {
      for (const c of cum) if (lap * per + c < total) marks.add(lap * per + c);
      for (const [a, b] of tabs) for (const e of [a, b]) if (lap * per + e < total) marks.add(lap * per + e);
    }
    if (rampLen) marks.add(rampLen);
    const ss = [...marks].filter((x) => x > 1e-9).sort((a, b) => a - b);
    let zNow = rampLen ? zFrom : zl;
    let prev = 0;
    for (const sv of ss) {
      // a jump in height (onto or off a tab): straight up or down at the start of the piece
      const zStart = zAt(prev + 1e-7);
      if (Math.abs(zStart - zNow) > 1e-5) {
        const [px, py] = posAt(prev);
        feed(px, py, zStart, zStart > zNow ? cut.feed : cut.plunge);
        zNow = zStart;
      }
      const [qx, qy] = posAt(sv);
      const zEnd = zAt(sv - 1e-7);
      feed(qx, qy, Math.abs(zEnd - zl) < 1e-5 ? zl : zEnd);
      zNow = zEnd;
      prev = sv;
    }
    if (Math.abs(zNow - zl) > 1e-5) feed(loop[0]![0], loop[0]![1], zl, cut.plunge);
  };

  /** Tab intervals (along the loop) for `n` tabs of `width`, evenly spaced; the tool centre travels width + d over each. */
  const tabIntervals = (loop: Loop, n: number, width: number): [number, number][] => {
    if (!n) return [];
    let per = 0;
    for (let i = 0; i < loop.length; i++) per += Math.hypot(loop[(i + 1) % loop.length]![0] - loop[i]![0], loop[(i + 1) % loop.length]![1] - loop[i]![1]);
    const half = width / 2 + r;
    if (per / n < 2 * half + d) throw new CamError(`${n} tabs of ${width} mm do not fit around this contour`);
    return Array.from({ length: n }, (_, k) => {
      const c = (per * (k + 0.5)) / n;
      return [c - half, c + half] as [number, number];
    });
  };

  /** A shape's paths on the stock (closed loops and open paths), or an error naming what is missing. */
  const shapeOf = (id: string): { closed: Loop[]; open: Pt[][] } => {
    const sh = job.shapes.find((x: Shape) => x.id === id);
    if (!sh) throw new CamError(`there is no shape ${id}${job.shapes.length ? ` (shapes: ${job.shapes.map((x: Shape) => x.id).join(', ')})` : '; import a DXF or SVG first'}`);
    const moved = sh.paths.map((p) => ({ closed: p.closed, pts: dedupe(p.pts.map(([x, y]) => [x + sh.at.x, y + sh.at.y] as Pt), p.closed) }));
    return { closed: moved.filter((p) => p.closed && p.pts.length >= 3).map((p) => p.pts), open: moved.filter((p) => !p.closed || p.pts.length < 3).map((p) => p.pts) };
  };

  /** Start each loop at the vertex nearest to `near` (shorter links, predictable ramps). */
  const startNear = (l: Loop, near: Pt): Loop => {
    let best = 0;
    let bd = Infinity;
    l.forEach(([x, y], i) => {
      const dd = Math.hypot(x - near[0], y - near[1]);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    return [...l.slice(best), ...l.slice(0, best)];
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
      const ring: Loop = [[x0, y0], ...(loop as Pt[]).slice(0, -1)];
      const zTab = op.zBottom + op.tabHeight;
      if (op.tabs && zTab >= zTop) throw new CamError('the tabs are taller than the cut');
      const tabs = tabIntervals(ring, op.tabs, op.tabWidth);
      approach(x0, y0, zTop);
      let zPrev = zTop + 0.2;
      feed(x0, y0, zPrev, cut.plunge);
      for (const zl of levels(zTop, op.zBottom, stepOf(op))) {
        cutLoop(ring, zPrev, zl, { ramp: op.entry === 'ramp', angle: op.rampAngle, tabs, zTab });
        zPrev = zl;
      }
      rapid(x0, y0, safeZ);
      return out;
    }

    case 'mill_contour': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      const g = shapeOf(op.shape);
      const zTab = op.zBottom + op.tabHeight;
      if (op.tabs && zTab >= zTop) throw new CamError('the tabs are taller than the cut');
      // closed loops: offset the region by the tool radius and orient for climb milling;
      // open paths (and side "on"): the tool centre follows the lines as drawn
      let loops: Loop[] = [];
      // open paths are only followed with side "on"; for outside/inside they are not an outline
      let lines: Pt[][] = [];
      if (op.side === 'on') lines = [...g.open, ...g.closed.map((l) => [...l, l[0]!])];
      else if (g.closed.length) {
        const grown = offsetRegion(g.closed, op.side === 'outside' ? r : -r);
        if (!grown.length) throw new CamError(`the shape is too small for the Ø${d} tool on the inside`);
        loops = orient(grown, op.side === 'outside');
      } else throw new CamError(`shape ${op.shape} has no closed outline to cut ${op.side}; use side "on" for open lines`);
      const lv = levels(zTop, op.zBottom, stepOf(op));
      let at: Pt = [ctx.from.x, ctx.from.y];
      for (const l0 of loops) {
        const l = startNear(l0, at);
        const outer = op.side === 'outside' && orient([l], true)[0] === l;
        const tabs = op.tabs && outer ? tabIntervals(l, op.tabs, op.tabWidth) : [];
        approach(l[0]![0], l[0]![1], zTop);
        let zPrev = zTop + 0.2;
        feed(l[0]![0], l[0]![1], zPrev, cut.plunge);
        for (const zl of lv) {
          cutLoop(l, zPrev, zl, { ramp: op.entry === 'ramp', angle: op.rampAngle, tabs, zTab });
          zPrev = zl;
        }
        rapid(l[0]![0], l[0]![1], safeZ);
        at = l[0]!;
      }
      for (const line of lines) {
        // open path: back and forth along it, one level per direction, ramping in on the way
        let path = line;
        approach(path[0]![0], path[0]![1], zTop);
        let zPrev = zTop + 0.2;
        feed(path[0]![0], path[0]![1], zPrev, cut.plunge);
        for (const zl of lv) {
          feed(path[0]![0], path[0]![1], zl, cut.plunge);
          for (const [x, y] of path.slice(1)) feed(x, y, zl);
          path = [...path].reverse();
          zPrev = zl;
        }
        void zPrev;
        rapid(path[0]![0], path[0]![1], safeZ);
      }
      return out;
    }

    case 'mill_pocket': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      const g = shapeOf(op.shape);
      if (!g.closed.length) throw new CamError(`shape ${op.shape} has no closed outline to pocket`);
      // rings from the wall inwards, every stepover; cut from the inside out, the wall last
      const rings: Loop[][] = [];
      for (let k = 0; ; k++) {
        const ring = offsetRegion(g.closed, -(r + k * op.stepover * d));
        if (!ring.length) break;
        rings.push(orient(ring, false));
        if (k > 2000) throw new CamError('the pocket needs too many passes; use a bigger tool or stepover');
      }
      if (!rings.length) throw new CamError(`the pocket is too small for the Ø${d} tool`);
      const order = [...rings].reverse().flat();
      let zPrev = zTop + 0.2;
      for (const zl of levels(zTop, op.zBottom, stepOf(op))) {
        let at: Pt = [ctx.from.x, ctx.from.y];
        for (const l0 of order) {
          const l = startNear(l0, at);
          // above everything (islands stand up to the top), down through what is already cleared
          approach(l[0]![0], l[0]![1], zTop);
          feed(l[0]![0], l[0]![1], zPrev, cut.plunge);
          cutLoop(l, zPrev, zl, { ramp: op.entry === 'ramp', angle: op.rampAngle });
          rapid(l[0]![0], l[0]![1], zTop + 1);
          at = l[0]!;
        }
        zPrev = zl;
      }
      rapid(ctx.from.x, ctx.from.y, safeZ);
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
