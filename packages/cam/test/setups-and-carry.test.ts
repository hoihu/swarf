import { describe, expect, it } from 'vitest';
import { parseGcode } from './support/parse.ts';
import { codes, withOps } from './support/fixtures.ts';
import {
  EXAMPLES,
  carried,
  plainSetup,
  unmapPoint,
  mapPoint,
  faceAfter,
  turnedSize,
  setupList,
  setupJobs,
  switchSetup,
  addSetup,
  removeSetup,
  renameSetup,
  leftBy,
  alignProgram,
  surfaceAt,
  isAligned,
  jobFile,
  openJobFile,
  Job,
  MillMaterial,
  analyze,
  hasErrors,
  emit,
} from '../src/index.ts';
import type { JobInput } from '../src/schema.ts';

describe('the block as measured on the machine', () => {
  const engrave = (patch: Partial<JobInput> = {}, follow = true) =>
    withOps('mill', [{ type: 'mill_engrave', tool: 4, text: 'AB', x: 10, y: 10, height: 8, depth: 0.2, follow }], { stock: { kind: 'block', x: 80, y: 50, z: 15, top: 0 }, ...patch });
  const xyz = (text: string) => {
    // the positions the G-code visits (modal axes)
    const at = { x: 0, y: 0, z: 0 };
    const out: (typeof at & { g: string })[] = [];
    let g = '';
    for (const line of text.split('\n')) {
      if (!/^(G[0-3] |[XYZ])/.test(line)) continue;
      const m = /^G([0-3])\b/.exec(line);
      if (m) g = m[1]!;
      for (const [, a, v] of line.matchAll(/([XYZ])(-?[\d.]+)/g)) at[a!.toLowerCase() as 'x'] = Number(v);
      out.push({ ...at, g });
    }
    return out;
  };

  it('a surface through touched points: exact at them, the plane far away', () => {
    const tilt = (x: number, y: number) => 0.1 + 0.002 * x - 0.001 * y;
    const pts = [0, 40, 80].flatMap((x) => [0, 25, 50].map((y) => ({ x, y, z: tilt(x, y) })));
    const s = surfaceAt(pts)!;
    expect(s(40, 25)).toBeCloseTo(tilt(40, 25), 9);
    expect(s(13, 31)).toBeCloseTo(tilt(13, 31), 9);
    expect(s(200, -100)).toBeCloseTo(tilt(200, -100), 6);
    // a bump at one point stays local
    const bumped = pts.map((p) => (p.x === 40 && p.y === 25 ? { ...p, z: p.z + 0.3 } : p));
    const b = surfaceAt(bumped)!;
    expect(b(40, 25)).toBeCloseTo(tilt(40, 25) + 0.3, 9);
    expect(Math.abs(b(0, 0) - tilt(0, 0))).toBeLessThan(1e-9);
    expect(b(38, 25) - tilt(38, 25)).toBeGreaterThan(0.2);
    expect(surfaceAt(pts.slice(0, 2))).toBeNull();
    expect(surfaceAt([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }])).toBeNull();
  });

  it('nothing measured, nothing changed', () => {
    const job = EXAMPLES.mill();
    const a = analyze(job);
    expect(isAligned(job)).toBe(false);
    expect(alignProgram(job, a.program)).toBe(a.program);
    expect(emit({ ...job, measured: { angle: 0, top: [] } }, a.program).text).toBe(emit(job, a.program).text);
  });

  it('turns the whole toolpath about the zero by the measured angle, arcs staying arcs', () => {
    const job = EXAMPLES.mill();
    const turned = Job.parse({ ...job, measured: { angle: 0.5 } });
    const a = analyze(job);
    const plain = emit(job, a.program);
    const out = emit(turned, analyze(turned).program);
    expect(out.text).toMatch(/\(measured: toolpath turned 0\.50 deg about X0 Y0/);
    expect(out.lineOfMove).toHaveLength(plain.lineOfMove.length);
    const p = xyz(plain.text);
    const q = xyz(out.text);
    expect(q).toHaveLength(p.length);
    const c = Math.cos((0.5 * Math.PI) / 180);
    const s = Math.sin((0.5 * Math.PI) / 180);
    for (let i = 0; i < p.length; i++) {
      expect(q[i]!.x).toBeCloseTo(p[i]!.x * c - p[i]!.y * s, 2);
      expect(q[i]!.y).toBeCloseTo(p[i]!.x * s + p[i]!.y * c, 2);
      expect(q[i]!.z).toBe(p[i]!.z);
    }
    // the G-code parses, arcs and all, and ends where it should
    const parsed = parseGcode(out.text, 'mill');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.moves.filter((m) => m.move.type === 'arc').length).toBe(parseGcode(plain.text, 'mill').moves.filter((m) => m.move.type === 'arc').length);
    // the checks say that they looked at the block as drawn
    expect(analyze(turned).diagnostics.map((d) => d.code)).toContain('TURNED');
    expect(hasErrors(analyze(turned).diagnostics)).toBe(false);
  });

  it('keeps an engraving at its depth against the touched top', () => {
    // a top that rises 0.4 mm over the block's length, with a 0.15 mm hump in the middle
    const top = (x: number, y: number) => 0.005 * x + 0.15 * Math.exp(-((x - 30) ** 2 + (y - 15) ** 2) / 200);
    const pts = [0, 10, 20, 30, 40, 50, 60, 70, 80].flatMap((x) => [0, 10, 20, 30, 40, 50].map((y) => ({ x, y, z: top(x, y) })));
    const job = engrave({ measured: { angle: 0, top: pts } });
    const a = analyze(job);
    expect(hasErrors(a.diagnostics)).toBe(false);
    const out = emit(job, a.program);
    expect(out.text).toMatch(/\(measured: op1 follows the top as touched at 54 points\)/);
    expect(out.lineOfMove).toHaveLength(a.moves);
    const cuts = xyz(out.text).filter((p) => p.g === '1' && p.z < 0.6);
    expect(cuts.length).toBeGreaterThan(30);
    // every cutting position is 0.2 mm under the real top (the hump between points 10 mm apart is guessed: within 0.04)
    const bottoms = cuts.filter((p) => p.z < top(p.x, p.y) - 0.1);
    expect(bottoms.length).toBeGreaterThan(20);
    for (const p of bottoms) expect(Math.abs(top(p.x, p.y) - 0.2 - p.z)).toBeLessThan(0.04);
    // and no piece of a cut is longer than a millimetre
    const all = xyz(out.text);
    for (let i = 1; i < all.length; i++) {
      if (all[i]!.g === '1' && all[i - 1]!.g === '1') expect(Math.hypot(all[i]!.x - all[i - 1]!.x, all[i]!.y - all[i - 1]!.y)).toBeLessThan(1.01);
    }
    // without the flag the same job is cut flat
    const flat = engrave({ measured: { angle: 0, top: pts } }, false);
    const zs = new Set(xyz(emit(flat, analyze(flat).program).text).filter((p) => p.g === '1').map((p) => p.z));
    expect(zs.size).toBeLessThanOrEqual(2);
  });

  it('says so when an operation is to follow a top that was never touched, or touched elsewhere, or stands too high', () => {
    expect(codes(engrave())).toContain('FOLLOW_NO_TOP');
    const corner = [{ x: 60, y: 30, z: 0 }, { x: 80, y: 30, z: 0 }, { x: 60, y: 50, z: 0 }, { x: 80, y: 50, z: 0.01 }];
    expect(codes(engrave({ measured: { angle: 0, top: corner } }))).toContain('FOLLOW_OUTSIDE');
    const high = [0, 80].flatMap((x) => [0, 50].map((y) => ({ x, y, z: 1.8 })));
    const a = analyze(engrave({ measured: { angle: 0, top: high } }));
    expect(a.diagnostics.find((d) => d.code === 'FOLLOW_HIGH')?.severity).toBe('error');
    expect(() => Job.parse({ ...EXAMPLES.mill(), measured: { angle: 12 } })).toThrow();
  });

  it('turned and followed at once: the top is looked up where the tool really is', () => {
    const top = (x: number, y: number) => 0.004 * x - 0.003 * y;
    const pts = [-10, 20, 50, 90].flatMap((x) => [-5, 20, 55].map((y) => ({ x, y, z: top(x, y) })));
    const job = engrave({ measured: { angle: 2, top: pts } });
    const cuts = xyz(emit(job, analyze(job).program).text).filter((p) => p.g === '1' && p.z < top(p.x, p.y) - 0.1);
    expect(cuts.length).toBeGreaterThan(10);
    for (const p of cuts) expect(p.z).toBeCloseTo(top(p.x, p.y) - 0.2, 2);
  });
});

describe('a part in several setups', () => {
  const block = { kind: 'block' as const, x: 80, y: 50, z: 15, top: 0 };

  it('says where the faces go, and how large the block lies', () => {
    expect(faceAfter('front-up', 'front')).toBe('top');
    expect(faceAfter('front-up', 'top')).toBe('back');
    expect(faceAfter('back-up', 'top')).toBe('front');
    expect(faceAfter('left-up', 'top')).toBe('right');
    expect(faceAfter('right-up', 'right')).toBe('top');
    expect(faceAfter('over-y', 'top')).toBe('bottom');
    expect(faceAfter('over-y', 'left')).toBe('right');
    expect(faceAfter('over-y', 'front')).toBe('front');
    expect(faceAfter('over-x', 'front')).toBe('back');
    expect(faceAfter('over-x', 'left')).toBe('left');
    expect(faceAfter('quarter', 'front')).toBe('right');
    expect(turnedSize('front-up', block)).toEqual({ x: 80, y: 15, z: 50 });
    expect(turnedSize('left-up', block)).toEqual({ x: 15, y: 50, z: 80 });
    expect(turnedSize('over-y', block)).toEqual({ x: 80, y: 50, z: 15 });
    expect(turnedSize('quarter', block)).toEqual({ x: 50, y: 80, z: 15 });
  });

  it('carries a point over a turn: a hole near the front-left corner of the top', () => {
    // 10 from the left, 5 from the front, on the top
    const p = { x: 10, y: 5, z: 0 };
    const to = (turn: Parameters<typeof mapPoint>[0]) => {
      const s = turnedSize(turn, block);
      const q = mapPoint(turn, block, { kind: 'block', ...s, top: 0 }, p);
      return [q.x, q.y, q.z].map((v) => Math.round(v * 1000) / 1000);
    };
    // flipped left to right: now 10 from the RIGHT, still 5 from the front, on the underside
    expect(to('over-y')).toEqual([70, 5, -15]);
    // flipped front to back: still 10 from the left, now 5 from the BACK
    expect(to('over-x')).toEqual([10, 45, -15]);
    // front face up: the old top faces the back; the point is 5 mm under the new top, at the back
    expect(to('front-up')).toEqual([10, 15, -5]);
    expect(to('back-up')).toEqual([10, 0, -45]);
    // left face up: the old top faces right; the point is 10 under the new top
    expect(to('left-up')).toEqual([15, 5, -10]);
    expect(to('right-up')).toEqual([0, 5, -70]);
    expect(to('quarter')).toEqual([45, 10, 0]);
    // turned twice the same way over, it is back where it was
    const s = { ...block };
    const back = mapPoint('over-y', s, s, mapPoint('over-y', s, s, p));
    expect([back.x, back.y, back.z].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([10, 5, 0]);
    // and a raw top is taken into account: Z is measured from each setup's own zero
    const raw = mapPoint('over-y', { ...block, top: 0.5 }, { ...block, top: 0 }, { x: 10, y: 5, z: 0.5 });
    expect(raw.z).toBeCloseTo(-15, 6);
  });

  it('a job without setups is one setup, and stays as it was', () => {
    const job = EXAMPLES.mill();
    expect(setupList(job).setups.map((s) => s.name)).toEqual(['Setup 1']);
    expect(setupJobs(job)).toEqual([job]);
    expect(switchSetup(job, 0)).toBe(job);
    expect(() => switchSetup(job, 1)).toThrow(/no setup 2/);
    expect(() => removeSetup(job)).toThrow(/needs one setup/);
    expect(() => addSetup(EXAMPLES.lathe(), 'over-y', undefined, { x: 1, y: 1, z: 1 })).toThrow(/for the mill/);
  });

  it('adds a setup with the block turned, switches between them, and keeps each one apart', () => {
    const first = Job.parse({ ...EXAMPLES.mill(), notes: 'in the vise', obstacles: [{ name: 'jaw', x0: -5, y0: 50, x1: 85, y1: 60, top: 5 }] });
    const size = leftBy(first, analyze(first));
    // the example faces 0.5 off a 15 mm block and cuts no outline
    expect(size).toEqual({ x: 80, y: 50, z: 14.5, ox: 0, oy: 0, oz: 0 });
    let job = addSetup(first, 'front-up', undefined, size);
    expect(job.setups).toMatchObject({ at: 1, name: 'Front face up', turn: 'front-up' });
    expect(job.stock).toEqual({ kind: 'block', x: 80, y: 14.5, z: 50, top: 0 });
    expect(job.operations).toEqual([]);
    expect(job.obstacles).toEqual([]);
    expect(job.notes).toBeUndefined();
    expect(job.tools).toEqual(first.tools);
    // work on the second: a hole in what was the front face
    job = Job.parse({ ...job, operations: [{ type: 'mill_drill', tool: 3, points: [{ x: 40, y: 7 }], zBottom: -12, zTop: 0, peck: 3 }], notes: 'on edge, against the stop' });
    expect(hasErrors(analyze(job).diagnostics)).toBe(false);
    expect(setupList(job).setups.map((s) => `${s.name}: ${s.operations.length} ops`)).toEqual(['Setup 1: 3 ops', 'Front face up: 1 ops']);
    // back to the first: it is as it was, and the second waits
    const again = switchSetup(job, 0);
    expect(again.operations).toEqual(first.operations);
    expect(again.stock).toEqual(first.stock);
    expect(again.notes).toBe('in the vise');
    expect(again.obstacles).toHaveLength(1);
    expect(again.setups!.others[0]!.notes).toBe('on edge, against the stop');
    expect(switchSetup(again, 1)).toEqual(job);
    // each setup is a whole job of its own for the checks and the G-code
    const each = setupJobs(again);
    expect(each.map((j) => j.operations.length)).toEqual([3, 1]);
    expect(each.map((j) => emit(j, analyze(j).program).text.includes('M30'))).toEqual([true, true]);
    // the file keeps all of it
    expect(openJobFile(jobFile(job))).toEqual(job);
    // a third, in between; names stay apart
    const third = addSetup(again, 'front-up', undefined, size);
    expect(setupList(third).setups.map((s) => s.name)).toEqual(['Setup 1', 'Front face up 2', 'Front face up']);
    expect(renameSetup(third, ' Rear holes ').setups!.name).toBe('Rear holes');
    // taking the second out leaves the first in hand, and with one left the job is plain again
    const one = removeSetup(job);
    expect(one.setups).toBeUndefined();
    expect(one.operations).toEqual(first.operations);
  });

  it('what a setup leaves: an outline cut round to full depth is the size that is turned', () => {
    const job = withOps('mill', [
      { type: 'mill_face', tool: 2, z: 0 },
      { type: 'mill_contour_rect', tool: 1, x: 10, y: 10, w: 50, h: 30, zBottom: -15, side: 'outside', tabs: 0 },
    ], { stock: { kind: 'block', x: 80, y: 50, z: 15.5, top: 0.5 } });
    const s = leftBy(job, analyze(job));
    expect(s.z).toBe(15);
    expect(Math.abs(s.x - 50)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(s.y - 30)).toBeLessThanOrEqual(0.5);
    // and where it sits in the stock it was cut from
    expect(Math.abs(s.ox - 10)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(s.oy - 10)).toBeLessThanOrEqual(0.3);
  });
});

describe('the part carried over a turn', () => {
  // setup 1: a pocket in the top (X20..60, Y15..35, 5 deep) and a Ø5 hole through at X8 Y8
  const first = withOps('mill', [
    { type: 'mill_pocket_rect', tool: 1, x: 20, y: 15, w: 40, h: 20, zBottom: -5, zTop: 0, finish: 0 },
    { type: 'mill_drill', tool: 3, points: [{ x: 8, y: 8 }], zBottom: -17, zTop: 0, peck: 3 },
  ], { stock: { kind: 'block', x: 80, y: 50, z: 15, top: 0 } });
  const turned = (turn: 'front-up' | 'over-y') => addSetup(first, turn, undefined, leftBy(first, analyze(first)));
  const spansAt = (m: MillMaterial, x: number, y: number) => {
    const k = Math.floor(y / m.cell) * m.nx + Math.floor(x / m.cell);
    const out: number[] = [];
    for (let a = m.spans!.at[k]!; a < m.spans!.at[k + 1]!; a++) out.push(Math.round(m.spans!.z[a]! * 10) / 10);
    return out;
  };

  it('there and back is the same point', () => {
    const a = { kind: 'block' as const, x: 80, y: 50, z: 15, top: 0.5 };
    for (const turn of ['over-y', 'over-x', 'front-up', 'back-up', 'left-up', 'right-up', 'quarter', 'none'] as const) {
      const b = { kind: 'block' as const, ...turnedSize(turn, a), top: 0 };
      const p = { x: 12, y: 7, z: -3 };
      const q = unmapPoint(turn, a, b, mapPoint(turn, a, b, p));
      expect([q.x, q.y, q.z].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([12, 7, -3]);
    }
  });

  it('flipped over: the pocket is underneath, the hole shows from above', () => {
    const job = turned('over-y');
    expect(job.setups!.from).toEqual({ x: 80, y: 50, z: 15, ox: 0, oy: 0, oz: 0 });
    const m = analyze(job).material as MillMaterial;
    const at = (x: number, y: number) => m.h[Math.floor(y / m.cell) * m.nx + Math.floor(x / m.cell)]!;
    // the top (the old underside) is whole, but for the hole: now 8 from the RIGHT
    expect(at(40, 25)).toBeCloseTo(0, 5);
    expect(at(72, 8)).toBeCloseTo(-15, 5);
    expect(at(8, 8)).toBeCloseTo(0, 5);
    // under the top where the pocket is: metal from 10 below the top only (the pocket is the 5 under that)
    const s = spansAt(m, 40, 25);
    expect(s).toHaveLength(2);
    expect(Math.abs(s[0]! - -10)).toBeLessThanOrEqual(0.3);
    expect(s[1]).toBe(0);
    expect(spansAt(m, 10, 40).map((v) => Math.round(v))).toEqual([-15, 0]);
    expect(spansAt(m, 72, 8)).toEqual([]);
  });

  it('front face up: the pocket is a hollow in the back wall, the hole a tunnel from front to back', () => {
    const job = turned('front-up');
    expect(job.stock).toMatchObject({ x: 80, y: 15, z: 50 });
    const m = analyze(job).material as MillMaterial;
    // the old top is at the back (Y 15): 5 deep from there, between 15 and 35 under the new top
    const s = spansAt(m, 40, 13);
    expect(s).toHaveLength(4);
    expect(s[0]).toBe(-50);
    expect(Math.abs(s[1]! - -35)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(s[2]! - -15)).toBeLessThanOrEqual(0.3);
    expect(s[3]).toBe(0);
    // in front of the pocket's floor the column is whole
    expect(spansAt(m, 40, 5).map((v) => Math.round(v))).toEqual([-50, 0]);
    // the hole: 8 from the old front is 8 under the new top, through from front to back
    for (const y of [1, 7, 14]) {
      const t = spansAt(m, 8, y);
      expect(t).toHaveLength(4);
      expect(Math.abs(t[1]! - -10.5)).toBeLessThanOrEqual(0.4);
      expect(Math.abs(t[2]! - -5.5)).toBeLessThanOrEqual(0.4);
    }
    // nothing is cut yet: the top is whole
    expect(Math.min(...m.h)).toBeCloseTo(0, 5);
  });

  it('cutting goes on from there: air where the setup before cut, metal elsewhere', () => {
    // flipped, a hole drilled where the first setup's hole comes out: nothing to cut
    const air = Job.parse({ ...turned('over-y'), operations: [{ type: 'mill_drill', tool: 3, points: [{ x: 72, y: 8 }], zBottom: -10, zTop: 0, peck: 3 }] });
    const plain = plainSetup(air);
    expect(plain.setups!.from).toBeUndefined();
    const cut = (j: Job) => {
      const before = carried(j);
      const m = analyze(j).material as MillMaterial;
      let n = 0;
      for (let k = 0; k < m.h.length; k++) if (m.h[k]! < (before ? before.h[k]! : 0) - 0.01) n++;
      return n;
    };
    expect(cut(air)).toBe(0);
    expect(cut(plain)).toBeGreaterThan(50);
    // a pocket from the new top down to the old one's floor: they meet, and the column is empty of metal above
    const through = Job.parse({ ...turned('over-y'), operations: [{ type: 'mill_pocket_rect', tool: 1, x: 25, y: 20, w: 30, h: 10, zBottom: -10, zTop: 0, finish: 0 }] });
    const m = analyze(through).material as MillMaterial;
    expect(m.h[Math.floor(25 / m.cell) * m.nx + Math.floor(40 / m.cell)]!).toBeCloseTo(-10, 5);
    expect(hasErrors(analyze(through).diagnostics)).toBe(false);
  });

  it('a third setup carries both before it; a change in the first reaches the last; a plain block does not', () => {
    let job = Job.parse({ ...turned('over-y'), operations: [{ type: 'mill_drill', tool: 3, points: [{ x: 40, y: 42 }], zBottom: -17, zTop: 0, peck: 3 }] });
    job = addSetup(job, 'front-up', undefined, leftBy(job, analyze(job)));
    const m = analyze(job).material as MillMaterial;
    // setup 2's hole (X40 Y42 there): after front-up it is 42 under the top, through front to back
    const t = spansAt(m, 40, 7);
    expect(t).toHaveLength(4);
    expect(Math.abs((t[1]! + t[2]!) / 2 - -42)).toBeLessThanOrEqual(0.4);
    // setup 1's hole: flipped to X72, then front-up: 8 under the top
    const u = spansAt(m, 72, 7);
    expect(Math.abs((u[1]! + u[2]!) / 2 - -8)).toBeLessThanOrEqual(0.4);
    // setup 1's pocket, on the underside in setup 2, is now at the FRONT (Y 0..5)
    // (with setup 2's tunnel under it, which runs through every column at X40)
    expect(spansAt(m, 40, 2)).toHaveLength(6);
    expect(spansAt(m, 40, 12)).toHaveLength(4);
    // take the pocket out of the first setup: it is gone from the third
    const first2 = switchSetup(job, 0);
    const without = switchSetup({ ...first2, operations: first2.operations.slice(1) }, 2);
    const m2 = analyze(without).material as MillMaterial;
    expect(spansAt(m2, 40, 2)).toHaveLength(4);
    // and as a plain block nothing comes over
    expect((analyze(plainSetup(job)).material as MillMaterial).spans).toBeNull();
    expect(carried(first)).toBeNull();
  });

  it('is quick the second time', () => {
    const job = turned('front-up');
    analyze(job);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) carried(job);
    expect((performance.now() - t0) / 20).toBeLessThan(15);
  });
});
