import { describe, expect, it } from 'vitest';
import {
  EXAMPLES,
  Job,
  LatheMaterial,
  MillMaterial,
  analyze,
  emit,
  levels,
  parseGcode,
  walk,
  buildProfile,
  tipPath,
  zAtRadius,
  plannedSeconds,
  estimateSeconds,
  type Program,
  type JobInput,
  type OperationInput,
} from '../src/index.ts';

const codes = (job: Job) => analyze(job).diagnostics.map((d) => d.code);
const withOps = (kind: 'lathe' | 'mill', ops: OperationInput[], patch: Partial<JobInput> = {}): Job =>
  Job.parse({ ...EXAMPLES[kind](), operations: ops, ...patch });

describe('levels', () => {
  it('splits a span into equal steps no larger than the step', () => {
    expect(levels(0, -5, 2)).toEqual([-5 / 3, -10 / 3, -5]);
    expect(levels(1, 0, 1)).toEqual([0]);
    expect(levels(3, 3, 1)).toEqual([3]);
  });
});

describe('example jobs', () => {
  it('generate without errors', () => {
    for (const kind of ['lathe', 'mill'] as const) {
      const a = analyze(EXAMPLES[kind]());
      expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(a.moves).toBeGreaterThan(10);
      expect(a.seconds).toBeGreaterThan(0);
    }
  });

  it('lathe: the material model ends up as the turned pin', () => {
    const m = analyze(EXAMPLES.lathe()).material as LatheMaterial;
    const radiusAt = (z: number) => m.r[Math.floor((z - m.z0) / m.dz)]!;
    expect(radiusAt(-15)).toBeCloseTo(10, 2); // Ø20 section
    expect(radiusAt(-34)).toBeCloseTo(12.5, 2); // untouched bar behind the shoulder
    expect(radiusAt(0.5)).toBe(0); // faced off
    // halfway down the 1 mm chamfer; the tip path is lengthened for the 0.4 nose radius
    expect(radiusAt(-0.5)).toBeCloseTo(9.5 - 0.4 * (2 - Math.SQRT2), 1);
    expect(radiusAt(-39)).toBe(0); // parted off
  });

  it('mill: the height map shows the faced top and the pocket', () => {
    const m = analyze(EXAMPLES.mill()).material as MillMaterial;
    const at = (x: number, y: number) => m.h[Math.floor(y / m.cell) * m.nx + Math.floor(x / m.cell)]!;
    expect(at(40, 25)).toBeCloseTo(-5, 3);
    expect(at(10, 25)).toBeCloseTo(0, 3);
    expect(at(8, 8)).toBeCloseTo(m.bottom, 3); // drilled through
  });
});

describe('G-code', () => {
  it('lathe: writes diameters in G7 mode and reads back the same path', () => {
    const job = EXAMPLES.lathe();
    const { program } = analyze(job);
    const { text } = emit(job, program);
    expect(text).toMatch(/^G18 G7$/m);
    expect(text).toMatch(/^X20$/m); // the finishing pass at Ø20
    expect(text).not.toMatch(/G4[1-2]|G8[1-9]|G96|G76/); // no cutter comp, canned cycles or CSS
    const parsed = parseGcode(text, 'lathe');
    expect(parsed.warnings).toEqual([]);
    // every parsed move lands on a program point (or the tool-change position)
    const points = [program.home, ...[...walk(program)].map((w) => w.move.to)];
    for (const p of parsed.moves) {
      expect(points.some((q) => Math.abs(q.x - p.move.to.x) < 1e-3 && Math.abs(q.z - p.move.to.z) < 1e-3)).toBe(true);
    }
    expect(parsed.moves.length).toBeGreaterThan(points.length * 0.8);
  });

  it('mill: arcs come out as G3 with I/J and parse back as arcs', () => {
    const job = withOps('mill', [{ type: 'mill_pocket_circle', tool: 1, cx: 40, cy: 25, diameter: 20, zBottom: -2, zTop: 0.5 }]);
    const { program, diagnostics } = analyze(job);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const { text } = emit(job, program);
    expect(text).toMatch(/^G3 X\S+ Y\S+ Z\S+ I\S+ J0/m);
    const parsed = parseGcode(text, 'mill');
    const arcs = parsed.moves.filter((m) => m.move.type === 'arc');
    expect(arcs.length).toBeGreaterThan(0);
    const a = arcs[0]!.move as Extract<typeof arcs[0]['move'], { type: 'arc' }>;
    expect(a.center.x).toBeCloseTo(40, 3);
    expect(a.center.y).toBeCloseTo(25, 3);
    expect(a.cw).toBe(false);
  });

  it('reports what it does not understand', () => {
    const p = parseGcode('G21 G90\nG0 X0 Y0 Z5\nG81 X1 Y1 Z-2 R1\nG1 X10 F100\n', 'mill');
    expect(p.warnings.map((w) => w.message)).toContain('G81 is not supported');
    expect(p.moves).toHaveLength(2);
  });

  it('converts inches', () => {
    const p = parseGcode('G20 G90\nG0 X0 Y0 Z1\nG1 X1 F10\n', 'mill');
    expect(p.moves[0]!.move.to.x).toBeCloseTo(25.4);
    expect((p.moves[0]!.move as { f: number }).f).toBeCloseTo(254);
  });
});

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

describe('threading', () => {
  const threadJob = (op: Partial<OperationInput> = {}, sync = true) => {
    const base = EXAMPLES.lathe();
    return withOps('lathe', [{ type: 'lathe_turn', tool: 1, diameter: 12, zEnd: -20 }, { type: 'lathe_thread', tool: 4, diameter: 12, pitch: 1.75, zEnd: -15, ...op } as OperationInput], {
      machine: { ...base.machine, spindleSync: sync },
    });
  };
  const passes = (job: Job) => [...walk(analyze(job).program)].filter((w) => w.move.type === 'thread');

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
    expect(codes(job)).toEqual(['SPEED_LIMIT']);
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

describe('time estimate', () => {
  const line = (pts: [number, number][], f: number): Program => ({
    kind: 'mill',
    home: { x: 0, y: 0, z: 0 },
    segments: [{ opId: 'a', label: 'a', tool: 1, rpm: 1000, moves: pts.map(([x, y]) => ({ type: 'feed' as const, to: { x, y, z: 0 }, f })) }],
  });
  const s = { accel: 100, junctionDeviation: 0.01, rapidRate: 3000 };

  it('adds acceleration to a straight move', () => {
    // 100 mm at 600 mm/min = 10 mm/s: 10 s cruising plus v/a = 0.1 s for speeding up and slowing down
    expect(plannedSeconds(line([[100, 0]], 600), s)).toBeCloseTo(10.1, 3);
    // a short move never reaches the feed: 1 mm at a = 100 mm/s² takes 2·√(1/100) = 0.2 s
    expect(plannedSeconds(line([[1, 0]], 6000), s)).toBeCloseTo(0.2, 3);
  });

  it('slows down for corners but not for straight joins', () => {
    const straight = plannedSeconds(line([[10, 0], [20, 0], [30, 0], [40, 0]], 3000), s);
    const zigzag = plannedSeconds(line([[10, 0], [10, 10], [20, 10], [20, 20]], 3000), s);
    expect(zigzag).toBeGreaterThan(straight * 1.5);
    expect(straight).toBeCloseTo(plannedSeconds(line([[40, 0]], 3000), s), 6);
  });

  it('is longer than the plain length/feed estimate for real jobs', () => {
    for (const kind of ['lathe', 'mill'] as const) {
      const job = EXAMPLES[kind]();
      const a = analyze(job);
      expect(a.seconds).toBeGreaterThan(estimateSeconds(a.program, job.machine.rapidRate));
    }
  });
});

describe('checks', () => {
  it('rapid into material: drilling from a wrong top', () => {
    const job = withOps('mill', [{ type: 'mill_drill', tool: 3, points: [{ x: 10, y: 10 }], zBottom: -12, zTop: -8 }]);
    expect(codes(job)).toContain('RAPID_IN_MATERIAL');
  });

  it('turning into the chuck', () => {
    const job = withOps('lathe', [{ type: 'lathe_turn', tool: 1, diameter: 20, zEnd: -70 }]);
    expect(codes(job)).toContain('CHUCK');
  });

  it('leaving the travel', () => {
    const job = withOps('mill', [{ type: 'mill_pocket_rect', tool: 1, x: 280, y: 10, w: 40, h: 20, zBottom: -2 }], {
      stock: { kind: 'block', x: 400, y: 50, z: 15 },
    });
    expect(codes(job)).toContain('OUT_OF_RANGE');
  });

  it('cutting deeper than the flutes', () => {
    const tools = EXAMPLES.mill().tools.map((t) => (t.id === 1 ? { ...t, fluteLength: 8 } : t));
    const job = withOps('mill', [{ type: 'mill_contour_rect', tool: 1, x: 10, y: 10, w: 30, h: 20, zBottom: -9.5, stepDown: 10 }], { tools });
    expect(codes(job)).toContain('TOO_DEEP');
  });

  it('a normal stepdown is fine, a big one is a warning', () => {
    const ok = withOps('mill', [{ type: 'mill_contour_rect', tool: 1, x: 10, y: 10, w: 30, h: 20, zBottom: -9, zTop: 0.5 }]);
    expect(codes(ok)).toEqual(['SPEED_LIMIT']);
    const deep = withOps('mill', [{ type: 'mill_contour_rect', tool: 1, x: 10, y: 10, w: 30, h: 20, zBottom: -9, zTop: 0.5, stepDown: 9.5 }]);
    expect(codes(deep)).toContain('DOC_HIGH');
  });

  it('plunging with a tool that cannot', () => {
    const base = EXAMPLES.mill();
    const tools = base.tools.map((t) => (t.id === 1 ? { ...t, centerCutting: false } : t));
    const plunge = withOps('mill', [{ type: 'mill_pocket_rect', tool: 1, x: 20, y: 15, w: 20, h: 20, zBottom: -2, entry: 'plunge' }], { tools });
    expect(codes(plunge)).toContain('PLUNGE');
    // the default ramp entry is fine without centre cutting
    const ramp = withOps('mill', [{ type: 'mill_pocket_rect', tool: 1, x: 20, y: 15, w: 20, h: 20, zBottom: -2 }], { tools });
    expect(codes(ramp)).not.toContain('PLUNGE');
  });

  it('impossible operations become errors and the rest still generates', () => {
    const job = withOps('lathe', [
      { type: 'lathe_groove', tool: 2, diameter: 20, z: -10, width: 1 },
      { type: 'lathe_turn', tool: 9, diameter: 20, zEnd: -10 },
      { type: 'lathe_turn', tool: 2, diameter: 20, zEnd: -10 },
      { type: 'mill_face', tool: 1, z: 0 },
      { type: 'lathe_face', tool: 1, z: 0 },
    ]);
    const a = analyze(job);
    expect(a.diagnostics.map((d) => d.code)).toEqual(['OP_INVALID', 'TOOL_MISSING', 'TOOL_TYPE', 'OP_MACHINE']);
    expect(a.program.segments).toHaveLength(1);
  });

  it('ops get stable ids', () => {
    const job = withOps('lathe', [{ type: 'lathe_face', tool: 1 }, { id: 'op1', type: 'lathe_face', tool: 1, z: -0.5, fromZ: 0 }]);
    expect(analyze(job).program.segments.map((s) => s.opId)).toEqual(['op2', 'op1']);
  });
});
