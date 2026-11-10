import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '@swarf/cam';
import { SimGrbl, Streamer } from '@swarf/grbl';
import { learned, measureOnSetter, shifted, zAfterChange, type Setter, type SetterPort, type V3 } from '../src/lib/tooling.ts';
import { simWorld } from '../src/lib/simworld.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stored tool offsets', () => {
  it('a longer tool reads lower; on the lathe X is counted on the diameter', () => {
    // mill: T2 is 12.5 mm longer than the reference (its tip 12.5 lower)
    expect(shifted([10, 20, 30], { x: 0, z: 0 }, { x: 0, z: -12.5 }, 1)).toEqual({ x: 10, z: 17.5 });
    // lathe, diameter mode: T3's tip is 1.5 mm further out (radius) and 4 mm further towards the chuck than T1's
    expect(shifted([40, 0, 2], { x: 0, z: 0 }, { x: 1.5, z: -4 }, 0.5)).toEqual({ x: 43, z: -2 });
    // and back again
    expect(shifted([43, 0, -2], { x: 1.5, z: -4 }, { x: 0, z: 0 }, 0.5)).toEqual({ x: 40, z: 2 });
  });

  it('learning from a touch-off by hand gives what applying then uses', () => {
    // zero right for T1 (the reference) with the work offset at (-60, 0, -150), counted on the diameter;
    // T3 is touched off: the same place now reads X +3 (diameter), Z -4
    const then: V3 = [-60, 0, -150];
    const now: V3 = [-63, 0, -146];
    const o3 = learned({ x: 0, z: 0 }, then, now, 0.5);
    expect(o3).toEqual({ x: 1.5, z: -4 });
    // next time, from T1's zero: applying it shows the same shift
    const wpos: V3 = [25, 0, 3];
    const s = shifted(wpos, { x: 0, z: 0 }, o3, 0.5);
    expect([s.x - wpos[0], s.z - wpos[2]]).toEqual([3, -4]);
    // via another tool on the way: T1 → T2 → T3 is T1 → T3
    const o2 = { x: -0.7, z: 2.2 };
    const a = shifted(wpos, { x: 0, z: 0 }, o2, 0.5);
    const b = shifted([a.x, 0, a.z], o2, o3, 0.5);
    expect(b.x).toBeCloseTo(s.x, 9);
    expect(b.z).toBeCloseTo(s.z, 9);
  });
});

describe('the tool setter, on the simulated mill', () => {
  afterEach(() => {
    simWorld.origin = null;
    simWorld.stickout = 0;
    simWorld.setup = 'side';
  });

  it('keeps Z zero on the work through tools of different lengths', async () => {
    const job = EXAMPLES.mill();
    const sim = new SimGrbl({ wco: [-200, -120, -80], mpos: [-160, -95, -30], speed: 40, rapid: 3000 });
    simWorld.origin = [...sim.wco] as V3;
    simWorld.setup = 'block';
    simWorld.plate = null;
    simWorld.toolDiameter = 6;
    simWorld.loadTool(1);
    sim.contact = (p) => simWorld.contact(job, p);
    const s = new Streamer(sim, {}, { pollMs: 5 });
    await wait(30);
    const port: SetterPort = {
      request: (l) => s.request(l),
      mpos: () => [...s.last!.mpos!] as V3,
      wco: () => s.last!.mpos!.map((v, i) => v - s.last!.wpos![i]!) as V3,
      probe: () => s.lastProbe,
      clearProbe: () => (s.lastProbe = null),
      settle: async () => {
        await wait(15);
        for (let i = 0; i < 4000 && s.state !== 'Idle'; i++) await wait(5);
        await wait(15);
      },
    };
    /** Touch the block's top at X40 Y25 and return the work Z it is found at. */
    const touchTop = async (): Promise<number> => {
      await port.request('G90 G0 Z25');
      await port.request('G0 X40 Y25');
      await port.settle();
      s.lastProbe = null;
      await port.request('G38.2 Z-20 F200');
      await port.settle();
      expect(s.lastProbe?.ok).toBe(true);
      const z = s.lastProbe!.mpos[2] - port.wco()[2];
      await port.request('G0 Z25');
      await port.settle();
      return z;
    };
    // T1: its zero put on the top where it touches
    const z1 = await touchTop();
    await port.request(`G10 L20 P1 Z${(25 - z1).toFixed(4)}`);
    await port.settle();
    expect(Math.abs(await touchTop())).toBeLessThan(0.02);
    // the setter, as one would set it up: over it, 25 mm above its top with the reference tool
    const at = simWorld.setterAt(job)!;
    const setter: Setter = { x: simWorld.origin[0] + at.x, y: simWorld.origin[1] + at.y, z: simWorld.origin[2] + at.top + 25, depth: 40 };
    let ref = await measureOnSetter(setter, port);
    // (the spindle is higher than the setter's top by what the tool sticks out less than the simulator's nominal one)
    expect(ref).toBeCloseTo(simWorld.origin[2] + at.top + simWorld.stickout, 1);
    for (const tool of [2, 3, 4]) {
      // the tool is changed: it sticks out differently, and the Z shown is wrong by that much
      const before = simWorld.stickout;
      const more = simWorld.loadTool(tool) - before;
      expect(Math.abs(more)).toBeGreaterThan(1);
      const now = await measureOnSetter(setter, port);
      expect(now - ref).toBeCloseTo(more, 1);
      const z = zAfterChange(port.mpos()[2] - port.wco()[2], ref, now);
      await port.request(`G10 L20 P1 Z${z.toFixed(4)}`);
      await port.settle();
      ref = now;
      // the top of the work is at Z0 again
      expect(Math.abs(await touchTop()), `T${tool}`).toBeLessThan(0.03);
    }
    await s.close();
    await sim.close();
  }, 120000);

  it('stops if something is in the way, and says so if the setter is not there', async () => {
    const lines: string[] = [];
    let probe: { mpos: V3; ok: boolean } | null = null;
    const port: SetterPort = {
      request: async (l) => {
        lines.push(l);
        // the move across runs into something
        if (l.includes('G38.3 X')) probe = { mpos: [0, 0, 0], ok: true };
        return { ok: true };
      },
      mpos: () => [0, 0, 0],
      wco: () => [0, 0, 0],
      probe: () => probe,
      clearProbe: () => (probe = null),
      settle: async () => {},
    };
    await expect(measureOnSetter({ x: 100, y: 50, z: 20, depth: 30 }, port)).rejects.toThrow(/Across to the setter: touched something/);
    expect(lines.some((l) => l.includes('G38.2'))).toBe(false);
    // nothing under the tool: the controller's alarm comes back as an error, with a hint
    const none: SetterPort = { ...port, request: async (l) => (l.includes('G38.2') ? { ok: false, message: 'ALARM:5 no contact' } : { ok: true }), probe: () => null };
    await expect(measureOnSetter({ x: 100, y: 50, z: 20, depth: 30 }, none)).rejects.toThrow(/Looking for the setter.*ALARM:5/);
  });
});
