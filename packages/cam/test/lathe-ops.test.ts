import { describe, expect, it } from 'vitest';
import { parseGcode } from './support/parse.ts';
import { codes, withOps } from './support/fixtures.ts';
import {
  EXAMPLES,
  Job,
  LatheMaterial,
  analyze,
  emit,
  walk,
  buildProfile,
  tipPath,
  zAtRadius,
  samplePath,
  type Program,
  type OperationInput,
} from '../src/index.ts';

describe('nose radius', () => {
  it('lengthens a 45° chamfer by rn·(2 − √2) on each leg', () => {
    const job = withOps('lathe', [{ type: 'lathe_chamfer', tool: 1, diameter: 20, z: 0, size: 1 }]);
    const feeds = [...walk(analyze(job).program)].filter((w) => w.move.type === 'feed').map((w) => w.move.to);
    const e = 0.4 * (2 - Math.SQRT2);
    expect(feeds[0]!.x).toBeCloseTo(9 - e, 6);
    expect(feeds[1]!.z).toBeCloseTo(-1 - e, 6);
    const sharp = Job.parse({ ...job, tools: job.tools.map((t) => (t.id === 1 ? { ...t, noseRadius: 0 } : t)) });
    expect([...walk(analyze(sharp).program)].filter((w) => w.move.type === 'feed')[0]!.move.to.x).toBeCloseTo(9, 6);
  });
});

describe('profile turning', () => {
  const shaft = (extra: Partial<OperationInput> = {}) =>
    withOps('lathe', [
      {
        type: 'lathe_profile',
        tool: 1,
        points: [{ d: 0, z: 0 }, { d: 10, z: 0, c: 0.5 }, { d: 10, z: -12 }, { d: 16, z: -12, r: 1 }, { d: 16, z: -30 }],
        ...extra,
      } as OperationInput,
    ]);

  it('turns a stepped shaft with chamfer and radius in one operation', () => {
    const a = analyze(shaft());
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const m = a.material as LatheMaterial;
    const r = (z: number) => m.r[Math.floor((z - m.z0) / m.dz)]!;
    expect(r(0.5)).toBe(0); // faced
    expect(r(-6)).toBeCloseTo(5, 1);
    expect(r(-20)).toBeCloseTo(8, 1);
    expect(r(-40)).toBeCloseTo(12.5, 2); // untouched behind the profile
  });

  it('offsets a 45° chamfer like the textbook nose radius compensation', () => {
    const profile = buildProfile([{ d: 18, z: 0 }, { d: 20, z: -1 }, { d: 20, z: -5 }]);
    const tip = tipPath(profile, 0.4);
    const e = 0.4 * (2 - Math.SQRT2);
    // the straight part of the tip path along the chamfer: x + z = 9 − rn·(2 − √2)
    for (const p of tip.slice(0, 2)) expect(p.x + p.z).toBeCloseTo(9 - e, 6);
    // and the tip comes back onto the diameter
    expect(tip.at(-1)!.x).toBeCloseTo(10, 9);
  });

  it('rounds corners with the given radius', () => {
    const p = buildProfile([{ d: 0, z: 0 }, { d: 10, z: 0, r: 2 }, { d: 10, z: -10 }]);
    // every arc point lies 2 mm from the fillet centre (x 3, z −2)
    const arc = p.filter((q) => q.x > 3 + 1e-6 && q.z < -1e-6 && q.z > -2 + 1e-6);
    expect(arc.length).toBeGreaterThan(3);
    for (const q of arc) expect(Math.hypot(q.x - 3, q.z + 2)).toBeCloseTo(2, 6);
  });

  it('refuses undercuts and backwards points', () => {
    expect(codes(withOps('lathe', [{ type: 'lathe_profile', tool: 1, points: [{ d: 16, z: 0 }, { d: 10, z: -10 }] }]))).toContain('OP_INVALID');
    expect(codes(withOps('lathe', [{ type: 'lathe_profile', tool: 1, points: [{ d: 10, z: -10 }, { d: 12, z: 0 }] }]))).toContain('OP_INVALID');
  });

  it('roughs, semi-finishes and finishes', () => {
    const feeds = [...walk(analyze(shaft()).program)].filter((w) => w.move.type === 'feed');
    // the finish pass reaches the inside corner of the last shoulder exactly, the semi-finish stays 0.2 mm off it
    const at = (x: number, z: number) => feeds.some((w) => Math.abs(w.move.to.x - x) < 1e-6 && Math.abs(w.move.to.z - z) < 1e-6);
    expect(at(8, -30)).toBe(true);
    expect(at(8.2, -29.8)).toBe(true);
  });
});

describe('boring and internal threads', () => {
  const tools = () => {
    const t = EXAMPLES.lathe().tools.filter((x) => x.id !== 3);
    return [...t, { id: 3, name: 'Drill Ø12', type: 'drill' as const, diameter: 12, vc: 20, feedPerRev: 0.1, fluteLength: 60 }];
  };
  const job = (ops: OperationInput[], sync = true) => {
    const base = EXAMPLES.lathe();
    return withOps('lathe', ops, { tools: tools(), stock: { kind: 'bar', diameter: 40, stickout: 50, front: 1 }, machine: { ...base.machine, spindleSync: sync } });
  };
  const drill: OperationInput = { type: 'lathe_drill', tool: 3, depth: 25, peck: 5 };
  const bore: OperationInput = { type: 'lathe_bore', tool: 5, diameter: 16.4, fromDiameter: 12, zEnd: -20 };

  it('bores a drilled hole to size', () => {
    const a = analyze(job([{ type: 'lathe_face', tool: 1 }, drill, bore]));
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const m = a.material as LatheMaterial;
    expect(m.boreAt(-10)).toBeCloseTo(8.2, 1);
    expect(m.boreAt(-22)).toBeCloseTo(6, 1); // only the drill below the bore
    expect(m.radiusAt(-10)).toBeCloseTo(20, 3);
  });

  it('notices boring into solid material', () => {
    expect(codes(job([bore]))).toContain('BORE_SOLID');
  });

  it('refuses a bar that does not fit or reach', () => {
    expect(codes(job([drill, { ...bore, fromDiameter: 8 } as OperationInput]))).toContain('OP_INVALID');
    expect(codes(job([drill, { ...bore, zEnd: -40 } as OperationInput]))).toContain('OP_INVALID');
  });

  it('cuts an internal thread outwards from the minor diameter', () => {
    const j = job([drill, bore, { type: 'lathe_thread', side: 'internal', tool: 6, diameter: 18, pitch: 1.5, zEnd: -15, infeed: 'radial' } as OperationInput]);
    const a = analyze(j);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const xs = [...walk(a.program)].filter((w) => w.move.type === 'thread').map((w) => w.move.to.x);
    const minor = 9 - 0.54127 * 1.5;
    expect(xs[0]! - minor).toBeCloseTo(0.25, 1);
    expect(xs.at(-1)).toBeCloseTo(9, 6);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]! - 1e-9);
  });

  it('matches internal tools to internal threads', () => {
    expect(codes(job([drill, bore, { type: 'lathe_thread', side: 'internal', tool: 4, diameter: 18, pitch: 1.5, zEnd: -15 } as OperationInput]))).toContain('OP_INVALID');
  });
});

describe('threading', () => {
  const threadJob = (op: Partial<OperationInput> = {}, sync = true) => {
    const base = EXAMPLES.lathe();
    return withOps('lathe', [{ type: 'lathe_turn', tool: 1, diameter: 12, zEnd: -20 }, { type: 'lathe_thread', tool: 4, diameter: 12, pitch: 1.75, zEnd: -15, ...op } as OperationInput], {
      machine: { ...base.machine, spindleSync: sync },
    });
  };
  const passes = (job: Job) => [...walk(analyze(job).program)].filter((w) => w.move.type === 'thread');

  it('multi-start: each start one pitch further out at every depth, G33 K is the lead', () => {
    const job = threadJob({ pitch: 1.5, starts: 2, infeed: 'radial', springPasses: 0 });
    expect(analyze(job).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const p = passes(job);
    const single = passes(threadJob({ pitch: 1.5, infeed: 'radial', springPasses: 0 }));
    expect(p.length).toBe(single.length * 2);
    for (const w of p) expect((w.move as { pitch: number }).pitch).toBe(3);
    // the two starts of a depth: same X, starting Z one pitch apart
    for (let i = 0; i < p.length; i += 2) {
      expect(p[i]!.move.to.x).toBeCloseTo(p[i + 1]!.move.to.x, 9);
      expect(p[i + 1]!.from.z - p[i]!.from.z).toBeCloseTo(1.5, 9);
    }
    // depth from the pitch (the profile), not from the lead
    expect(6 - Math.min(...p.map((w) => w.move.to.x))).toBeCloseTo(0.61343 * 1.5, 4);
    const text = emit(job, analyze(job).program).text;
    expect(text).toMatch(/^G33 Z-15 K3$/m);
    expect(text).toContain('M12×Ph3P1.5, 2 starts to Z-15');
  });

  it('needs a controller with spindle sync', () => {
    expect(codes(threadJob({}, false))).toContain('THREAD_SYNC');
    expect(analyze(threadJob()).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('cuts to the ISO depth in passes of decreasing depth, plus a spring pass', () => {
    const p = passes(threadJob({ infeed: 'radial' }));
    const depths = p.map((w) => 6 - w.move.to.x);
    const full = 0.61343 * 1.75;
    expect(depths[0]).toBeCloseTo(0.25, 1);
    expect(depths.at(-1)).toBeCloseTo(full, 6);
    expect(depths.at(-2)).toBeCloseTo(full, 6); // spring pass
    const steps = depths.slice(1, -1).map((d, i) => d - depths[i]!);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeLessThanOrEqual(steps[i - 1]! + 1e-9);
    for (const w of p) {
      expect(w.move.to.z).toBe(-15);
      expect(w.from.x).toBeCloseTo(w.move.to.x, 9); // along Z only
    }
  });

  it('flank infeed moves each start along the 29.5° flank', () => {
    const p = passes(threadJob());
    const [a, b] = [p[0]!, p[3]!];
    const dz = b.from.z - a.from.z;
    const dx = a.move.to.x - b.move.to.x;
    expect(dz / dx).toBeCloseTo(-Math.tan((29.5 * Math.PI) / 180), 6);
  });

  it('starts far enough out for Z to reach speed', () => {
    const job = threadJob({ infeed: 'radial' });
    const a = analyze(job);
    const seg = a.program.segments.find((s) => s.opId === 'op2')!;
    const v = (1.75 * seg.rpm) / 60;
    const start = passes(job)[0]!.from.z;
    expect(start).toBeGreaterThanOrEqual((v * v) / (2 * job.machine.accel));
    expect(start).toBeGreaterThanOrEqual(3 * 1.75);
  });

  it('keeps pitch × rpm within the machine feed', () => {
    const job = threadJob({ rpm: 2000 });
    const seg = analyze(job).program.segments.find((s) => s.opId === 'op2')!;
    expect(seg.rpm * 1.75).toBeLessThanOrEqual(job.machine.maxFeed * 0.8);
    expect(codes(job)).toContain('SPEED_LIMIT');
  });

  it('writes G33 Z K and reads it back', () => {
    const job = threadJob();
    const a = analyze(job);
    const { text } = emit(job, a.program);
    const g33 = text.split('\n').filter((l) => l.startsWith('G33'));
    expect(g33.length).toBe(passes(job).length);
    expect(g33[0]).toBe('G33 Z-15 K1.75');
    const parsed = parseGcode(text, 'lathe').moves.filter((m) => m.move.type === 'thread');
    expect(parsed).toHaveLength(g33.length);
    expect((parsed[0]!.move as { pitch: number }).pitch).toBe(1.75);
  });
});

describe('lathe arcs (G18)', () => {
  const profile: OperationInput = {
    id: 'op1',
    type: 'lathe_profile',
    tool: 1,
    points: [{ d: 0, z: 0 }, { d: 14, z: 0, r: 2 }, { d: 14, z: -10, r: 1.5 }, { d: 20, z: -10, c: 0.5 }, { d: 20, z: -25 }],
  };
  const job = (tol: number) => withOps('lathe', [profile], { machine: { ...EXAMPLES.lathe().machine, arcTolerance: tol } });
  /** Points every 0.05 mm along a program's feeds and arcs. */
  const dense = (p: Program) => {
    const pts: { x: number; z: number }[] = [];
    for (const { from, move } of walk(p)) if (move.type !== 'rapid') for (const q of samplePath(from, move, 0.05)) pts.push({ x: q.x, z: q.z });
    return pts;
  };
  /** How far the points of `a` get from the path through the points of `b` (point to segment). */
  const farthest = (a: { x: number; z: number }[], b: { x: number; z: number }[]) => {
    const seg = (p: { x: number; z: number }, s: { x: number; z: number }, e: { x: number; z: number }) => {
      const dx = e.x - s.x;
      const dz = e.z - s.z;
      const t = Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.z - s.z) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(p.x - s.x - t * dx, p.z - s.z - t * dz);
    };
    return Math.max(...a.map((p) => Math.min(...b.slice(1).map((q, i) => seg(p, b[i]!, q)))));
  };

  it('writes the radii as G2/G3 arcs that follow the same path', () => {
    const lines = analyze(job(0)).program;
    const arcs = analyze(job(0.005)).program;
    const n = arcs.segments[0]!.moves.filter((m) => m.type === 'arc').length;
    expect(n).toBeGreaterThan(0);
    expect(arcs.segments[0]!.moves.every((m) => m.type !== 'arc' || m.plane === 'zx')).toBe(true);
    expect(farthest(dense(arcs), dense(lines))).toBeLessThan(0.01);
    expect(farthest(dense(lines), dense(arcs))).toBeLessThan(0.01);
  });

  it('G-code read back gives the same path: X as diameter, I as radius, K', () => {
    const j = job(0.005);
    const a = analyze(j);
    const text = emit(j, a.program).text;
    expect(text).toMatch(/^G18 G7 G97$/m);
    expect(text).toMatch(/^G[23] X[\d.]+ Z-?[\d.]+ I-?[\d.]+ K-?[\d.]+/m);
    const parsed = parseGcode(text, 'lathe');
    expect(parsed.warnings).toEqual([]);
    const back: Program = { kind: 'lathe', home: parsed.start, segments: [{ opId: 'x', label: '', tool: 1, rpm: 1, moves: parsed.moves.map((m) => m.move) }] };
    const orig = dense(a.program);
    const read = dense(back);
    expect(farthest(read, orig)).toBeLessThan(0.002);
    expect(farthest(orig, read)).toBeLessThan(0.002);
  });

  it('convex corners are G3 and the concave fillet G2, as on any lathe turning towards the chuck', () => {
    const a = analyze(job(0.005));
    let convex = 0;
    let concave = 0;
    for (const { from, move } of walk(a.program)) {
      if (move.type !== 'arc') continue;
      // the chord's middle is on the arc's side of the centre (whichever way the arc runs): above it on
      // a convex corner (centre inside the part), below it on a fillet (centre outside)
      const outside = (from.x + move.to.x) / 2 < move.center.x;
      if (outside) concave++;
      else convex++;
      expect(move.cw).toBe(outside);
    }
    expect(convex).toBeGreaterThan(0);
    expect(concave).toBeGreaterThan(0);
  });
});
