import { describe, expect, it } from 'vitest';
import { parseGcode } from './support/parse.ts';
import { codes, withOps } from './support/fixtures.ts';
import {
  EXAMPLES,
  Job,
  LatheMaterial,
  MillMaterial,
  analyze,
  simulate,
  generate,
  resumeFrom,
  hasErrors,
  emit,
  fixed,
  roundTo,
  walk,
  fitArcs,
  diffJobs,
  isEmptyDiff,
  plannedSeconds,
  cuttingData,
  MATERIALS,
  type Program,
  type OperationInput,
} from '../src/index.ts';
import type { JobInput } from '../src/schema.ts';
import { levels } from '../src/program.ts';

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

  const mill = EXAMPLES.mill();
  it.each<[string, Partial<JobInput>, string]>([
    ['workMaterial', { workMaterial: 'stainless' }, 'workpiece material aluminium → stainless'],
    ['obstacles', { obstacles: [...mill.obstacles, { name: 'clamp', x0: -20, y0: 0, x1: -5, y1: 20, top: 10 }] }, 'clamps'],
    ['notes', { notes: 'held in the vise on parallels' }, 'notes'],
    ['measured', { measured: { angle: 0.5, top: [] } }, 'measurements'],
    ['setups', { setups: { at: 0, name: 'Top', others: [{ name: 'Bottom', turn: 'over-y', stock: mill.stock }] } }, 'setups'],
  ])('sees a change of %s alone', (_, patch, words) => {
    const d = diffJobs(mill, Job.parse({ ...mill, ...patch }));
    expect(isEmptyDiff(d)).toBe(false);
    expect(d.other).toEqual([words]);
  });

  it('gives an empty diff for an unchanged job', () => {
    expect(isEmptyDiff(diffJobs(mill, Job.parse({ ...mill })))).toBe(true);
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
    // the plain estimate (path length over feed, rapids at the rapid rate): 58.5 s and 214.9 s
    const plain = { lathe: 58, mill: 214 };
    for (const kind of ['lathe', 'mill'] as const) {
      expect(analyze(EXAMPLES[kind]()).seconds).toBeGreaterThan(plain[kind]);
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

  it('says when the chuck size is a guess', () => {
    const turn: OperationInput[] = [{ type: 'lathe_turn', tool: 1, diameter: 20, zEnd: -20 }];
    const unknown = withOps('lathe', turn, { machine: { ...EXAMPLES.lathe().machine, chuckDiameter: undefined } });
    const d = analyze(unknown).diagnostics.find((x) => x.code === 'CHUCK_UNKNOWN');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toMatch(/chuck Ø/);
    expect(codes(withOps('lathe', turn))).not.toContain('CHUCK_UNKNOWN');
    expect(codes(withOps('mill', []))).not.toContain('CHUCK_UNKNOWN');
  });

  it("keeps under the chuck's rated rpm", () => {
    const turn: OperationInput[] = [{ type: 'lathe_turn', tool: 1, diameter: 20, zEnd: -20, rpm: 1500 }];
    const limited = (chuckMaxRpm: number) => withOps('lathe', turn, { machine: { ...EXAMPLES.lathe().machine, chuckMaxRpm } });
    // a program made before the limit was set (or by anything else) is caught by the check
    const fast = simulate(limited(1200), generate(withOps('lathe', turn)).program).diagnostics.find((x) => x.code === 'CHUCK_RPM');
    expect(fast?.severity).toBe('error');
    expect(fast?.message).toMatch(/1500 rpm.*1200/);
    expect(fast?.opId).toBe('op1');
    // generating with the limit keeps under it
    const a = analyze(limited(1200));
    expect(a.program.segments.every((s) => s.rpm <= 1200)).toBe(true);
    expect(a.diagnostics.map((x) => x.code)).not.toContain('CHUCK_RPM');
    expect(codes(limited(1500))).not.toContain('CHUCK_RPM');
    expect(codes(limited(2000))).not.toContain('CHUCK_RPM');
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

describe('number helpers', () => {
  it('rounds to the given decimals, without trailing zeros or a minus zero', () => {
    expect(fixed(12.3456, 1)).toBe('12.3');
    expect(fixed(2.5, 2)).toBe('2.5');
    expect(fixed(-0.04, 1)).toBe('0');
    expect(fixed(-1.0004, 3)).toBe('-1');
    expect(roundTo(0.12345, 3)).toBe(0.123);
    expect(Object.is(roundTo(-0.0001, 2), 0)).toBe(true);
  });
});

describe('analyze, again for the same job', () => {
  it('is quick the second time for an equal job', () => {
    const first = analyze(EXAMPLES.mill());
    const t0 = performance.now();
    const again = analyze(EXAMPLES.mill());
    expect(performance.now() - t0).toBeLessThan(1);
    expect(again.diagnostics).toEqual(first.diagnostics);
    expect(again.seconds).toBe(first.seconds);
  });

  it('works it out again when anything in the job changes', () => {
    const job = EXAMPLES.mill();
    const clean = analyze(job);
    expect(hasErrors(clean.diagnostics)).toBe(false);
    // the pocket deeper than the 15 mm block
    const deep = { ...job, operations: job.operations.map((o) => (o.id === 'op2' ? { ...o, zBottom: -18 } : o)) };
    expect(analyze(deep).diagnostics.map((d) => d.code)).toContain('BELOW_STOCK');
    // steel cuts slower
    expect(analyze({ ...job, workMaterial: 'steel' }).seconds).toBeGreaterThan(clean.seconds);
    // a clamp over the drill hole at X8 Y8
    const clamp = { ...job, obstacles: [{ name: 'clamp', x0: 4, y0: 4, x1: 12, y1: 12, top: 10 }] };
    expect(analyze(clamp).diagnostics.map((d) => d.code)).toContain('OBSTACLE');
    // and the job as it was is still clean
    expect(analyze(EXAMPLES.mill()).diagnostics).toEqual(clean.diagnostics);
  });
});
