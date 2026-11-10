/**
 * Whole programs on the simulated mill with real setups on its table: the streamer, the simulated
 * controller and the simulated world together. What the checks let through must run without the
 * tool touching what holds the block; what they flag does run into it (the simulator goes on where
 * a machine would not).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLES, Job, analyze, emit, hasErrors } from '@swarf/cam';
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
});
