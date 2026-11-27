import { describe, expect, it } from 'vitest';
import { withOps } from './support/fixtures.ts';
import {
  EXAMPLES,
  emptyJob,
  reviewJob,
  jobFile,
  openJobFile,
  libraryFile,
  openLibraryFile,
  keepTool,
  dropTool,
  takeTool,
  inLibrary,
  setupSheet,
  cutLines,
  toolSummary,
  Job,
  analyze,
  hasErrors,
} from '../src/index.ts';

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
    expect(f.find((x) => x.code === 'THIN_FLOOR')!.message).toMatch(/floor 0\.3 mm thick/);
    // the Ø6 end mill goes 15.5 mm under the raw top: not yet four diameters; a Ø3 one would be
    expect(codes).not.toContain('SLENDER_TOOL');
    const thin = { ...job, tools: job.tools.map((t) => (t.id === 1 ? { ...t, diameter: 3, fluteLength: 16 } : t)) };
    const g = reviewJob(thin, analyze(thin));
    expect(g.find((x) => x.code === 'SLENDER_TOOL')!.message).toMatch(/T1 \(Ø3\) goes 15\.5 mm deep, 5\.2 times its diameter/);
    // and the spindle cannot turn a Ø3 cutter in aluminium as fast as it would like
    expect(g.map((x) => x.code)).toContain('RPM_SHORT');
    // clamps entered and tabs set: those two are gone
    const held = Job.parse({ ...job, obstacles: [{ name: 'clamp', x0: -30, y0: 10, x1: -12, y1: 30, top: 5 }], operations: job.operations.map((o) => (o.type === 'mill_contour_rect' ? { ...o, tabs: 4 } : o)) });
    expect(look(held)).not.toContain('HOLDING_UNKNOWN');
    expect(look(held)).not.toContain('CUT_FREE');
  }, 30000);

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
    const s = f.find((x) => x.code === 'SLENDER_PART')!.message;
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
