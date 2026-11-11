import { describe, expect, it } from 'vitest';
import {
  EXAMPLES, emptyJob,
  alignProgram, surfaceAt, isAligned, reviewJob,
  jobFile, openJobFile, libraryFile, openLibraryFile, keepTool, dropTool, takeTool, inLibrary, setupSheet, cutLines, toolSummary,
  Job,
  LatheMaterial,
  MillMaterial,
  analyze,
  resumeFrom,
  textStrokes,
  hasErrors,
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

describe('starting again in the middle', () => {
  // two operations with the same cutter, then another tool: starting at the second has no tool change before it in the full program
  const job = withOps('mill', [
    { type: 'mill_pocket_rect', tool: 1, x: 10, y: 10, w: 20, h: 15, zBottom: -3 },
    { type: 'mill_pocket_circle', tool: 1, cx: 55, cy: 30, diameter: 20, zBottom: -4 },
    { type: 'mill_drill', tool: 3, points: [{ x: 8, y: 40 }], zBottom: -6, peck: 2 },
  ]);
  const full = analyze(job);

  it('the program from an operation on: begins like a tool change, has nothing of what came before, ends the same', () => {
    const whole = emit(job, full.program);
    for (let seg = 1; seg < full.program.segments.length; seg++) {
      const r = resumeFrom(job, full.program, seg);
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const part = emit(job, r.program, { fromSegment: seg });
      const lines = part.text.split('\n').filter((l) => l && !l.startsWith('('));
      const s = full.program.segments[seg]!;
      const home = full.program.home;
      // modes, the pause for the tool, modes again, straight up, across, spindle
      expect(lines.slice(0, 8)).toEqual(['G21 G90 G94 G54', 'G17', 'M0', 'G21 G90 G94 G54', 'G17', `G0 Z${home.z}`, `G0 X${home.x} Y${home.y}`, `S${s.rpm} M3`]);
      expect(part.text).toContain(`starting again at ${s.opId}`);
      expect(part.text).toContain(`Load T${s.tool}`);
      for (const earlier of full.program.segments.slice(0, seg)) expect(part.text).not.toContain(`(${earlier.opId}:`);
      // every move of the rest is there, in the same words as in the whole program (after its first positioning)
      expect(part.lineOfMove.slice(0, r.firstMove).every((l) => l === -1)).toBe(true);
      expect(part.lineOfMove.slice(r.firstMove).every((l) => l >= 0)).toBe(true);
      const tail = (text: string) => text.slice(text.indexOf(`(${s.opId}:`)).split('\n').filter((l) => /^(G1|G2|G3)\b|^[XYZ]/.test(l));
      const [tp, tw] = [tail(part.text), tail(whole.text)];
      const n = Math.min(tp.length, tw.length) - 4;
      expect(n).toBeGreaterThan(5);
      expect(tp.slice(-n)).toEqual(tw.slice(-n));
      expect(lines.slice(-2)).toEqual(['M5', 'M30']);
      // read back: it starts from home and visits the same places
      const parsed = parseGcode(part.text, 'mill');
      expect(parsed.warnings).toEqual([]);
      const rest = full.program.segments.slice(seg).flatMap((x) => x.moves).map((m) => m.to);
      const last = parsed.moves.at(-1)!.move.to;
      expect([last.x, last.y, last.z]).toEqual([rest.at(-1)!.x, rest.at(-1)!.y, rest.at(-1)!.z]);
    }
  });

  it('the way back in comes from home, and is checked: something tall in it is an error for the restart only', () => {
    // a post between home (X0 Y0) and the second pocket, taller than the rapids fly but not known when the travel height was set
    const r = resumeFrom(job, full.program, 1);
    // in the whole program the cutter goes from the first pocket to the second at the safe height; restarting, it comes from home
    const first = r.program.segments[1]!.moves[0]!;
    const before = r.program.segments[0]!.moves.at(-1)!;
    expect(before.to).toEqual(full.program.home);
    expect(first.type).toBe('rapid');
    expect(r.added).toBeGreaterThan(0);
    // errors of operations already done do not hold a restart up; those of what will run do
    const bad = Job.parse({ ...job, operations: [{ type: 'mill_pocket_rect', tool: 1, x: 10, y: 10, w: 20, h: 15, zBottom: -3, zTop: -1 }, ...job.operations.slice(1)] });
    const a = analyze(bad);
    expect(hasErrors(a.diagnostics)).toBe(true);
    expect(hasErrors(resumeFrom(bad, a.program, 1).diagnostics)).toBe(false);
    // (a pocket said to start 1 mm down in solid stock: its approach is a rapid into material)
    const bad2 = Job.parse({ ...job, operations: [...job.operations.slice(0, 2), { type: 'mill_pocket_rect', tool: 1, x: 40, y: 5, w: 20, h: 12, zBottom: -3, zTop: -1 }] });
    const a2 = analyze(bad2);
    expect(hasErrors(resumeFrom(bad2, a2.program, 1).diagnostics)).toBe(true);
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
    // 0.6134 P deep at the last pass
    const radii = helix.map((m) => Math.hypot(m.to.x - 30, m.to.y - 25));
    expect(Math.min(...radii)).toBeCloseTo(6 + 2.5 - 0.6134 * 1.75, 4);
  });
});

describe('job files and the tool library', () => {
  it('a job comes back from its file as it went in', () => {
    const job = { ...EXAMPLES.mill(), notes: 'In the vise, on 10 mm parallels' };
    expect(openJobFile(jobFile(job))).toEqual(job);
    // a bare job as JSON is taken too
    expect(openJobFile(JSON.stringify(EXAMPLES.lathe()))).toEqual(EXAMPLES.lathe());
  });

  it('refuses what is not a job, with a sentence', () => {
    expect(() => openJobFile('G21 G90')).toThrow(/not JSON/);
    expect(() => openJobFile('{"swarf":"job","version":1,"job":{"name":"x"}}')).toThrow(/does not fit \(machine/);
    expect(() => openJobFile(libraryFile([]))).toThrow(/tool library, not a job/);
    expect(() => openJobFile('{"swarf":"job","version":99,"job":{}}')).toThrow(/newer/);
    const bad = JSON.parse(jobFile(EXAMPLES.mill()));
    bad.job.tools[0].diameter = -6;
    expect(() => openJobFile(JSON.stringify(bad))).toThrow(/tools\.0\.diameter/);
  });

  it('keeps tools per machine by name, and replaces one kept again', () => {
    const [t1, t2] = EXAMPLES.mill().tools;
    let lib = keepTool([], 'mill', t1!);
    lib = keepTool(lib, 'mill', t2!);
    lib = keepTool(lib, 'lathe', EXAMPLES.lathe().tools[0]!);
    expect(lib).toHaveLength(3);
    lib = keepTool(lib, 'mill', { ...t1!, name: ` ${t1!.name.toUpperCase()} `, flutes: 3 });
    expect(lib).toHaveLength(3);
    expect(inLibrary(lib, 'mill', t1!.name)?.tool.flutes).toBe(3);
    expect(inLibrary(lib, 'lathe', t1!.name)).toBeUndefined();
    expect(openLibraryFile(libraryFile(lib))).toEqual(lib);
    expect(dropTool(lib, 'mill', t2!.name)).toHaveLength(2);
    expect(() => openLibraryFile(jobFile(EXAMPLES.mill()))).toThrow(/a job, not a tool library/);
  });

  it('puts a library tool into a job under a free number, and updates one already there', () => {
    const job = EXAMPLES.mill();
    const used = job.tools[0]!;
    const fresh = { id: used.id, name: 'Endmill Ø10 rougher', type: 'endmill' as const, diameter: 10, flutes: 3, fluteLength: 22 };
    const a = takeTool(job, fresh);
    expect(a.id).toBe(Math.max(...job.tools.map((t) => t.id)) + 1);
    expect(a.job.tools.find((t) => t.id === a.id)?.diameter).toBe(10);
    expect(job.tools).toHaveLength(a.job.tools.length - 1); // the job given is left alone
    const free = takeTool(job, { ...fresh, id: 42 });
    expect(free.id).toBe(42);
    // the same name again: the job's tool takes the library's values and keeps its number
    const b = takeTool(a.job, { ...fresh, id: 7, fluteLength: 30 });
    expect(b.id).toBe(a.id);
    expect(b.job.tools).toHaveLength(a.job.tools.length);
    expect(b.job.tools.find((t) => t.id === a.id)?.fluteLength).toBe(30);
    expect(hasErrors(analyze(b.job).diagnostics)).toBe(false);
  });
});

describe('setup sheet', () => {
  it('lists the mill job: stock, zero, tools in the order of use, times', () => {
    const job = Job.parse({ ...EXAMPLES.mill(), notes: 'Vise, 10 mm parallels', obstacles: [{ name: 'fixed jaw', x0: -5, y0: 50, x1: 85, y1: 70, top: 8 }] });
    const a = analyze(job);
    const s = setupSheet(job, a);
    expect(s.stock[0]).toBe('Block 80 × 50 × 15 mm (X × Y × Z)');
    expect(s.zero.join(' ')).toMatch(/front-left corner.*raw top is at Z\+0\.5.*underside is at Z-14\.5/);
    expect(s.holding[0]).toBe('fixed jaw: X-5 to 85, Y50 to 70, top at Z+8');
    expect(s.notes).toBe('Vise, 10 mm parallels');
    // face mill first (T2), then the pocket's endmill, then the drill
    expect(s.tools.map((t) => t.id)).toEqual([2, 1, 3]);
    expect(s.stops).toBe(3);
    expect(s.ops.map((o) => o.n)).toEqual([1, 2, 3]);
    expect(s.ops[1]!.deepest).toBe('to Z-5');
    // the drill goes through (Z−16): it must stand out past the jaw (top Z+8) by 24 mm and a little
    const drill = s.tools[2]!;
    expect(drill.ops).toEqual([3]);
    expect(drill.reach).toMatch(/goes to Z-16: at least 26 mm out of the holder/);
    // the parts add up to the whole (each starts from rest, so a little more)
    const sum = s.ops.reduce((t, o) => t + o.seconds, 0);
    expect(sum).toBeGreaterThanOrEqual(a.seconds - 1e-6);
    expect(sum).toBeLessThan(a.seconds * 1.05 + 2);
    expect(s.tools.reduce((t, o) => t + o.seconds, 0)).toBeCloseTo(sum, 6);
    expect(s.ops.every((o) => o.rpm > 0 && o.feed > 0)).toBe(true);
    expect(s.travel!.min.z).toBeCloseTo(-16, 6);
    expect(s.travel!.max.z).toBeCloseTo(a.program.home.z, 6);
  });

  it('says a job without clamps is held by nothing the checks know of', () => {
    const s = setupSheet(EXAMPLES.mill(), analyze(EXAMPLES.mill()));
    expect(s.holding[0]).toMatch(/No clamps or jaws entered/);
  });

  it('lists the lathe job: the jaws, how close the tools come, stored offsets on the diameter', () => {
    const base = EXAMPLES.lathe();
    const job = { ...base, tools: base.tools.map((t) => (t.id === 2 ? { ...t, offset: { x: 1.25, z: -3.4 } } : t)) };
    const s = setupSheet(job, analyze(job));
    expect(s.stock[0]).toBe('Bar Ø25 mm, 60 mm out of the chuck');
    expect(s.holding[0]).toBe('Chuck jaws at Z-59');
    // parting at Z−38 with a blade to its left: the tools stay well clear of the jaws
    const gap = Number(/: ([\d.]+) mm from the jaws/.exec(s.holding[1]!)![1]);
    expect(gap).toBeGreaterThan(10);
    expect(gap).toBeLessThan(21.1);
    expect(s.tools.map((t) => t.id)).toEqual([1, 2]);
    expect(s.tools[0]!.ops).toEqual([1, 2, 3]);
    expect(s.tools[1]!.offset).toBe('X2.5 (on the diameter) Z-3.4');
    expect(s.ops.at(-1)!.deepest).toMatch(/^to Z-\d+(\.\d+)?, Ø0$/);
  });

  it('draws the cuts as lines, without the rapids', () => {
    const a = analyze(EXAMPLES.mill());
    const lines = cutLines(a.program);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((l) => l.length >= 2)).toBe(true);
    // nothing is cut at the travel height
    expect(Math.max(...lines.flat().map((q) => q.z))).toBeLessThan(a.program.home.z);
  });

  it('describes tools in a few words', () => {
    expect(toolSummary({ id: 1, name: 'x', type: 'endmill', diameter: 6, flutes: 2, fluteLength: 15 })).toBe('endmill Ø6, 2 flutes, flutes 15 long');
    expect(toolSummary({ id: 4, name: 'x', type: 'chamfer', diameter: 6, angle: 60 })).toBe('pointed cutter 60° Ø6');
    expect(toolSummary({ id: 5, name: 'x', type: 'boring', diameter: 10, fluteLength: 30, internal: true })).toBe('boring Ø10, reach 30');
  });
});

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

describe('worth a look', () => {
  const look = (job: Job) => reviewJob(job, analyze(job)).map((f) => f.code);

  it('has little to say about the examples', () => {
    expect(look(EXAMPLES.lathe())).toEqual([]);
    // the mill example says nothing of what holds the block
    expect(look(EXAMPLES.mill())).toEqual(['HOLDING_UNKNOWN']);
    expect(reviewJob(emptyJob('mill'), analyze(emptyJob('mill')))).toEqual([]);
  });

  it('mill: the order, a deep thin cutter, a thin floor, a part cut free', () => {
    const job = withOps('mill', [
      { type: 'mill_pocket_rect', tool: 1, x: 20, y: 15, w: 40, h: 20, zBottom: -14.2, zTop: 0 },
      { type: 'mill_face', tool: 2, z: 0 },
      { type: 'mill_drill', tool: 3, points: [{ x: 8, y: 8 }], zBottom: -10, zTop: 0, peck: 3 },
      { type: 'mill_spot', tool: 4, points: [{ x: 8, y: 8 }], diameter: 3 },
      { type: 'mill_chamfer', tool: 4, x: 5, y: 5, w: 70, h: 40, size: 0.5, side: 'outside' },
      { type: 'mill_contour_rect', tool: 1, x: 5, y: 5, w: 70, h: 40, zBottom: -15, side: 'outside' },
    ]);
    const f = reviewJob(job, analyze(job));
    const codes = f.map((x) => x.code);
    for (const c of ['ORDER_FACE', 'ORDER_SPOT', 'ORDER_CHAMFER', 'THIN_FLOOR', 'CUT_FREE', 'HOLDING_UNKNOWN']) expect(codes).toContain(c);
    expect(f.find((x) => x.code === 'THIN_FLOOR')!.text).toMatch(/floor 0\.3 mm thick/);
    // the Ø6 end mill goes 15.5 mm under the raw top: not yet four diameters; a Ø3 one would be
    expect(codes).not.toContain('SLENDER_TOOL');
    const thin = { ...job, tools: job.tools.map((t) => (t.id === 1 ? { ...t, diameter: 3, fluteLength: 16 } : t)) };
    const g = reviewJob(thin, analyze(thin));
    expect(g.find((x) => x.code === 'SLENDER_TOOL')!.text).toMatch(/T1 \(Ø3\) goes 15\.5 mm deep, 5\.2 times its diameter/);
    // and the spindle cannot turn a Ø3 cutter in aluminium as fast as it would like
    expect(g.map((x) => x.code)).toContain('RPM_SHORT');
    // clamps entered and tabs set: those two are gone
    const held = Job.parse({ ...job, obstacles: [{ name: 'clamp', x0: -30, y0: 10, x1: -12, y1: 30, top: 5 }], operations: job.operations.map((o) => (o.type === 'mill_contour_rect' ? { ...o, tabs: 4 } : o)) });
    expect(look(held)).not.toContain('HOLDING_UNKNOWN');
    expect(look(held)).not.toContain('CUT_FREE');
  });

  it('lathe: a thin part hanging out, parting far from the jaws, a thread with no relief, the order', () => {
    const job = withOps('lathe', [
      { type: 'lathe_turn', tool: 1, diameter: 6, zEnd: -45 },
      { type: 'lathe_face', tool: 1, z: 0 },
      { type: 'lathe_thread', tool: 4, diameter: 6, pitch: 1, zEnd: -12 },
      { type: 'lathe_partoff', tool: 2, z: -50 },
      { type: 'lathe_chamfer', tool: 1, diameter: 6, z: 0, size: 0.5 },
    ], { stock: { kind: 'bar', diameter: 12, stickout: 70, front: 1 } });
    const f = reviewJob(job, analyze(job));
    const codes = f.map((x) => x.code);
    for (const c of ['ORDER_FACE', 'ORDER_PARTOFF', 'SLENDER_PART', 'THREAD_NO_RELIEF']) expect(codes).toContain(c);
    const s = f.find((x) => x.code === 'SLENDER_PART')!.text;
    expect(s).toMatch(/down to Ø(5\.\d|6) with 4\d(\.\d)? mm hanging beyond it \(7\.\d to 1\)/);
    // parting 19 mm from the jaws on Ø12 is fine; 40 mm is not
    expect(codes).not.toContain('PARTOFF_FAR');
    const far = withOps('lathe', [{ type: 'lathe_face', tool: 1, z: 0 }, { type: 'lathe_partoff', tool: 2, z: -20 }], { stock: { kind: 'bar', diameter: 12, stickout: 70, front: 1 } });
    // (and the bar itself, 70 mm out on Ø12, is long for its thickness)
    expect(look(far)).toEqual(['PARTOFF_FAR', 'SLENDER_PART']);
    // a relief groove at the thread's end answers the thread
    const relieved = withOps('lathe', [
      { type: 'lathe_face', tool: 1, z: 0 },
      { type: 'lathe_turn', tool: 1, diameter: 9.85, zEnd: -20 },
      { type: 'lathe_groove', tool: 2, diameter: 8, z: -12, width: 2.5, fromDiameter: 9.85 },
      { type: 'lathe_thread', tool: 4, diameter: 10, pitch: 1.5, zEnd: -13 },
    ]);
    expect(look(relieved)).not.toContain('THREAD_NO_RELIEF');
  });
});
