/**
 * Whole programs on the simulated mill with real setups on its table: the streamer, the simulated
 * controller and the simulated world together. What the checks let through must run without the
 * tool touching what holds the block; what they flag does run into it (the simulator goes on where
 * a machine would not).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLES, Job, analyze, emit, hasErrors, resumeFrom } from '@swarf/cam';
import { SimGrbl, Streamer, type JobState } from '@swarf/grbl';
import { simWorld } from '../src/lib/simworld.ts';
import type { SetupName } from '../src/lib/sim/setups.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run the job's program at 400× on a simulated mill holding the block in `setup`; resume at every tool change. */
async function run(job: Job, setup: SetupName): Promise<{ states: JobState[]; crashes: typeof simWorld.crashes; changes: number; sim: SimGrbl }> {
  const a = analyze(job);
  const sim = new SimGrbl({ wco: [-200, -120, -80], mpos: [-160, -95, -30], speed: 400, rapid: 3000 });
  simWorld.origin = [...sim.wco] as [number, number, number];
  simWorld.setup = setup;
  simWorld.plate = null;
  simWorld.crashes = [];
  sim.onStep = (p, m) => simWorld.watch(job, p, m.jog ? 'jog' : m.rapid ? 'rapid' : 'feed');
  const states: JobState[] = [];
  const s = new Streamer(sim, { job: (st) => states.push(st) }, { pollMs: 4 });
  await wait(20);
  const tools = [...new Set(a.program.segments.map((g, i, all) => (i === 0 || all[i - 1]!.tool !== g.tool ? i : -1)).filter((i) => i >= 0))].map((i) => a.program.segments[i]!.tool);
  const dia = (id: number) => job.tools.find((t) => t.id === id)!.diameter!;
  let changes = 0;
  simWorld.toolDiameter = dia(tools[0]!);
  await s.run(emit(job, a.program).text, { skipLeadingPause: true });
  for (let i = 0; i < 6000 && !['done', 'failed', 'stopped'].includes(s.jobState); i++) {
    if (s.jobState === 'waiting') {
      // the tool change: the machine stands at the travel height, spindle off, and takes commands
      expect(sim.spindle).toBe(0);
      expect(sim.state).toBe('Idle');
      expect(sim.pos[2] - sim.wco[2]).toBeCloseTo(a.program.home.z, 6);
      changes++;
      simWorld.toolDiameter = dia(tools[changes]!);
      expect((await s.request('G10 L20 P1 Z' + a.program.home.z)).ok).toBe(true);
      await s.resume();
    }
    await wait(5);
  }
  await s.close();
  await sim.close();
  return { states, crashes: [...simWorld.crashes], changes, sim };
}

describe('programs on the simulated mill', () => {
  afterEach(() => {
    simWorld.setup = 'side';
    simWorld.crashes = [];
    simWorld.origin = null;
  });

  it('low edge clamps: the example runs through, tool changes and all, touching nothing; spindle off at the end', async () => {
    const job = EXAMPLES.mill();
    expect(hasErrors(analyze(job).diagnostics)).toBe(false);
    const r = await run(job, 'toe');
    expect(r.states.at(-1)).toBe('done');
    expect(r.changes).toBe(new Set(analyze(job).program.segments.map((s) => s.tool)).size - 1);
    expect(r.crashes).toEqual([]);
    expect(r.sim.spindle).toBe(0);
    // back at the travel position
    expect(r.sim.pos.map((v, i) => v - r.sim.wco[i]!)).toEqual([0, 0, analyze(job).program.home.z]);
  }, 30000);

  it('in the vise without parallels: the through holes drill into the vise bed, as the check warns', async () => {
    const job = EXAMPLES.mill();
    expect(analyze(job).diagnostics.filter((d) => d.code === 'BELOW_STOCK').map((d) => d.opId)).toEqual(['op3']);
    const r = await run(job, 'vise');
    expect(r.crashes.map((c) => c.what)).toEqual(['vise bed']);
    // without the holes: clean
    const shallow = Job.parse({ ...job, operations: job.operations.filter((o) => o.type !== 'mill_drill') });
    expect(analyze(shallow).diagnostics.filter((d) => d.code === 'BELOW_STOCK')).toEqual([]);
    expect((await run(shallow, 'vise')).crashes).toEqual([]);
  }, 30000);

  it('straps over the top: unknown to the job, facing runs into them; known, the check refuses the job', async () => {
    const job = EXAMPLES.mill();
    const r = await run(job, 'straps');
    expect(r.crashes.map((c) => c.what).some((w) => w.endsWith('strap'))).toBe(true);
    const known = Job.parse({
      ...job,
      obstacles: simWorld.obstacles(job).map((s) => {
        const hx = s.kind === 'cyl' ? s.r : s.w / 2;
        const hy = s.kind === 'cyl' ? s.r : s.d / 2;
        return { name: s.name, x0: s.cx - hx, y0: s.cy - hy, x1: s.cx + hx, y1: s.cy + hy, top: s.z1 };
      }),
    });
    const a = analyze(known);
    expect(a.diagnostics.some((d) => d.code === 'OBSTACLE' && d.severity === 'error')).toBe(true);
    // and the travel height clears the bolts
    expect(a.program.home.z).toBeGreaterThan(36);
  }, 30000);
  it('stopped in the middle of the pocket, started again at the pocket: it comes back from above, finishes, and touches nothing', async () => {
    const job = EXAMPLES.mill();
    const a = analyze(job);
    const sim = new SimGrbl({ wco: [-200, -120, -80], mpos: [-160, -95, -30], speed: 300, rapid: 3000 });
    simWorld.origin = [...sim.wco] as [number, number, number];
    simWorld.setup = 'toe';
    simWorld.crashes = [];
    const dia = (id: number) => job.tools.find((t) => t.id === id)!.diameter!;
    sim.onStep = (p, m) => simWorld.watch(job, p, m.jog ? 'jog' : m.rapid ? 'rapid' : 'feed');
    const states: JobState[] = [];
    let line = -1;
    const s = new Streamer(sim, { job: (st) => states.push(st), progress: (_a, _t, src) => (line = src) }, { pollMs: 4 });
    await wait(20);
    const whole = emit(job, a.program);
    const seg = a.program.segments.findIndex((x) => x.opId === 'op2');
    let first = 0;
    for (let i = 0; i < seg; i++) first += a.program.segments[i]!.moves.length;
    const pocketLine = whole.lineOfMove[first + 12]!;
    simWorld.toolDiameter = dia(a.program.segments[0]!.tool);
    await s.run(whole.text, { skipLeadingPause: true });
    for (let i = 0; i < 4000 && line < pocketLine; i++) {
      if (s.jobState === 'waiting') {
        simWorld.toolDiameter = dia(a.program.segments[seg]!.tool);
        await s.resume();
      }
      await wait(5);
    }
    // (the lines acknowledged run ahead of the machine: wait until the cutter is down in the pocket)
    for (let i = 0; i < 2000 && sim.pos[2] - sim.wco[2] >= 0.5; i++) await wait(2);
    // well into the pocket, cutter down in it, spindle on: stop
    expect(sim.pos[2] - sim.wco[2]).toBeLessThan(0.5);
    expect(sim.spindle).toBeGreaterThan(0);
    await s.stop();
    await wait(80);
    expect(s.jobState).toBe('stopped');
    expect(sim.spindle).toBe(0);
    expect(sim.state).toBe('Idle');
    const stoodAt = [...sim.pos];
    // again from the pocket on
    const r = resumeFrom(job, a.program, seg);
    expect(hasErrors(r.diagnostics)).toBe(false);
    const part = emit(job, r.program, { fromSegment: seg });
    let lowestBeforeHome = Infinity;
    let reachedHome = false;
    const watch = sim.onStep;
    sim.onStep = (p, m) => {
      watch!(p, m);
      const w = p.map((v, k) => v - sim.wco[k]!);
      if (!reachedHome) {
        // until it is above home: straight up from where it stood, then across at the travel height
        if (Math.abs(w[0]!) < 1e-6 && Math.abs(w[1]!) < 1e-6) reachedHome = true;
        else if (Math.hypot(p[0]! - stoodAt[0]!, p[1]! - stoodAt[1]!) > 1e-6) lowestBeforeHome = Math.min(lowestBeforeHome, w[2]!);
      }
    };
    await s.run(part.text, { skipLeadingPause: true });
    for (let i = 0; i < 6000 && !['done', 'failed', 'stopped'].includes(s.jobState); i++) {
      if (s.jobState === 'waiting') {
        simWorld.toolDiameter = dia(a.program.segments.at(-1)!.tool);
        await s.resume();
      }
      await wait(5);
    }
    await s.close();
    await sim.close();
    expect(s.jobState).toBe('done');
    expect(reachedHome).toBe(true);
    expect(lowestBeforeHome).toBeCloseTo(a.program.home.z, 6);
    expect(simWorld.crashes).toEqual([]);
    expect(sim.spindle).toBe(0);
  }, 40000);
});
