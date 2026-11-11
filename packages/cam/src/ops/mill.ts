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
import { adaptivePlans, clearWay } from './adaptive.ts';
import { textStrokes } from '../font.ts';

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
  const arc = (x: number, y: number, z: number, cx: number, cy: number, cw: boolean, f = cut.feed) =>
    out.push({ type: 'arc', to: v(x, y, z), center: v(cx, cy, z), cw, f });

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
  const stepOf = (o: { stepDown?: number | undefined }) => o.stepDown ?? ctx.cut.doc;
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

  // walls: the levels stay `allow` away from them, one pass at full depth takes that off
  const allow = 'finish' in op ? op.finish : 0;
  const climb = !('direction' in op) || op.direction === 'climb';
  /** A loop the way round the user asked for (loops are built for climb milling), from the same start. */
  const way = (l: Loop): Loop => (climb ? l : [l[0]!, ...l.slice(1).reverse()]);

  /** Pocket the region inside closed loops (loops inside loops are islands): rings from the wall inwards, level by level. */
  const pocketLoops = (closed: Loop[], op: { zTop?: number | undefined; zBottom: number; stepDown?: number | undefined; stepover: number; entry: 'ramp' | 'plunge'; rampAngle: number }) => {
    {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      const g = { closed };
      // (no allowance where it would leave the levels no room at all)
      const a = allow > 0 && offsetRegion(g.closed, -(r + allow)).length ? allow : 0;
      // rings from the wall inwards, every stepover; cut from the inside out, the wall last
      const rings: Loop[][] = [];
      for (let k = 0; ; k++) {
        const ring = offsetRegion(g.closed, -(r + a + k * op.stepover * d));
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
          const l = way(startNear(l0, at));
          // above everything (islands stand up to the top), down through what is already cleared
          approach(l[0]![0], l[0]![1], zTop);
          feed(l[0]![0], l[0]![1], zPrev, cut.plunge);
          cutLoop(l, zPrev, zl, { ramp: op.entry === 'ramp', angle: op.rampAngle });
          rapid(l[0]![0], l[0]![1], zTop + 1);
          at = l[0]!;
        }
        zPrev = zl;
      }
      if (a > 0) {
        // the finishing pass along every wall (the outline and the islands) at full depth
        let at: Pt = [ctx.from.x, ctx.from.y];
        for (const l0 of orient(offsetRegion(g.closed, -r), false)) {
          const l = way(startNear(l0, at));
          approach(l[0]![0], l[0]![1], zTop);
          cutLoop(l, op.zBottom, op.zBottom, { ramp: false, angle: op.rampAngle });
          rapid(l[0]![0], l[0]![1], zTop + 1);
          at = l[0]!;
        }
      }
      rapid(ctx.from.x, ctx.from.y, safeZ);
    }
  };

  /**
   * Pocket the region inside closed loops with a small bite at full depth (adaptive.ts): down in
   * a helix where there is most room, then front after front, each no more than the bite wide.
   * Levels as deep as the flutes allow (or `stepDown`).
   */
  const adaptivePocket = (closed: Loop[], op: { zTop?: number | undefined; zBottom: number; stepDown?: number | undefined; load: number; rampAngle: number }) => {
    const zTop = zTopOf(op);
    checkDepth(zTop, op.zBottom);
    const bite = op.load * d;
    const a = allow > 0 && offsetRegion(closed, -(r + allow)).length ? allow : 0;
    const region = offsetRegion(closed, -(r + a));
    if (!region.length) throw new CamError(`the pocket is too small for the Ø${d} tool`);
    const plans = adaptivePlans(region, bite, d);
    // a thin chip may be fed faster for the same chip thickness (to twice the feed at most)
    const thin = Math.min(2, 1 / Math.sqrt(1 - (1 - 2 * op.load) ** 2));
    const f = Math.min(job.machine.maxFeed, Math.round(cut.feed * thin));
    // as deep as the flutes cut, and not more than two diameters at once
    const step = op.stepDown ?? Math.min(zTop - op.zBottom, tool.fluteLength ?? 2 * d, 2 * d);
    const dir = (p: { pts: Pt[]; closed: boolean }): Pt[] => (climb ? p.pts : [...p.pts].reverse());
    for (const plan of plans) {
      const [cx, cy] = plan.entry.c;
      const rh = plan.entry.rh;
      let zPrev = zTop + 0.2;
      for (const zl of levels(zTop, op.zBottom, step)) {
        approach(cx + rh, cy, zTop);
        // (down through what the level above cleared, then on in a helix)
        helixDown(cx, cy, rh, zPrev, zl, op.rampAngle);
        let at: Pt = [cx + rh, cy];
        for (const front of plan.fronts) {
          const todo = [...front.passes];
          while (todo.length) {
            // the nearest pass next; a closed one starts at its nearest point
            let bi = 0;
            let bd = Infinity;
            let bs = 0;
            todo.forEach((p, i) => {
              const pts = dir(p);
              const cand = p.closed ? pts.map((_, k) => k) : [0];
              for (const k of cand) {
                const dd = Math.hypot(pts[k]![0] - at[0], pts[k]![1] - at[1]);
                if (dd < bd) [bd, bi, bs] = [dd, i, k];
              }
            });
            const p = todo.splice(bi, 1)[0]!;
            let pts = dir(p);
            if (p.closed) {
              // onto a new ring at a slant, not square into it: start a few bites further along
              let go = 0;
              const n = pts.length;
              while (go < 4 * bite) {
                const q = pts[(bs + 1) % n]!;
                go += Math.hypot(q[0] - pts[bs]![0], q[1] - pts[bs]![1]);
                bs = (bs + 1) % n;
                if (go > 1e6) break;
              }
              pts = [...pts.slice(bs), ...pts.slice(0, bs), pts[bs]!];
            }
            const s0 = pts[0]!;
            if (bd > 1e-6) {
              if (clearWay(at, s0, front.open)) feed(s0[0], s0[1], zl, f);
              else {
                // across uncut material: up, over, and down where it is already cleared
                rapid(at[0], at[1], zTop + 1);
                approach(s0[0], s0[1], zTop);
                feed(s0[0], s0[1], zl, f);
              }
            }
            for (const q of pts.slice(1)) feed(q[0], q[1], zl, f);
            at = pts.at(-1)!;
          }
        }
        rapid(at[0], at[1], zTop + 1);
        zPrev = zl;
      }
    }
    if (a > 0) {
      // the finishing pass along every wall (the outline and the islands) at full depth
      let at: Pt = [ctx.from.x, ctx.from.y];
      for (const l0 of orient(offsetRegion(closed, -r), false)) {
        const l = way(startNear(l0, at));
        approach(l[0]![0], l[0]![1], zTop);
        cutLoop(l, op.zBottom, op.zBottom, { ramp: false, angle: op.rampAngle });
        rapid(l[0]![0], l[0]![1], zTop + 1);
        at = l[0]!;
      }
    }
    rapid(ctx.from.x, ctx.from.y, safeZ);
  };

  // pointed cutters: half the angle at the point, and the flat at the tip
  const tanHalf = Math.tan((((tool.angle ?? 90) / 2) * Math.PI) / 180);
  const tipR = (tool.tipDiameter ?? 0) / 2;

  switch (op.type) {
    case 'mill_face': {
      const fromZ = op.fromZ ?? stock.top;
      if (op.z > fromZ + 1e-9) throw new CamError(`face Z${op.z} is above the material top Z${fromZ}`);
      const step = op.stepDown ?? Math.min(ctx.cut.doc, 1);
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
      if (op.strategy === 'adaptive') {
        adaptivePocket([[[op.x, op.y], [op.x + op.w, op.y], [op.x + op.w, op.y + op.h], [op.x, op.y + op.h]]], op);
        return out;
      }
      // (no allowance where the pocket is hardly wider than the tool)
      const a = Math.min(op.w, op.h) - d > 4 * allow ? allow : 0;
      const [fx0, fx1, fy0, fy1] = [op.x + r, op.x + op.w - r, op.y + r, op.y + op.h - r];
      const [x0, x1, y0, y1] = [fx0 + a, fx1 - a, fy0 + a, fy1 - a];
      const rows = y1 - y0 < 1e-9 ? [y0] : [y0, ...levels(y0, y1, op.stepover * d)];
      const lap = (ax0: number, ax1: number, ay0: number, ay1: number, zl: number) => {
        const corners: Pt[] = climb ? [[ax1, ay0], [ax1, ay1], [ax0, ay1], [ax0, ay0]] : [[ax0, ay1], [ax1, ay1], [ax1, ay0], [ax0, ay0]];
        for (const [cx, cy] of corners) feed(cx, cy, zl);
      };
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
        // a lap around the walls
        feed(x0, y0, zl);
        lap(x0, x1, y0, y1, zl);
      }
      if (a > 0) {
        // the finishing pass: out to the wall, once round at full depth, and off the wall again
        feed(fx0, fy0, op.zBottom);
        lap(fx0, fx1, fy0, fy1, op.zBottom);
        feed(x0, y0, op.zBottom);
      }
      rapid(x0, y0, safeZ);
      return out;
    }

    case 'mill_pocket_circle': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      const RF = op.diameter / 2 - r;
      if (RF < -1e-9) throw new CamError(`hole Ø${op.diameter} is smaller than the Ø${d} tool`);
      if (op.strategy === 'adaptive') {
        const n = 180;
        adaptivePocket([Array.from({ length: n }, (_, k) => [op.cx + (op.diameter / 2) * Math.cos((2 * Math.PI * k) / n), op.cy + (op.diameter / 2) * Math.sin((2 * Math.PI * k) / n)] as Pt)], op);
        return out;
      }
      const a = RF > 4 * allow ? allow : 0;
      const R = RF - a;
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
          arc(op.cx - ri, op.cy, zl, op.cx, op.cy, !climb);
          arc(op.cx + ri, op.cy, zl, op.cx, op.cy, !climb);
        }
        if (rings.length) feed(op.cx, op.cy, zl);
      }
      if (a > 0) {
        // the finishing pass at full depth: out to the wall, once round, back to the middle
        feed(op.cx + RF, op.cy, op.zBottom);
        arc(op.cx - RF, op.cy, op.zBottom, op.cx, op.cy, !climb);
        arc(op.cx + RF, op.cy, op.zBottom, op.cx, op.cy, !climb);
        feed(op.cx, op.cy, op.zBottom);
      }
      rapid(op.cx, op.cy, safeZ);
      return out;
    }

    case 'mill_contour_rect': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      if (op.side === 'inside' && (op.w < d - 1e-9 || op.h < d - 1e-9)) throw new CamError(`rectangle ${op.w}×${op.h} is smaller than the Ø${d} tool`);
      const a = op.side === 'outside' || Math.min(op.w, op.h) - d > 4 * allow ? allow : 0;
      // the tool centre's path `off` outside the rectangle (negative: inside), for climb milling:
      // outside clockwise (up the left side first), inside counter-clockwise
      const ringAt = (off: number): Loop => {
        const [bx0, bx1, by0, by1] = [op.x - off, op.x + op.w + off, op.y - off, op.y + op.h + off];
        return way(op.side === 'outside' ? [[bx0, by0], [bx0, by1], [bx1, by1], [bx1, by0]] : [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]);
      };
      const ring = ringAt(op.side === 'outside' ? r + a : -(r + a));
      const [x0, y0] = ring[0]!;
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
      if (a > 0) {
        // the finishing pass: over to the line, once round at full depth (over the tabs as before)
        const fin = ringAt(op.side === 'outside' ? r : -r);
        feed(fin[0]![0], fin[0]![1], op.zBottom);
        cutLoop(fin, op.zBottom, op.zBottom, { ramp: false, angle: op.rampAngle, tabs: tabIntervals(fin, op.tabs, op.tabWidth), zTab });
        feed(x0, y0, op.zBottom);
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
      /** The finishing pass's loops (on the line), when the levels leave an allowance. */
      let finishing: Loop[] = [];
      // open paths are only followed with side "on"; for outside/inside they are not an outline
      let lines: Pt[][] = [];
      if (op.side === 'on') lines = [...g.open, ...g.closed.map((l) => [...l, l[0]!])];
      else if (g.closed.length) {
        const sign = op.side === 'outside' ? 1 : -1;
        const exact = offsetRegion(g.closed, sign * r);
        if (!exact.length) throw new CamError(`the shape is too small for the Ø${d} tool on the inside`);
        const rough = allow > 0 ? offsetRegion(g.closed, sign * (r + allow)) : [];
        // (where the allowance leaves no room inside, the levels go to the line as before)
        loops = orient(rough.length ? rough : exact, op.side === 'outside');
        if (rough.length) finishing = orient(exact, op.side === 'outside');
      } else throw new CamError(`shape ${op.shape} has no closed outline to cut ${op.side}; use side "on" for open lines`);
      const lv = levels(zTop, op.zBottom, stepOf(op));
      let at: Pt = [ctx.from.x, ctx.from.y];
      for (const l0 of loops) {
        const outer = op.side === 'outside' && orient([l0], true)[0] === l0;
        const l = way(startNear(l0, at));
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
      for (const l0 of finishing) {
        // the finishing pass: down beside the wall (through the allowance only), once round at full depth
        const outer = op.side === 'outside' && orient([l0], true)[0] === l0;
        const l = way(startNear(l0, at));
        const tabs = op.tabs && outer ? tabIntervals(l, op.tabs, op.tabWidth) : [];
        approach(l[0]![0], l[0]![1], zTop);
        cutLoop(l, op.zBottom, op.zBottom, { ramp: false, angle: op.rampAngle, tabs, zTab });
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
      const g = shapeOf(op.shape);
      if (!g.closed.length) throw new CamError(`shape ${op.shape} has no closed outline to pocket`);
      if (op.strategy === 'adaptive') adaptivePocket(g.closed, op);
      else pocketLoops(g.closed, op);
      return out;
    }

    case 'mill_slot': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      const len = Math.hypot(op.x1 - op.x0, op.y1 - op.y0);
      const w = op.width ?? d;
      if (w < d - 1e-9) throw new CamError(`the slot (${w} mm) is narrower than the Ø${d} tool`);
      if (w > d + 1e-6) {
        // wider than the tool: a pocket with round ends
        const [ux, uy] = len > 1e-9 ? [(op.x1 - op.x0) / len, (op.y1 - op.y0) / len] : [1, 0];
        const a0 = Math.atan2(uy, ux);
        const outline: Loop = [];
        const n = 24;
        for (let k = 0; k <= n; k++) outline.push([op.x1 + (w / 2) * Math.cos(a0 - Math.PI / 2 + (Math.PI * k) / n), op.y1 + (w / 2) * Math.sin(a0 - Math.PI / 2 + (Math.PI * k) / n)]);
        for (let k = 0; k <= n; k++) outline.push([op.x0 + (w / 2) * Math.cos(a0 + Math.PI / 2 + (Math.PI * k) / n), op.y0 + (w / 2) * Math.sin(a0 + Math.PI / 2 + (Math.PI * k) / n)]);
        pocketLoops([outline], op);
        return out;
      }
      // the tool's own width: back and forth down the middle
      approach(op.x0, op.y0, zTop);
      let zPrev = zTop + 0.2;
      feed(op.x0, op.y0, zPrev, cut.plunge);
      for (const zl of levels(zTop, op.zBottom, stepOf(op))) {
        if (op.entry === 'ramp' && len > r * 0.5) rampDown(op.x0, op.y0, op.x1, op.y1, zPrev, zl, op.rampAngle);
        else feed(op.x0, op.y0, zl, cut.plunge);
        // one pass along and back cleans the ramps out
        feed(op.x1, op.y1, zl);
        feed(op.x0, op.y0, zl);
        zPrev = zl;
      }
      rapid(op.x0, op.y0, safeZ);
      return out;
    }

    case 'mill_spot': {
      const zTop = zTopOf(op);
      if (op.diameter > d + 1e-9) throw new CamError(`a Ø${op.diameter} spot is wider than the Ø${d} tool`);
      const depth = Math.max(0, (op.diameter / 2 - tipR) / tanHalf);
      for (const p of op.points) {
        rapid(p.x, p.y, safeZ);
        rapid(p.x, p.y, zTop + 1);
        feed(p.x, p.y, zTop - depth, cut.plunge);
        rapid(p.x, p.y, safeZ);
      }
      return out;
    }

    case 'mill_chamfer': {
      const zTop = zTopOf(op);
      // The cone's surface runs through the edge's two new corners: `size` in from the edge on the
      // top face, and that over tan down the wall. Its point is lower still by tipClear, which
      // puts the tool's axis that much (times tan) off the wall.
      const leg = op.size / tanHalf;
      const most = (r - tipR) / tanHalf;
      if (leg > most + 1e-9) throw new CamError(`a ${op.size} mm chamfer needs more cone than the Ø${d} tool has (${(most * tanHalf).toFixed(2)} mm at most)`);
      const zt = Math.min(leg + op.tipClear, most);
      const off = tipR + (zt - leg) * tanHalf;
      const z = zTop - zt;
      const sign = op.side === 'outside' ? 1 : -1;
      let loops: Loop[];
      const given = [op.shape !== undefined, op.w !== undefined || op.h !== undefined, op.diameter !== undefined].filter(Boolean).length;
      if (given !== 1) throw new CamError('say which edge: a shape, or a rectangle (x, y, w, h), or a circle (cx, cy, diameter)');
      if (op.shape !== undefined) {
        const g = shapeOf(op.shape);
        if (!g.closed.length) throw new CamError(`shape ${op.shape} has no closed outline to chamfer`);
        loops = orient(offsetRegion(g.closed, sign * off), op.side === 'outside');
        if (!loops.length) throw new CamError('the outline is too small to get the tool into');
      } else if (op.diameter !== undefined) {
        if (op.cx === undefined || op.cy === undefined) throw new CamError('a circle needs cx and cy');
        const rr = op.diameter / 2 + sign * off;
        if (rr < 0.05) {
          // a hole no wider than the tool's point runs off its axis: straight down the middle
          // until the cone is `size` wider than the hole
          const depth = (op.diameter / 2 + op.size - tipR) / tanHalf;
          if (depth > most + 1e-9) throw new CamError(`the Ø${d} tool is too small to chamfer a Ø${op.diameter} hole by ${op.size}`);
          rapid(op.cx, op.cy, safeZ);
          rapid(op.cx, op.cy, zTop + 1);
          feed(op.cx, op.cy, zTop - depth, cut.plunge);
          rapid(op.cx, op.cy, safeZ);
          return out;
        }
        const n = Math.max(24, Math.ceil(rr * 4));
        const circle: Loop = Array.from({ length: n }, (_, k) => [op.cx! + rr * Math.cos((2 * Math.PI * k) / n), op.cy! + rr * Math.sin((2 * Math.PI * k) / n)]);
        loops = orient([circle], op.side === 'outside');
      } else {
        if (op.x === undefined || op.y === undefined || op.w === undefined || op.h === undefined) throw new CamError('a rectangle needs x, y, w and h');
        const [bx0, bx1, by0, by1] = [op.x - sign * off, op.x + op.w + sign * off, op.y - sign * off, op.y + op.h + sign * off];
        if (bx1 - bx0 < 0.1 || by1 - by0 < 0.1) throw new CamError('the rectangle is too small to get the tool into');
        loops = [op.side === 'outside' ? [[bx0, by0], [bx0, by1], [bx1, by1], [bx1, by0]] : [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]];
      }
      let at: Pt = [ctx.from.x, ctx.from.y];
      for (const l0 of loops) {
        const l = way(startNear(l0, at));
        approach(l[0]![0], l[0]![1], zTop);
        cutLoop(l, z, z, { ramp: false, angle: 3 });
        rapid(l[0]![0], l[0]![1], safeZ);
        at = l[0]!;
      }
      return out;
    }

    case 'mill_engrave': {
      const zTop = zTopOf(op);
      const t = textStrokes(op.text, op.height, op.spacing);
      if (!t.paths.length) throw new CamError(`nothing to engrave: the font has none of "${op.text}"`);
      if (t.missing.length) throw new CamError(`the engraving font has no ${[...new Set(t.missing)].map((c) => `"${c}"`).join(', ')}: capitals, digits and - + = _ . , : ! ? / \\ ( ) # * % ° Ø ' " < > × only`);
      if (tool.type === 'endmill' && op.depth > (cut.doc ?? Infinity) + 1e-9) throw new CamError(`${op.depth} mm is more than T${tool.id} takes in one pass (${cut.doc} mm): engrave shallower`);
      const [ca, sa] = [Math.cos((op.angle * Math.PI) / 180), Math.sin((op.angle * Math.PI) / 180)];
      const z = zTop - op.depth;
      const hop = zTop + 1;
      let first = true;
      for (const path of t.paths) {
        const pts = path.map(([px, py]): Pt => [op.x + px * ca - py * sa, op.y + px * sa + py * ca]);
        if (first) approach(pts[0]![0], pts[0]![1], zTop);
        else rapid(pts[0]![0], pts[0]![1], hop);
        first = false;
        feed(pts[0]![0], pts[0]![1], z, cut.plunge);
        for (const [px, py] of pts.slice(1)) feed(px, py, z);
        rapid(pts.at(-1)![0], pts.at(-1)![1], hop);
      }
      const last = t.paths.at(-1)!.at(-1)!;
      rapid(op.x + last[0] * ca - last[1] * sa, op.y + last[0] * sa + last[1] * ca, safeZ);
      return out;
    }

    case 'mill_thread': {
      const zTop = zTopOf(op);
      checkDepth(zTop, op.zBottom);
      const internal = op.side === 'internal';
      // ISO metric: the flanks are 0.5413 P deep in a nut, 0.6134 P on a bolt
      const H = (internal ? 0.5413 : 0.6134) * op.pitch;
      const R = op.diameter / 2;
      if (internal && r > R - H - 0.1) throw new CamError(`the Ø${d} thread mill does not fit the Ø${(2 * (R - H)).toFixed(2)} core hole of M${op.diameter}×${op.pitch}`);
      // With the spindle turning clockwise (M3), climb milling goes counter-clockwise inside a
      // hole and clockwise around a boss. A right-hand thread rises counter-clockwise: so inside
      // it is cut from the bottom up, outside from the top down; a left-hand thread the other way.
      const ccw = internal;
      const up = internal === (op.hand === 'right');
      const turns = Math.ceil((zTop - op.zBottom) / op.pitch + 0.5);
      const [zA, zB] = up ? [op.zBottom, op.zBottom + turns * op.pitch] : [op.zBottom + turns * op.pitch, op.zBottom];
      // where the tool waits between passes: on the axis of the hole, or clear of the boss
      const park = internal ? 0 : R + r + 2;
      rapid(op.cx + park, op.cy, safeZ);
      rapid(op.cx + park, op.cy, Math.max(zA, zTop + 1));
      for (let i = 1; i <= op.passes; i++) {
        // equal chips: the depth grows as the root of the pass number
        const depth = H * Math.sqrt(i / op.passes);
        const rp = internal ? R - r - (H - depth) : R + r - depth;
        // the feed is the cutting edge's; the tool's axis goes round a smaller (inside) circle
        const f = Math.max(1, Math.round(cut.feed * (internal ? rp / (rp + r) : 1)));
        if (internal) feed(op.cx, op.cy, zA, cut.plunge);
        else rapid(op.cx + park, op.cy, zA);
        // in along half a circle (inside), or straight in (outside)
        if (internal) arc(op.cx + rp, op.cy, zA, op.cx + rp / 2, op.cy, !ccw, f);
        else feed(op.cx + rp, op.cy, zA, f);
        let z = zA;
        const dz = ((zB - zA) / turns) / 2;
        for (let k = 0; k < turns; k++) {
          z += dz;
          arc(op.cx - rp, op.cy, z, op.cx, op.cy, !ccw, f);
          z += dz;
          arc(op.cx + rp, op.cy, z, op.cx, op.cy, !ccw, f);
        }
        if (internal) arc(op.cx, op.cy, zB, op.cx + rp / 2, op.cy, !ccw, f);
        else feed(op.cx + park, op.cy, zB, f);
        if (i < op.passes) {
          if (internal) rapid(op.cx, op.cy, Math.max(zA, zB) + 0);
          else rapid(op.cx + park, op.cy, Math.max(zA, zB, zTop + 1));
        }
      }
      rapid(op.cx + park, op.cy, safeZ);
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
