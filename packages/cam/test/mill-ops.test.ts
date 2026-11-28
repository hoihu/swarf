import { describe, expect, it } from 'vitest';
import { parseGcode } from './support/parse.ts';
import { codes, withOps } from './support/fixtures.ts';
import {
  EXAMPLES,
  MillMaterial,
  analyze,
  textStrokes,
  emit,
  walk,
  type OperationInput,
} from '../src/index.ts';
import { cone, type Tool, type Vec3 } from '../src/schema.ts';

describe('shapes', () => {
  const circle = (cx: number, cy: number, r: number, n = 72): [number, number][] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  // a 40 × 30 plate outline with a Ø12 hole, drawn at its own origin, placed at X20 Y10
  const plate = { id: 's1', name: 'plate.dxf', at: { x: 20, y: 10 }, paths: [
    { closed: true, pts: [[0, 0], [40, 0], [40, 30], [0, 30]] as [number, number][] },
    { closed: true, pts: circle(20, 15, 6) },
    { closed: false, pts: [[5, 25], [35, 25]] as [number, number][] },
  ] };
  const job = (ops: OperationInput[]) => withOps('mill', ops, { shapes: [plate] });
  const height = (a: ReturnType<typeof analyze>, x: number, y: number) => {
    const m = a.material as MillMaterial;
    return m.h[Math.floor(y / m.cell) * m.nx + Math.floor(x / m.cell)]!;
  };

  it('pockets the outline and leaves the island standing', () => {
    const a = analyze(job([{ type: 'mill_pocket', tool: 1, shape: 's1', zBottom: -3, zTop: 0.5 }]));
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(height(a, 25, 15)).toBeCloseTo(-3, 3); // floor
    expect(height(a, 40, 25)).toBeCloseTo(0.5, 3); // island (the circle)
    expect(height(a, 10, 5)).toBeCloseTo(0.5, 3); // outside the outline
    expect(height(a, 57, 37)).toBeCloseTo(-3, 1); // into the corner, within the tool radius
  });

  it('cuts a part out with its hole, climb milling', () => {
    const a = analyze(job([{ type: 'mill_contour', tool: 1, shape: 's1', side: 'outside', zBottom: -3, zTop: 0.5 }]));
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(height(a, 17, 25)).toBeCloseTo(-3, 3); // around the outside
    expect(height(a, 40, 29.5)).toBeCloseTo(-3, 3); // inside the hole
    expect(height(a, 30, 15)).toBeCloseTo(0.5, 3); // the part
    // outer loop clockwise: going around, x grows on the top edge
    const feeds = [...walk(a.program)].filter((w) => w.move.type === 'feed' && Math.abs(w.move.to.y - 43) < 1e-6 && Math.abs(w.from.y - 43) < 1e-6);
    expect(feeds.length).toBeGreaterThan(0);
    for (const w of feeds) expect(w.move.to.x).toBeGreaterThanOrEqual(w.from.x - 1e-6);
  });

  it('engraves along the lines with side "on"', () => {
    const a = analyze(job([{ type: 'mill_contour', tool: 1, shape: 's1', side: 'on', zBottom: -0.5, zTop: 0.5 }]));
    expect(height(a, 40, 35)).toBeCloseTo(-0.5, 3); // the open line at y 25 + 10
    expect(height(a, 30, 31.5)).toBeCloseTo(0.5, 3);
  });

  it('says what is missing', () => {
    expect(analyze(job([{ type: 'mill_pocket', tool: 1, shape: 'nope', zBottom: -1 }])).diagnostics.map((d) => d.message).join()).toMatch(/no shape nope \(shapes: s1\)/);
  });
});

describe('contour tabs', () => {
  it('leaves tabs standing at the tab height', () => {
    const job = withOps('mill', [{ type: 'mill_contour_rect', tool: 1, x: 20, y: 10, w: 40, h: 30, zBottom: -14.5, zTop: 0.5, tabs: 4, tabWidth: 5, tabHeight: 1.5 }]);
    const a = analyze(job);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const m = a.material as MillMaterial;
    const at = (x: number, y: number) => m.h[Math.floor(y / m.cell) * m.nx + Math.floor(x / m.cell)]!;
    // along the cut: mostly through, but some tab material at −13
    const ring: number[] = [];
    for (let x = 20; x <= 60; x += 0.25) ring.push(at(x, 10 - 3), at(x, 40 + 3));
    for (let y = 10; y <= 40; y += 0.25) ring.push(at(20 - 3, y), at(60 + 3, y));
    expect(ring.some((h) => Math.abs(h - -13) < 0.01)).toBe(true);
    expect(ring.filter((h) => h <= -14.49).length).toBeGreaterThan(ring.length * 0.6);
    expect(at(40, 25)).toBeCloseTo(0.5, 3); // the part itself untouched
  });

  it('refuses tabs that do not fit', () => {
    expect(codes(withOps('mill', [{ type: 'mill_contour_rect', tool: 1, x: 20, y: 10, w: 10, h: 8, zBottom: -5, tabs: 12, tabWidth: 6 }]))).toContain('OP_INVALID');
  });
});

describe('entry', () => {
  it('ramps into a pocket at the ramp angle', () => {
    const job = withOps('mill', [{ type: 'mill_pocket_rect', tool: 1, x: 20, y: 15, w: 30, h: 20, zBottom: -3, zTop: 0, stepDown: 3, rampAngle: 5 }]);
    const moves = [...walk(analyze(job).program)];
    const ramps = moves.filter((w) => w.move.type === 'feed' && w.move.to.z < w.from.z - 1e-9 && Math.hypot(w.move.to.x - w.from.x, w.move.to.y - w.from.y) > 1);
    expect(ramps.length).toBeGreaterThan(1);
    for (const w of ramps) {
      const run = Math.hypot(w.move.to.x - w.from.x, w.move.to.y - w.from.y);
      expect((w.from.z - w.move.to.z) / run).toBeLessThanOrEqual(Math.tan((5 * Math.PI) / 180) + 1e-9);
    }
    expect(codes(job)).toEqual([]);
  });

  it('helixes into a circular pocket and writes helical arcs', () => {
    const job = withOps('mill', [{ type: 'mill_pocket_circle', tool: 1, cx: 40, cy: 25, diameter: 20, zBottom: -2, zTop: 0 }]);
    const a = analyze(job);
    const helical = [...walk(a.program)].filter((w) => w.move.type === 'arc' && w.move.to.z < w.from.z - 1e-9);
    expect(helical.length).toBeGreaterThan(2);
    const { text } = emit(job, a.program);
    const parsed = parseGcode(text, 'mill').moves.filter((m) => m.move.type === 'arc');
    expect(parsed.some((m, i) => i > 0 && m.move.to.z < parsed[i - 1]!.move.to.z)).toBe(true);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('finishing the walls', () => {
  const circle = (cx: number, cy: number, r: number, n = 72): [number, number][] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  const plate = { id: 's1', name: 'plate', at: { x: 20, y: 10 }, paths: [{ closed: true, pts: [[0, 0], [40, 0], [40, 30], [0, 30]] as [number, number][] }, { closed: true, pts: circle(20, 15, 6) }] };
  const ops: OperationInput[] = [
    { type: 'mill_pocket_rect', tool: 1, x: 10, y: 10, w: 40, h: 25, zBottom: -4 },
    { type: 'mill_pocket_circle', tool: 1, cx: 40, cy: 25, diameter: 30, zBottom: -4 },
    { type: 'mill_contour_rect', tool: 1, x: 15, y: 10, w: 50, h: 30, zBottom: -4, side: 'outside', tabs: 2 },
    { type: 'mill_contour_rect', tool: 1, x: 15, y: 10, w: 50, h: 30, zBottom: -4, side: 'inside' },
    { type: 'mill_contour', tool: 1, shape: 's1', zBottom: -4, side: 'outside' },
    { type: 'mill_contour', tool: 1, shape: 's1', zBottom: -4, side: 'inside' },
    { type: 'mill_pocket', tool: 1, shape: 's1', zBottom: -4 },
  ];
  const run = (op: OperationInput) => analyze(withOps('mill', [op], { shapes: [plate] }));
  /** The cutting moves' ends, with the level they are at. */
  const cuts = (a: ReturnType<typeof analyze>) => a.program.segments.flatMap((s) => s.moves).filter((m) => m.type !== 'rapid').map((m) => m.to);

  for (const op of ops) {
    it(`${op.type}${'side' in op ? ` ${op.side}` : ''}: the levels stay 0.2 off the wall, one pass at full depth takes it off; the part is the same`, () => {
      const plain = run(op);
      const fin = run({ ...op, finish: 0.2 } as OperationInput);
      for (const a of [plain, fin]) expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      // the part: nothing left standing that the plain version takes off (but for a cell or two on the line)
      const [m0, m1] = [plain.material as MillMaterial, fin.material as MillMaterial];
      let left = 0;
      let more = 0;
      for (let i = 0; i < m0.h.length; i++) {
        if (m1.h[i]! > m0.h[i]! + 1e-6) left++;
        if (m1.h[i]! < m0.h[i]! - 1e-6) more++;
      }
      // (with holding tabs: those are a little wider, where the two passes' tabs do not quite meet)
      expect(left).toBeLessThanOrEqual('tabs' in op && op.tabs ? 400 : 4);
      // (a contour's slot is 0.2 wider on the waste side; a pocket is the same pocket)
      if (op.type.startsWith('mill_pocket')) expect(more).toBeLessThanOrEqual(4);
      // how far the cutter's centre gets, in X: above the bottom 0.2 short of where the plain
      // version goes (inside) or 0.2 further out (outside); at the bottom, by the last pass, the same
      const span = (pts: { x: number }[]) => [Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x))] as const;
      const upper = (a: ReturnType<typeof analyze>) => cuts(a).filter((p) => p.z > -4 + 1e-6 && p.z < 0.6);
      const bottom = (a: ReturnType<typeof analyze>) => cuts(a).filter((p) => Math.abs(p.z + 4) < 1e-6);
      const out = 'side' in op && op.side === 'outside' ? 1 : -1;
      const [u0, u1] = [span(upper(plain)), span(upper(fin))];
      expect(u1[0] - u0[0]).toBeCloseTo(-out * 0.2, 6);
      expect(u1[1] - u0[1]).toBeCloseTo(out * 0.2, 6);
      const b0 = span(bottom(plain));
      for (const edge of b0) expect(bottom(fin).some((q) => Math.abs(q.x - edge) < 1e-6), `the last pass reaches X${edge}`).toBe(true);
      if (out < 0) expect(span(bottom(fin))).toEqual(b0);
    });
  }

  it('conventional goes the other way round; the part is the same', () => {
    const area = (pts: { x: number; y: number }[]) => pts.reduce((s, p, i) => s + (p.x * pts[(i + 1) % pts.length]!.y - pts[(i + 1) % pts.length]!.x * p.y), 0) / 2;
    for (const withTabs of ops) {
      const op = { ...withTabs, tabs: 0 } as OperationInput;
      const a = run({ ...op, finish: 0.2 } as OperationInput);
      const b = run({ ...op, finish: 0.2, direction: 'conventional' } as OperationInput);
      expect(b.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const [ma, mb] = [a.material as MillMaterial, b.material as MillMaterial];
      let differ = 0;
      for (let i = 0; i < ma.h.length; i++) if (Math.abs(ma.h[i]! - mb.h[i]!) > 1e-6) differ++;
      expect(differ, op.type).toBeLessThanOrEqual(12);
      // the last pass at full depth, as a polygon: its sense is reversed
      const last = (x: ReturnType<typeof analyze>) => {
        const all = cuts(x);
        let i = all.length - 1;
        while (i >= 0 && Math.abs(all[i]!.z + 4) > 1e-6) i--;
        let j = i;
        while (j >= 0 && Math.abs(all[j]!.z + 4) < 1e-6) j--;
        return all.slice(j + 1, i + 1);
      };
      if (op.type === 'mill_pocket_circle') continue; // arcs: two half circles have no area as a polygon
      expect(Math.sign(area(last(a))), op.type).toBe(-Math.sign(area(last(b))));
    }
    // climb: inside counter-clockwise, outside clockwise (the spindle turns clockwise seen from above)
    const inside = run({ type: 'mill_contour_rect', tool: 1, x: 15, y: 10, w: 50, h: 30, zBottom: -4, side: 'inside' });
    const outside = run({ type: 'mill_contour_rect', tool: 1, x: 15, y: 10, w: 50, h: 30, zBottom: -4, side: 'outside' });
    const lap = (x: ReturnType<typeof analyze>) => cuts(x).filter((p) => Math.abs(p.z + 4) < 1e-6);
    expect(area(lap(inside))).toBeGreaterThan(0);
    expect(area(lap(outside))).toBeLessThan(0);
  });

  it('where there is no room for an allowance the levels go to the line as before', () => {
    const a = run({ type: 'mill_pocket_rect', tool: 1, x: 10, y: 10, w: 6.5, h: 30, zBottom: -2, finish: 0.2 });
    const b = run({ type: 'mill_pocket_rect', tool: 1, x: 10, y: 10, w: 6.5, h: 30, zBottom: -2 });
    expect(emit(withOps('mill', []), a.program).text).toBe(emit(withOps('mill', []), b.program).text);
  });
});

describe('more mill operations', () => {
  const tools = [
    { id: 1, name: 'Endmill Ø6', type: 'endmill' as const, diameter: 6, flutes: 3, fluteLength: 18 },
    { id: 3, name: 'Drill Ø6.8', type: 'drill' as const, diameter: 6.8 },
    { id: 4, name: 'Chamfer mill Ø6 90°', type: 'chamfer' as const, diameter: 6, flutes: 2, angle: 90 },
    { id: 5, name: 'Thread mill Ø5', type: 'threadmill' as const, diameter: 5, flutes: 3, fluteLength: 14 },
  ];
  const run = (ops: OperationInput[]) => analyze(withOps('mill', ops, { tools }));
  const errors = (a: ReturnType<typeof analyze>) => a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`);
  /** The material's top at a point. */
  const at = (a: ReturnType<typeof analyze>, x: number, y: number) => {
    const m = a.material as MillMaterial;
    return m.h[Math.min(m.ny - 1, Math.floor(y / m.cell)) * m.nx + Math.min(m.nx - 1, Math.floor(x / m.cell))]!;
  };
  const cuts = (a: ReturnType<typeof analyze>) => a.program.segments.flatMap((s) => s.moves).filter((m) => m.type !== 'rapid');

  it('a slot the tool\'s own width: down the middle, ramping along it; a wider one: a pocket with round ends', () => {
    const narrow = run([{ type: 'mill_slot', tool: 1, x0: 15, y0: 20, x1: 55, y1: 20, zBottom: -4 }]);
    expect(errors(narrow)).toEqual([]);
    // every cutting move on the line between the two ends
    for (const m of cuts(narrow)) {
      expect(m.to.y).toBeCloseTo(20, 9);
      expect(m.to.x).toBeGreaterThanOrEqual(15 - 1e-9);
      expect(m.to.x).toBeLessThanOrEqual(55 + 1e-9);
    }
    expect(at(narrow, 35, 20)).toBeCloseTo(-4, 5);
    expect(at(narrow, 13, 20)).toBeCloseTo(-4, 5); // the round end
    expect(at(narrow, 11, 20)).toBeCloseTo(0.5, 5);
    expect(at(narrow, 35, 24)).toBeCloseTo(0.5, 5);
    // 12 wide, at an angle
    const wide = run([{ type: 'mill_slot', tool: 1, x0: 15, y0: 12, x1: 55, y1: 32, width: 12, zBottom: -3, finish: 0.2 }]);
    expect(errors(wide)).toEqual([]);
    const dist = (x: number, y: number) => {
      const t = Math.min(1, Math.max(0, ((x - 15) * 40 + (y - 12) * 20) / (40 * 40 + 20 * 20)));
      return Math.hypot(x - 15 - t * 40, y - 12 - t * 20);
    };
    const m = wide.material as MillMaterial;
    let wrong = 0;
    for (let j = 0; j < m.ny; j++)
      for (let i = 0; i < m.nx; i++) {
        const [x, y] = [(i + 0.5) * m.cell, (j + 0.5) * m.cell];
        const cut = m.h[j * m.nx + i]! < 0;
        // inside the slot (by more than a cell) it is cut to depth, outside it is not touched
        if (dist(x, y) < 6 - m.cell && !cut) wrong++;
        if (dist(x, y) > 6 + m.cell && cut) wrong++;
      }
    expect(wrong).toBe(0);
    expect(errors(run([{ type: 'mill_slot', tool: 1, x0: 15, y0: 20, x1: 55, y1: 20, width: 4, zBottom: -2 }]))[0]).toMatch(/narrower than the Ø6 tool/);
  });

  it('a spot: a cone as wide at the surface as asked', () => {
    const a = run([{ type: 'mill_spot', tool: 4, points: [{ x: 20, y: 20 }, { x: 40, y: 20 }], diameter: 5 }]);
    expect(errors(a)).toEqual([]);
    // 90°: as deep as half its width
    const down = cuts(a).map((m) => m.to.z);
    expect(down.map((z) => +z.toFixed(9))).toEqual([-2, -2]);
    expect(at(a, 20.1, 20.1)).toBeLessThan(0.5 - 2.2);
    expect(at(a, 21.5, 20)).toBeCloseTo(0.5 - 1, 0);
    expect(at(a, 23, 20)).toBeCloseTo(0.5, 5);
    expect(errors(run([{ type: 'mill_spot', tool: 4, points: [{ x: 20, y: 20 }], diameter: 8 }]))[0]).toMatch(/wider than the Ø6 tool/);
    expect(errors(run([{ type: 'mill_spot', tool: 1, points: [{ x: 20, y: 20 }], diameter: 3 }]))[0]).toMatch(/TOOL_TYPE/);
  });

  it('a chamfer along an edge: the corner goes, the size asked for, the face beside it stays', () => {
    const contour: OperationInput = { type: 'mill_contour_rect', tool: 1, x: 15, y: 10, w: 40, h: 25, zBottom: -5, side: 'outside' };
    const a = run([contour, { type: 'mill_chamfer', tool: 4, x: 15, y: 10, w: 40, h: 25, size: 1 }]);
    expect(errors(a)).toEqual([]);
    expect(a.diagnostics.filter((d) => d.code === 'DOC_HIGH')).toEqual([]);
    // across the left edge (X15), on the part: at the edge 1 mm down, half a millimetre in 0.5 down, 1.3 in untouched
    const cell = (a.material as MillMaterial).cell;
    expect(at(a, 15 + cell / 2, 22)).toBeGreaterThan(0.5 - 1 - 0.01);
    expect(at(a, 15 + cell / 2, 22)).toBeLessThan(0.5 - 1 + cell + 0.01);
    // (the model's cells are a few tenths wide: within one of them)
    expect(Math.abs(at(a, 15.5, 22) - 0)).toBeLessThan(cell + 0.02);
    expect(at(a, 16.3, 22)).toBeCloseTo(0.5, 5);
    // the tool's point runs 1 mm below the chamfer and 1 mm off the wall
    const z = cuts(a).filter((m) => Math.abs(m.to.z - (0.5 - 2)) < 1e-9);
    expect(z.length).toBeGreaterThanOrEqual(4);
    expect(Math.min(...z.map((m) => m.to.x))).toBeCloseTo(15 - 1, 9);
    // the same edge without the wall cut first: the cone is buried, and the check says so
    const buried = run([{ type: 'mill_chamfer', tool: 4, x: 15, y: 10, w: 40, h: 25, size: 1 }]);
    expect(buried.diagnostics.some((d) => d.code === 'DOC_HIGH' && /cut the wall beside the edge first/.test(d.message))).toBe(true);
    // a hole's edge: around inside it; a hole smaller than the tool's reach: straight down the middle
    const hole = run([{ type: 'mill_pocket_circle', tool: 1, cx: 35, cy: 22, diameter: 14, zBottom: -4 }, { type: 'mill_chamfer', tool: 4, cx: 35, cy: 22, diameter: 14, side: 'inside', size: 0.5 }]);
    expect(errors(hole)).toEqual([]);
    expect(Math.abs(at(hole, 35 + 7 + 0.25, 22) - 0.25)).toBeLessThan(cell + 0.02);
    expect(at(hole, 35 + 7 + 0.8, 22)).toBeCloseTo(0.5, 5);
    const small = run([{ type: 'mill_chamfer', tool: 4, cx: 35, cy: 22, diameter: 2, side: 'inside', size: 0.5 }]);
    expect(errors(small)).toEqual([]);
    expect(cuts(small).map((m) => [m.to.x, m.to.y, +m.to.z.toFixed(9)])).toEqual([[35, 22, -1]]);
    // too big for the tool, or no edge named
    expect(errors(run([{ type: 'mill_chamfer', tool: 4, x: 15, y: 10, w: 40, h: 25, size: 4 }]))[0]).toMatch(/needs more cone/);
    expect(errors(run([{ type: 'mill_chamfer', tool: 4, size: 1 }]))[0]).toMatch(/say which edge/);
  });

  it('engraving: the strokes of the text at the depth asked for, where asked, turned as asked', () => {
    const a = run([{ type: 'mill_engrave', tool: 4, text: 'M8 Nr.12', x: 10, y: 20, height: 5, depth: 0.2 }]);
    expect(errors(a)).toEqual([]);
    const pts = cuts(a).map((m) => m.to);
    expect(pts.every((p) => Math.abs(p.z - 0.3) < 1e-9)).toBe(true);
    const w = textStrokes('M8 Nr.12', 5).width;
    expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(10, 6);
    expect(Math.max(...pts.map((p) => p.x))).toBeCloseTo(10 + w, 6);
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(20, 6);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(25, 6);
    // a V-bit 0.2 deep turns as fast as the spindle goes (it cuts at well under a millimetre)
    expect(a.program.segments[0]!.rpm).toBe(EXAMPLES.mill().machine.maxRpm);
    // turned a quarter: along Y instead
    const b = run([{ type: 'mill_engrave', tool: 4, text: 'M8 Nr.12', x: 40, y: 5, height: 5, depth: 0.2, angle: 90 }]);
    const q = cuts(b).map((m) => m.to);
    expect(Math.max(...q.map((p) => p.y))).toBeCloseTo(5 + w, 6);
    expect(Math.min(...q.map((p) => p.x))).toBeCloseTo(35, 6);
    // every character the font claims has strokes; small letters are smaller; umlauts have their dots
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-+=_.,:!?/()#*%°Ø<>×') expect(textStrokes(ch, 6).paths.length, ch).toBeGreaterThan(0);
    const top = (t: string) => Math.max(...textStrokes(t, 6).paths.flat().map((p) => p[1]));
    expect(top('a')).toBeCloseTo(6 * 0.72, 9);
    expect(top('Ü')).toBeGreaterThan(6.5);
    expect(textStrokes('é', 6).paths).toEqual(textStrokes('e', 6).paths);
    expect(errors(run([{ type: 'mill_engrave', tool: 4, text: 'A@B', x: 10, y: 20 }]))[0]).toMatch(/font has no "@"/);
  });

  it('after a face, the next operations start from the faced top, not the raw one', () => {
    const stock = { kind: 'block' as const, x: 80, y: 50, z: 15, top: 0.2 };
    const face: OperationInput = { type: 'mill_face', tool: 1, z: 0 };
    const go = (ops: OperationInput[]) => analyze(withOps('mill', ops, { tools, stock }));
    const opCuts = (a: ReturnType<typeof analyze>, label: string) =>
      a.program.segments.filter((s) => s.label.startsWith(label)).flatMap((s) => s.moves).filter((m) => m.type !== 'rapid');
    // engraving 0.2 deep into the faced top: down to Z-0.2, and the material shows it
    const e = go([face, { type: 'mill_engrave', tool: 4, text: 'A', x: 10, y: 20, height: 6, depth: 0.2 }]);
    expect(errors(e)).toEqual([]);
    const ez = opCuts(e, 'Engrave').map((m) => +m.to.z.toFixed(9));
    expect(ez.length).toBeGreaterThan(0);
    expect(ez.every((z) => z === -0.2)).toBe(true);
    expect(Math.min(...(e.material as MillMaterial).h)).toBeLessThan(-0.1);
    // a chamfer 0.5 wide on the faced top: the point runs 0.5 + tipClear below Z0
    const contour: OperationInput = { type: 'mill_contour_rect', tool: 1, x: 15, y: 10, w: 40, h: 25, zBottom: -5, side: 'outside' };
    const c = go([face, contour, { type: 'mill_chamfer', tool: 4, x: 15, y: 10, w: 40, h: 25, size: 0.5 }]);
    expect(errors(c)).toEqual([]);
    expect(Math.min(...opCuts(c, 'Chamfer').map((m) => m.to.z))).toBeCloseTo(-1.5, 9);
    // an explicit zTop still wins
    const x = go([face, { type: 'mill_engrave', tool: 4, text: 'A', x: 10, y: 20, height: 6, depth: 0.2, zTop: 0.2 }]);
    expect(opCuts(x, 'Engrave').every((m) => Math.abs(m.to.z) < 1e-9)).toBe(true);
  });

  it('thread milling: in a drilled hole from the bottom up, one pitch a turn, to the nominal diameter', () => {
    const drill: OperationInput = { type: 'mill_drill', tool: 3, points: [{ x: 30, y: 25 }], zBottom: -12, peck: 3 };
    const a = run([drill, { type: 'mill_thread', tool: 5, cx: 30, cy: 25, diameter: 8, pitch: 1.25, zBottom: -10 }]);
    expect(errors(a)).toEqual([]);
    const seg = a.program.segments[1]!;
    const arcs = seg.moves.filter((m) => m.type === 'arc');
    // counter-clockwise, rising
    expect(arcs.every((m) => m.type === 'arc' && !m.cw)).toBe(true);
    const helix = arcs.filter((m) => m.type === 'arc' && Math.abs(m.center.x - 30) < 1e-9);
    for (let i = 1; i < helix.length; i++) if (helix[i]!.to.z > helix[i - 1]!.to.z) expect(helix[i]!.to.z - helix[i - 1]!.to.z).toBeCloseTo(1.25 / 2, 9);
    // two passes; the last with the tool's axis at (8 − 5) / 2 from the hole's
    const radii = [...new Set(helix.map((m) => +Math.hypot(m.to.x - 30, m.to.y - 25).toFixed(4)))];
    expect(radii).toHaveLength(2);
    expect(Math.max(...radii)).toBeCloseTo(1.5, 4);
    // from below the thread's end to above the top
    expect(Math.min(...helix.map((m) => m.to.z))).toBeLessThanOrEqual(-10 + 1.25 / 2 + 1e-9);
    expect(Math.max(...helix.map((m) => m.to.z))).toBeGreaterThan(0.5);
    // it reads back as G3 with a Z word
    const text = emit(withOps('mill', [], { tools }), a.program).text;
    expect(text).toMatch(/^G3 X[\d.]+ Y[\d.]+ Z-[\d.]+ I-?[\d.]+ J/m);
    // left-hand: from the top down; no hole: an error; a cutter too big for the core hole: an error
    const lh = run([drill, { type: 'mill_thread', tool: 5, cx: 30, cy: 25, diameter: 8, pitch: 1.25, zBottom: -10, hand: 'left' }]);
    expect(errors(lh)).toEqual([]);
    const lz = lh.program.segments[1]!.moves.filter((m) => m.type === 'arc' && Math.abs(m.center.x - 30) < 1e-9).map((m) => m.to.z);
    expect(lz[1]!).toBeLessThan(lz[0]!);
    expect(errors(run([{ type: 'mill_thread', tool: 5, cx: 30, cy: 25, diameter: 8, pitch: 1.25, zBottom: -10 }])).some((e) => e.startsWith('THREAD_NO_HOLE'))).toBe(true);
    expect(errors(run([drill, { type: 'mill_thread', tool: 5, cx: 30, cy: 25, diameter: 6, pitch: 1, zBottom: -8 }]))[0]).toMatch(/does not fit/);
  });

  it('thread milling a boss: clockwise from the top down, the tool outside it', () => {
    // a Ø12 boss left standing by a contour around it
    const ring = Array.from({ length: 72 }, (_, i): [number, number] => [30 + 6 * Math.cos((2 * Math.PI * i) / 72), 25 + 6 * Math.sin((2 * Math.PI * i) / 72)]);
    const boss = { id: 'b', name: 'boss', at: { x: 0, y: 0 }, paths: [{ closed: true, pts: ring }] };
    const a = analyze(withOps('mill', [
      { type: 'mill_contour', tool: 1, shape: 'b', side: 'outside', zBottom: -8 },
      { type: 'mill_contour', tool: 1, shape: 'b', side: 'outside', zBottom: -8, finish: 0, label: 'wider', feed: 300 },
      { type: 'mill_thread', tool: 5, cx: 30, cy: 25, diameter: 12, pitch: 1.75, zBottom: -6, side: 'external' },
    ], { tools, shapes: [boss] }));
    const seg = a.program.segments.at(-1)!;
    const helix = seg.moves.filter((m) => m.type === 'arc');
    expect(helix.every((m) => m.type === 'arc' && m.cw)).toBe(true);
    expect(helix[1]!.to.z).toBeLessThan(helix[0]!.to.z);
    // 0.61343 P deep at the last pass
    const radii = helix.map((m) => Math.hypot(m.to.x - 30, m.to.y - 25));
    expect(Math.min(...radii)).toBeCloseTo(6 + 2.5 - 0.61343 * 1.75, 4);
  });
});

describe('the height map', () => {
  // what the model did cell by cell before it went a row at a time: every cell centre in the
  // circle, tested by its distance, cut to the tool's surface there (a pointed cutter: its cone)
  function reference(m: { cell: number; nx: number; ny: number; bottom: number; h: Float32Array }, points: Vec3[], tool: Tool): { depth: number; lowered: number } {
    const lift = (d2: number) => (tool.type === 'chamfer' ? Math.max(0, Math.sqrt(d2) - cone(tool).tipR) * (1 / cone(tool).tan) : 0);
    const each = (p: Vec3, r: number, fn: (k: number, d2: number) => void) => {
      if (r <= 0) return;
      const c = m.cell;
      for (let j = Math.max(0, Math.floor((p.y - r) / c)); j <= Math.min(m.ny - 1, Math.floor((p.y + r) / c)); j++)
        for (let i = Math.max(0, Math.floor((p.x - r) / c)); i <= Math.min(m.nx - 1, Math.floor((p.x + r) / c)); i++) {
          const dx = (i + 0.5) * c - p.x;
          const dy = (j + 0.5) * c - p.y;
          if (dx * dx + dy * dy <= r * r) fn(j * m.nx + i, dx * dx + dy * dy);
        }
    };
    let depth = 0;
    let lowered = 0;
    for (const p of points)
      each(p, tool.diameter! / 2 - m.cell, (k, d2) => {
        if (m.h[k]! > m.bottom + 0.02) depth = Math.max(depth, m.h[k]! - Math.max(p.z + lift(d2), m.bottom));
      });
    for (const p of points)
      each(p, tool.diameter! / 2, (k, d2) => {
        const z = Math.max(p.z + lift(d2), m.bottom);
        if (m.h[k]! > z + 1e-6) {
          if (m.h[k]! > z + 0.01) lowered++;
          m.h[k] = z;
        }
      });
    return { depth, lowered };
  }

  it('takes off exactly the cells under the cutter, for flat and pointed cutters', () => {
    const tools: Tool[] = [
      { id: 1, name: 'e6', type: 'endmill', diameter: 6, flutes: 3 },
      { id: 2, name: 'e1', type: 'endmill', diameter: 1, flutes: 2 },
      { id: 3, name: 'd', type: 'drill', diameter: 2.5 },
      { id: 4, name: 'c90', type: 'chamfer', diameter: 10, angle: 90, tipDiameter: 0.5 },
      { id: 5, name: 'c60', type: 'chamfer', diameter: 6, angle: 60 },
    ];
    let s = 1;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (const cell of [0.2, 1 / 3, 0.5]) {
      const stock = { kind: 'block' as const, x: 30, y: 20, z: 8, top: 0 };
      const m = new MillMaterial(stock, cell);
      const ref = new MillMaterial(stock, cell);
      for (let n = 0; n < 150; n++) {
        const tool = tools[n % tools.length]!;
        // every third move on the grid's half cells, where centres fall right on the circle's rim
        const q = (v: number) => (n % 3 ? v : (Math.round((v / cell) * 2) / 2) * cell);
        const pts = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => ({ x: q(rnd() * 36 - 3), y: q(rnd() * 26 - 3), z: -rnd() * 9 }));
        const before = m.lowered;
        const depth = m.cutPath(pts, tool);
        const want = reference(ref, pts, tool);
        expect([depth, m.lowered - before]).toEqual([want.depth, want.lowered]);
      }
      expect(m.h).toEqual(ref.h);
    }
  });
});
