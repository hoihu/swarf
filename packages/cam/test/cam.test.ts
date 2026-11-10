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
  fitArcs,
  diffJobs,
  isEmptyDiff,
  buildProfile,
  tipPath,
  zAtRadius,
  plannedSeconds,
  cuttingData,
  samplePath,
  MATERIALS,
  estimateSeconds,
  type Program,
  type JobInput,
  type OperationInput,
} from '../src/index.ts';

const codes = (job: Job) => analyze(job).diagnostics.map((d) => d.code);
const withOps = (kind: 'lathe' | 'mill', ops: OperationInput[], patch: Partial<JobInput> = {}): Job =>
  Job.parse({ ...EXAMPLES[kind](), operations: ops, ...patch });

describe('job diff', () => {
  it('lists added, removed, changed and reordered operations and other changes', () => {
    const a = EXAMPLES.lathe();
    const ops = a.operations.filter((o) => o.id !== 'op3').map((o) => (o.id === 'op2' ? { ...o, diameter: 18 } : o));
    const b = Job.parse({ ...a, material: 'brass', operations: [ops[1]!, ops[0]!, ...ops.slice(2), { id: 'op9', type: 'lathe_face', tool: 1, z: -0.5, fromZ: 0 }] });
    const d = diffJobs(a, b);
    expect(d.added.map((x) => x.id)).toEqual(['op9']);
    expect(d.removed.map((x) => x.id)).toEqual(['op3']);
    expect(d.changed).toEqual([{ id: 'op2', label: 'Turn Ø18 to Z-30', fields: ['diameter 20 → 18'] }]);
    expect(d.reordered).toBe(true);
    expect(d.other).toEqual(['material']);
    expect(isEmptyDiff(diffJobs(a, a))).toBe(true);
  });
});

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
    expect(text).toMatch(/^G18 G7 G97$/m);
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

describe('arc fitting', () => {
  const at = { x: 10, y: 0, z: 0 };
  const along = (n: number, sweep: number, dz = 0) =>
    Array.from({ length: n }, (_, i) => {
      const a = (sweep * (i + 1)) / n;
      return { type: 'feed' as const, to: { x: 10 * Math.cos(a), y: 10 * Math.sin(a), z: (dz * (i + 1)) / n }, f: 500 };
    });

  it('turns a run of chords on a circle into one arc', () => {
    const out = fitArcs(along(90, Math.PI), at);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'arc', cw: false, f: 500 });
    const a = out[0] as Extract<(typeof out)[0], { type: 'arc' }>;
    expect(a.center.x).toBeCloseTo(0, 6);
    expect(a.to.x).toBeCloseTo(-10, 6);
  });

  it('fits helices, keeps corners and straight runs as lines', () => {
    expect(fitArcs(along(60, Math.PI / 2, -1), at)).toHaveLength(1);
    const square = [
      { type: 'feed' as const, to: { x: 10, y: 10, z: 0 }, f: 500 },
      { type: 'feed' as const, to: { x: 0, y: 10, z: 0 }, f: 500 },
      { type: 'feed' as const, to: { x: 0, y: 0, z: 0 }, f: 500 },
    ];
    expect(fitArcs(square, at).map((m) => m.type)).toEqual(['feed', 'feed', 'feed']);
  });

  it('shortens a real program a lot without changing what it cuts', () => {
    const circle = (r: number, n = 200): [number, number][] => Array.from({ length: n }, (_, i) => [40 + r * Math.cos((2 * Math.PI * i) / n), 25 + r * Math.sin((2 * Math.PI * i) / n)]);
    const shapes = [{ id: 's1', name: 'ring', at: { x: 0, y: 0 }, paths: [{ closed: true, pts: circle(18) }, { closed: true, pts: circle(6) }] }];
    const run = (tol: number) => {
      const base = EXAMPLES.mill();
      const j = Job.parse({ ...base, machine: { ...base.machine, arcTolerance: tol }, shapes, operations: [{ type: 'mill_pocket', tool: 1, shape: 's1', zBottom: -2, zTop: 0.5 }] });
      return { a: analyze(j), lines: emit(j, analyze(j).program).text.split('\n').length };
    };
    const lines = run(0);
    const arcs = run(0.005);
    expect(arcs.lines).toBeLessThan(lines.lines / 5);
    expect(arcs.a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const [m0, m1] = [lines.a.material as MillMaterial, arcs.a.material as MillMaterial];
    // the same cells cut, but for knife-edge cells on the wall (arcs are true circles, chords sit inside them)
    let differ = 0;
    for (let k = 0; k < m0.h.length; k++) if (Math.abs(m0.h[k]! - m1.h[k]!) > 0.05) differ++;
    expect(differ / m0.h.length).toBeLessThan(0.001);
  });
});

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
    const job = withOps('mill', [{ type: 'mill_contour_rect', tool: 1, x: 10, y: 10, w: 30, h: 20, zBottom: -9.5, stepDown: 10, entry: 'plunge' }], { tools });
    expect(codes(job)).toContain('TOO_DEEP');
  });

  it('a normal stepdown is fine, a big one is a warning', () => {
    const ok = withOps('mill', [{ type: 'mill_contour_rect', tool: 1, x: 10, y: 10, w: 30, h: 20, zBottom: -9, zTop: 0.5 }]);
    expect(codes(ok)).toEqual([]);
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

describe('materials', () => {
  const seg = (job: Job, opId: string) => analyze(job).program.segments.find((s) => s.opId === opId)!;
  const feedOf = (job: Job, opId: string) => (seg(job, opId).moves.find((m) => m.type === 'feed') as { f: number }).f;
  const passes = (job: Job, opId: string) => seg(job, opId).moves.filter((m) => m.type === 'feed').length;

  it('steel is slower, fed lighter and cut shallower than aluminium', () => {
    const ops: OperationInput[] = [{ id: 'op1', type: 'lathe_turn', tool: 1, diameter: 16, zEnd: -20 }];
    const alu = withOps('lathe', ops, { workMaterial: 'aluminium' });
    const steel = withOps('lathe', ops, { workMaterial: 'steel' });
    expect(seg(steel, 'op1').rpm).toBeLessThan(seg(alu, 'op1').rpm);
    expect(feedOf(steel, 'op1')).toBeLessThan(feedOf(alu, 'op1'));
    expect(passes(steel, 'op1')).toBeGreaterThan(passes(alu, 'op1'));
    expect(codes(steel)).toEqual([]);
  });

  it("a tool's own cutting data overrides the material", () => {
    const base = EXAMPLES.lathe();
    const tools = base.tools.map((t) => (t.id === 1 ? { ...t, vc: 40, feedPerRev: 0.05 } : t));
    const job = withOps('lathe', [{ id: 'op1', type: 'lathe_turn', tool: 1, diameter: 20, zEnd: -20 }], { tools, workMaterial: 'aluminium' });
    expect(seg(job, 'op1').rpm).toBe(Math.round((40 * 1000) / (Math.PI * 25)));
    expect(feedOf(job, 'op1')).toBe(Math.round(seg(job, 'op1').rpm * 0.05));
  });

  it('HSS runs slower than carbide; drills default to HSS', () => {
    const mill = EXAMPLES.mill();
    const t1 = mill.tools.find((t) => t.id === 1)!;
    const carbide = cuttingData(t1, 'steel');
    const hss = cuttingData({ ...t1, toolMaterial: 'hss' }, 'steel');
    expect(hss.vc).toBeLessThan(carbide.vc);
    expect(hss.feed).toBeLessThan(carbide.feed);
    const drill = mill.tools.find((t) => t.type === 'drill')!;
    expect(cuttingData(drill, 'steel').vc).toBe(MATERIALS.steel.vc.drilling.hss);
  });

  it("the tool's max depth caps the material's", () => {
    const t = { ...EXAMPLES.mill().tools[0]!, maxDoc: 0.5 };
    expect(cuttingData(t, 'aluminium').doc).toBe(0.5);
    expect(cuttingData({ ...t, maxDoc: undefined }, 'aluminium').doc).toBe(3);
  });

  it('a stepdown fine in aluminium is too deep in stainless', () => {
    const ops: OperationInput[] = [{ type: 'mill_contour_rect', tool: 1, x: 10, y: 10, w: 30, h: 20, zBottom: -6, zTop: 0.5, stepDown: 3 }];
    expect(codes(withOps('mill', ops, { workMaterial: 'aluminium' }))).toEqual([]);
    expect(codes(withOps('mill', ops, { workMaterial: 'stainless' }))).toContain('DOC_HIGH');
  });

  it('old jobs without a material read as aluminium', () => {
    const j = Job.parse({ ...EXAMPLES.lathe(), workMaterial: undefined });
    expect(j.workMaterial).toBe('aluminium');
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

describe('obstacles', () => {
  const clamp = { name: 'clamp left', x0: -22, y0: 16, x1: -4, y1: 34, top: 8.5 };
  it('a clamp beside the block that the facing passes run over is an error, rapids too', () => {
    const job = Job.parse({ ...EXAMPLES.mill(), obstacles: [clamp] });
    const d = analyze(job).diagnostics.filter((x) => x.code === 'OBSTACLE');
    expect(d.length).toBeGreaterThan(0);
    expect(d[0]!.message).toContain('clamp left');
  });
  it('one out of the way is not', () => {
    const job = Job.parse({ ...EXAMPLES.mill(), obstacles: [{ ...clamp, x0: -60, x1: -45 }] });
    expect(codes(job)).not.toContain('OBSTACLE');
  });
  it('a low one the tool passes over at the clearance height is fine', () => {
    const job = Job.parse({ ...EXAMPLES.mill(), operations: [{ type: 'mill_pocket_rect', tool: 1, x: 20, y: 15, w: 40, h: 20, zBottom: -5, zTop: 0 }], obstacles: [{ ...clamp, x0: 30, x1: 50, y0: 60, y1: 70, top: 0.5 }] });
    expect(codes(job)).not.toContain('OBSTACLE');
  });
});

describe('getting to and from the work safely', () => {
  it('mill: nothing moves before the first tool is in; after every tool change the modes are said again and the tool rises straight up first', () => {
    const job = EXAMPLES.mill();
    const a = analyze(job);
    const lines = emit(job, a.program).text.split('\n').filter((l) => l && !l.startsWith('('));
    const first = lines.indexOf('M0');
    expect(lines.slice(0, first).some((l) => /[XYZ]/.test(l))).toBe(false);
    const home = a.program.home;
    const pauses = lines.map((l, i) => (l === 'M0' ? i : -1)).filter((i) => i >= 0);
    expect(pauses.length).toBe(new Set(a.program.segments.map((s) => s.tool)).size);
    for (const i of pauses) {
      expect(lines.slice(i + 1, i + 5)).toEqual(['G21 G90 G94 G54', 'G17', `G0 Z${home.z}`, `G0 X${home.x} Y${home.y}`]);
      // the spindle starts only after that, and is off before the pause (but for the first)
      expect(lines[i + 5]).toMatch(/^S\d+ M3$/);
      if (i !== first) expect(lines[i - 1]).toBe('M5');
    }
    expect(lines.slice(-2)).toEqual(['M5', 'M30']);
  });

  it('lathe: after a tool change the tool goes along Z away from the chuck first, then out; S is rpm (G97)', () => {
    const job = EXAMPLES.lathe();
    const a = analyze(job);
    const lines = emit(job, a.program).text.split('\n').filter((l) => l && !l.startsWith('('));
    const home = a.program.home;
    const i = lines.lastIndexOf('M0');
    expect(lines.slice(i + 1, i + 5)).toEqual(['G21 G90 G94 G54', 'G18 G7 G97', `G0 Z${home.z}`, `G0 X${home.x * 2}`]);
  });

  it('the way home is part of the program: Z first, then across, and checked like every other move', () => {
    const job = EXAMPLES.mill();
    const a = analyze(job);
    const home = a.program.home;
    for (const [i, seg] of a.program.segments.entries()) {
      const next = a.program.segments[i + 1];
      if (next && next.tool === seg.tool) continue;
      const [up, across] = seg.moves.slice(-2);
      expect(across!.to).toEqual(home);
      expect(up!.type).toBe('rapid');
      expect(up!.to.z).toBe(home.z);
      // straight up: X and Y as they were
      const before = seg.moves.at(-3)!.to;
      expect([up!.to.x, up!.to.y]).toEqual([before.x, before.y]);
    }
    // something tall on the table: the travel height goes above it by the clearance
    const bolt = { name: 'bolt', x0: 30, y0: -30, x1: 40, y1: -20, top: 36 };
    const b = analyze(Job.parse({ ...job, obstacles: [bolt] }));
    expect(b.program.home.z).toBe(36 + job.machine.clearance);
    expect(b.diagnostics.filter((d) => d.code === 'OBSTACLE')).toEqual([]);
    // something standing where the tool changes are (X0 Y0), higher than the machine can lift over: an error, on the way home
    const post = { name: 'post', x0: -5, y0: -5, x1: 5, y1: 5, top: 500 };
    const c = analyze(Job.parse({ ...job, obstacles: [post] }));
    expect(c.diagnostics.some((d) => d.code === 'OBSTACLE' || d.code === 'OUT_OF_RANGE')).toBe(true);
  });
});
