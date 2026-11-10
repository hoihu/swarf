import { describe, expect, it } from 'vitest';
import { SimGrbl, Streamer, RT } from '@swarf/grbl';
import { Jogger } from '../src/lib/jog.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A jogger on a simulated mill (real time), with everything written to it recorded. */
function rig() {
  const sim = new SimGrbl({ wco: [0, 0, 0], mpos: [0, 0, 0] });
  const written: string[] = [];
  const write = sim.write.bind(sim);
  sim.write = async (d: string) => {
    if (d !== RT.status) written.push(d.trim() || d);
    return write(d);
  };
  const s = new Streamer(sim, {}, { pollMs: 10 });
  const jog = new Jogger({ request: (l) => s.request(l), cancel: () => s.override(RT.jogCancel) });
  return { sim, s, jog, written, close: async () => { await s.close(); await sim.close(); } };
}

describe('jogging by hand', () => {
  it('a step is one relative jog of that length', async () => {
    const r = rig();
    await wait(20);
    expect(await r.jog.step('X', -1, 1, 3000)).toBe(true);
    await wait(80);
    expect(r.sim.pos).toEqual([-1, 0, 0]);
    expect(r.written).toEqual(['$J=G91 G21 X-1.000 F3000']);
    await r.close();
  });

  it('holding moves at the feed for as long as it is held and stops on release', async () => {
    const r = rig();
    await wait(20);
    void r.jog.hold('Y', 1, 1200); // 20 mm/s
    await wait(500);
    const during = r.sim.pos[1]!;
    expect(during).toBeGreaterThan(7);
    expect(during).toBeLessThan(10.5);
    r.jog.release();
    await wait(30);
    const at = r.sim.pos[1]!;
    await wait(300);
    // it stood at once: nothing queued ran on
    expect(r.sim.pos[1]).toBe(at);
    expect(r.sim.state).toBe('Idle');
    expect(at - during).toBeLessThan(1);
    // pieces of a tenth of a second, then the cancel (twice), and nothing after
    const pieces = r.written.filter((l) => l.startsWith('$J='));
    expect(new Set(pieces)).toEqual(new Set(['$J=G91 G21 Y2.000 F1200']));
    expect(r.written.slice(-2)).toEqual([RT.jogCancel, RT.jogCancel]);
    await r.close();
  });

  it('never has more than a third of a second of travel queued: a lost cancel cannot run far', async () => {
    const r = rig();
    await wait(20);
    const t0 = Date.now();
    void r.jog.hold('X', 1, 600); // 10 mm/s
    for (let i = 0; i < 12; i++) {
      await wait(50);
      const sent = r.written.filter((l) => l.startsWith('$J=')).length; // each 1 mm = 0.1 s
      const elapsed = (Date.now() - t0) / 1000;
      expect(sent * 0.1 - elapsed).toBeLessThan(0.36);
    }
    // the cable is pulled: no cancel gets through, nothing more is sent
    const cut = r.written.filter((l) => l.startsWith('$J=')).length;
    const pos = r.sim.pos[0]!;
    r.sim.write = async () => {};
    r.jog.release();
    await wait(600);
    expect(r.sim.state).toBe('Idle');
    expect(r.sim.pos[0]).toBeCloseTo(cut * 1, 6);
    expect(r.sim.pos[0]! - pos).toBeLessThan(3.6);
    await r.close();
  });

  it('a refused move ends the hold and says why; one hold at a time', async () => {
    let n = 0;
    const lines: string[] = [];
    const jog = new Jogger({ request: async (l) => { lines.push(l); return ++n > 2 ? { ok: false, error: 15 } : { ok: true }; }, cancel: () => lines.push('cancel') });
    const first = jog.hold('Z', -1, 300);
    void jog.hold('X', 1, 300);
    expect(await jog.step('X', 1, 1, 300)).toBe(false);
    await first;
    expect(jog.holding).toBe(false);
    expect(jog.error).toMatch(/travel/);
    expect(lines.filter((l) => l.startsWith('$J=')).every((l) => l.includes('Z-0.500'))).toBe(true);
    expect(lines).toContain('cancel');
  });
});
