import { describe, expect, it } from 'vitest';
import { SimGrbl, Streamer } from '@swarf/grbl';
import { Recorder, recorded } from '../src/lib/record.ts';

describe('the record of a session', () => {
  it('lines sent and received with their times, real-time bytes by name, no polls', () => {
    let now = 0;
    const r = new Recorder(() => now);
    r.tx('G0 X10\n');
    now = 12;
    r.rx('o');
    r.rx('k\r\n<Idle|MPos:0,0,0>\r\n');
    now = 200;
    r.tx('?');
    r.rx('<Idle|MPos:0,0,0>\r\n');
    r.tx('?');
    r.rx('<Idle|MPos:0,0,0>\r\n');
    now = 450;
    r.tx('!');
    r.rx('<Hold:0|MPos:0,0,0>\r\n');
    r.tx('\x18');
    r.tx('\x9b');
    r.ev('stopped by the user');
    r.rx("Grbl 1.1f ['$' for help]\r\n");
    expect(r.entries.map((e) => `${e.t} ${e.k} ${e.s}${e.n ? ` x${e.n}` : ''}`)).toEqual([
      '0 tx G0 X10',
      '12 rx ok',
      '12 rx <Idle|MPos:0,0,0> x2',
      '450 tx [feed hold]',
      '450 rx <Hold:0|MPos:0,0,0>',
      '450 tx [reset]',
      '450 tx [spindle -10%]',
      '450 ev stopped by the user',
      "450 rx Grbl 1.1f ['$' for help]",
    ]);
    const text = r.text(['swarf log'], ['settings: none']);
    expect(text).toMatch(/^swarf log\n\n {5}0\.000 {2}> G0 X10\n {5}0\.012 {2}< ok\n {5}0\.012 {2}< <Idle\|MPos:0,0,0> {3}\(and 2 more the same\)\n/);
    expect(text).toMatch(/0\.450 {2}# stopped by the user\n/);
    expect(text.endsWith('\nsettings: none\n')).toBe(true);
  });

  it('keeps the last entries only, and says how many went', () => {
    const r = new Recorder(() => 0);
    r.max = 5;
    for (let i = 0; i < 12; i++) r.tx(`G1 X${i}\n`);
    expect(r.entries.map((e) => e.s)).toEqual(['G1 X7', 'G1 X8', 'G1 X9', 'G1 X10', 'G1 X11']);
    expect(r.text()).toMatch(/\(7 earlier entries are no longer kept\)/);
  });

  it('sits between the sender and the controller without changing what passes', async () => {
    const rec = new Recorder();
    const sim = recorded(new SimGrbl({ speed: 300 }), rec);
    const s = new Streamer(sim, {}, { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    await s.run('G21 G90\nG0 X5\nG1 X10 F600\nM30\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(s.jobState).toBe('done');
    expect(s.last?.wpos?.[0]).toBeCloseTo(10, 3);
    const sent = rec.entries.filter((e) => e.k === 'tx').map((e) => e.s);
    expect(sent).toEqual(expect.arrayContaining(['G21 G90', 'G0 X5', 'G1 X10 F600', 'M30']));
    expect(sent).not.toContain('?');
    expect(rec.entries.filter((e) => e.k === 'rx' && e.s === 'ok').length).toBeGreaterThanOrEqual(4);
    // the way there is in the status reports
    expect(rec.entries.some((e) => e.k === 'rx' && /^<\w+\|MPos:10\.000/.test(e.s))).toBe(true);
    await s.close();
    await sim.close();
  });
});
