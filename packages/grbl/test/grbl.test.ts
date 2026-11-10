import { describe, expect, it } from 'vitest';
import { RT, SimGrbl, Streamer, classify, parseStatus, prepare, type JobState, type Transport } from '../src/index.ts';

/**
 * A pretend grblHAL: lines go into its receive buffer and are "executed" one per tick, each
 * answered with ok (or the error/alarm a test asks for). It fails the test if the sender ever
 * overfills the buffer.
 */
class FakeGrbl implements Transport {
  rx: string[] = [];
  used = 0;
  maxUsed = 0;
  executed: string[] = [];
  realtime: string[] = [];
  state = 'Idle';
  errorOn: string | null = null;
  #cb: (t: string) => void = () => {};
  #timer: ReturnType<typeof setInterval>;
  readonly size: number;
  constructor(size = 128) {
    this.size = size;
    this.#timer = setInterval(() => this.#tick(), 1);
  }
  onData(cb: (t: string) => void) {
    this.#cb = cb;
  }
  emit(text: string) {
    this.#cb(text);
  }
  /** Does not hold (a move that cannot be interrupted). */
  ignoreHold = false;
  /** Answers nothing (cable pulled). */
  dead = false;
  async write(data: string) {
    if (this.dead) return;
    if (data.length === 1 && '?!~\x18\x90\x91\x92'.includes(data)) {
      this.realtime.push(data);
      if (data === RT.status) this.emit(`<${this.state}|MPos:1.000,2.000,3.000|FS:0,0|WCO:1.000,0.000,0.000>\r\n`);
      if (data === RT.hold && !this.ignoreHold) this.state = 'Hold:0';
      if (data === RT.resume) this.state = 'Run';
      if (data === RT.reset) {
        this.rx = [];
        this.used = 0;
        this.state = 'Idle';
        this.emit('\r\nGrblHAL 1.1f [\'$\' or \'$HELP\' for help]\r\n');
      }
      return;
    }
    for (const line of data.split('\n').filter(Boolean)) {
      this.rx.push(line);
      this.used += line.length + 1;
      this.maxUsed = Math.max(this.maxUsed, this.used);
      if (this.used > this.size) throw new Error(`buffer overflow: ${this.used} > ${this.size}`);
    }
  }
  async close() {
    clearInterval(this.#timer);
  }
  #tick() {
    if (this.dead || this.state.startsWith('Hold') || this.state === 'Alarm') return;
    const line = this.rx.shift();
    if (line === undefined) {
      if (this.state === 'Run') this.state = 'Idle';
      return;
    }
    this.state = 'Run';
    this.used -= line.length + 1;
    this.executed.push(line);
    if (line === this.errorOn) this.emit('error:20\r\n');
    else this.emit('ok\r\n');
    if (line === 'M0') this.state = 'Hold:0';
  }
}

const program = (n: number) => ['(test)', 'G21 G90 G94 G54', 'G17', ...Array.from({ length: n }, (_, i) => `G1 X${(i * 0.731).toFixed(3)} Y${(i * 1.17).toFixed(3)} F600`), 'M30'].join('\n');

function until(s: Streamer, states: JobState[], log: JobState[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout, states: ${log.join(',')}`)), 4000);
    const check = setInterval(() => {
      if (states.includes(s.jobState)) {
        clearTimeout(t);
        clearInterval(check);
        resolve();
      }
    }, 2);
  });
}

describe('parsing', () => {
  it('reads status reports and works out the work position', () => {
    const r = parseStatus('<Run|MPos:10.000,5.000,-2.000|FS:500,8000|WCO:2.000,1.000,-1.000|Ov:100,100,90>')!;
    expect(r.status).toMatchObject({ state: 'Run', mpos: [10, 5, -2], wpos: [8, 4, -1], feed: 500, spindle: 8000, ov: [100, 100, 90] });
    // a later report without WCO uses the one remembered
    expect(parseStatus('<Idle|MPos:3.000,1.000,0.000|FS:0,0>', r.wco)!.status.wpos).toEqual([1, 0, 1]);
    expect(parseStatus('<Hold:1|WPos:1.000,2.000,3.000>')!.status).toMatchObject({ state: 'Hold', sub: 1, wpos: [1, 2, 3] });
  });

  it('classifies messages', () => {
    expect(classify('ok').incoming).toEqual({ kind: 'ok' });
    expect(classify('error:22').incoming).toEqual({ kind: 'error', code: 22 });
    expect(classify('ALARM:1').incoming).toEqual({ kind: 'alarm', code: 1 });
    expect(classify('GrblHAL 1.1f [\'$\' for help]').incoming.kind).toBe('welcome');
    expect(classify('[MSG:Pgm End]').incoming).toEqual({ kind: 'msg', text: 'Pgm End' });
  });

  it('strips comments and blank lines but remembers source lines', () => {
    expect(prepare('(hi)\n\nG0 X1 (move)\n; note\n%\nM30')).toEqual([{ text: 'G0 X1', source: 2 }, { text: 'M30', source: 5 }]);
  });
});

describe('streaming', () => {
  it('keeps the receive buffer full but never overfills it', async () => {
    const g = new FakeGrbl(128);
    const states: JobState[] = [];
    let acked = 0;
    const s = new Streamer(g, { job: (st) => states.push(st), progress: (a) => (acked = a) }, { rxBuffer: 127, pollMs: 5 });
    await s.run(program(300));
    await until(s, ['done', 'failed'], states);
    await s.close();
    expect(states.at(-1)).toBe('done');
    expect(g.executed).toHaveLength(303);
    expect(acked).toBe(303);
    expect(g.maxUsed).toBeLessThanOrEqual(127);
    expect(g.maxUsed).toBeGreaterThan(90); // more than one line in flight
  });

  it('stops at the first error and says which line', async () => {
    const g = new FakeGrbl();
    g.errorOn = 'G1 X3.655 Y5.850 F600';
    const states: JobState[] = [];
    let message = '';
    const s = new Streamer(g, { job: (st, m) => { states.push(st); if (m) message = m; } }, { pollMs: 3 });
    await s.run(program(50));
    await until(s, ['failed', 'done'], states);
    await new Promise((r) => setTimeout(r, 30));
    await s.close();
    expect(states.at(-1)).toBe('failed');
    expect(message).toMatch(/error:20 on line 9 .*unsupported G-code/);
    // the controller would run on with the lines it has, past the one it skipped: held at once, then reset
    const hold = g.realtime.indexOf(RT.hold);
    expect(hold).toBeGreaterThanOrEqual(0);
    expect(g.realtime.indexOf(RT.reset)).toBeGreaterThan(hold);
    expect(g.executed.length).toBeLessThan(10);
    expect(s.bufferUsed).toBe(0);
  });

  it('refuses to start unless the controller is idle', async () => {
    const g = new FakeGrbl();
    const s = new Streamer(g, {}, { pollMs: 3 });
    g.state = 'Hold:0';
    await new Promise((r) => setTimeout(r, 15));
    await expect(s.run(program(3))).rejects.toThrow(/must be idle/);
    g.state = 'Alarm';
    await new Promise((r) => setTimeout(r, 15));
    await expect(s.run(program(3))).rejects.toThrow(/alarm/);
    await s.close();
    expect(g.executed).toEqual([]);
  });

  it('at M0 (a tool change) waits with the controller idle and free, and goes on at resume', async () => {
    const g = new FakeGrbl();
    const states: JobState[] = [];
    const s = new Streamer(g, { job: (st) => states.push(st) }, { pollMs: 3 });
    await s.run('G0 X1\nM0\nG0 X2\nM30');
    await until(s, ['waiting'], states);
    // M0 itself is not sent: a controller paused by it takes no jog and no zero setting
    expect(g.executed).toEqual(['G0 X1']);
    expect(s.state).toBe('Idle');
    // touching off: commands go through, and their answers come back
    expect(await s.request('G10 L20 P1 Z0')).toEqual({ ok: true });
    await expect(s.run('G0 X9')).rejects.toThrow(/already running/);
    await s.resume();
    await until(s, ['done'], states);
    await s.close();
    expect(g.executed).toEqual(['G0 X1', 'G10 L20 P1 Z0', 'G0 X2', 'M30']);
    expect(states).toEqual(['running', 'waiting', 'running', 'done']);
  });

  it('stop while nothing moves resets at once and drops the job', async () => {
    const g = new FakeGrbl();
    const states: JobState[] = [];
    const s = new Streamer(g, { job: (st) => states.push(st) }, { pollMs: 0 });
    await s.run(program(500));
    await s.stop();
    await s.close();
    expect(states).toEqual(['running', 'stopped']);
    expect(g.realtime).toContain(RT.reset);
    expect(s.bufferUsed).toBe(0);
  });

  it('stop while moving holds first (the position stays true) and resets once it stands', async () => {
    const g = new FakeGrbl();
    const states: JobState[] = [];
    const s = new Streamer(g, { job: (st) => states.push(st) }, { pollMs: 3 });
    await s.run(program(500));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.state).toBe('Run');
    await s.stop();
    expect(g.realtime.at(-1)).toBe(RT.hold);
    await new Promise((r) => setTimeout(r, 20));
    await s.close();
    expect(states).toEqual(['running', 'stopped']);
    const rt = g.realtime.filter((c) => c !== RT.status);
    expect(rt).toEqual([RT.hold, RT.reset]);
  });

  it('a controller that will not stand still is reset anyway after a moment', async () => {
    const g = new FakeGrbl();
    g.ignoreHold = true;
    const s = new Streamer(g, {}, { pollMs: 3 });
    await s.run(program(2000));
    await new Promise((r) => setTimeout(r, 20));
    await s.stop();
    expect(g.realtime).not.toContain(RT.reset);
    await new Promise((r) => setTimeout(r, 1600));
    await s.close();
    expect(g.realtime).toContain(RT.reset);
  });

  it('notices a controller that stops answering: the job fails and says so', async () => {
    const g = new FakeGrbl();
    const states: JobState[] = [];
    let message = '';
    const link: boolean[] = [];
    const s = new Streamer(g, { job: (st, m) => { states.push(st); if (m) message = m; }, link: (l) => link.push(l) }, { pollMs: 20 });
    await s.run(program(4000));
    await new Promise((r) => setTimeout(r, 60));
    g.dead = true;
    await new Promise((r) => setTimeout(r, 2300));
    expect(s.lost).toBe(true);
    expect(states.at(-1)).toBe('failed');
    expect(message).toMatch(/connection is lost.*emergency stop/);
    await expect(s.run(program(3))).rejects.toThrow(/does not answer/);
    // it comes back
    g.dead = false;
    await new Promise((r) => setTimeout(r, 60));
    expect(s.lost).toBe(false);
    expect(link).toEqual([true, false]);
    await s.close();
  });

  it('learns the buffer size from $I', () => {
    const g = new FakeGrbl(1024);
    const s = new Streamer(g, {}, { pollMs: 0 });
    g.emit('[OPT:VNMHL,35,1024,3,0]\r\nok\r\n');
    void s.close();
    // one byte kept free, as grbl's own senders do
    expect(s.rxBuffer).toBe(1023);
  });
});

describe('simulated controller', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('streams a program, reports MPos and WCO, jogs in machine coordinates and waits at M0', async () => {
    const sim = new SimGrbl({ wco: [-100, -50, -20], speed: 200 });
    const states: string[] = [];
    const s = new Streamer(sim, { status: (st) => states.push(st.state) }, { pollMs: 5 });
    await s.send('$I');
    expect(s.rxBuffer).toBe(1023);
    await wait(20); // its welcome line first: a restart drops whatever runs
    await s.run('G21 G90 G54\nG0 X10 Y5 Z2\nM0\nG1 X20 F600\nM30\n');
    await wait(100);
    expect(s.last?.wpos).toEqual([10, 5, 2]);
    expect(s.last?.mpos).toEqual([-90, -45, -18]);
    // the tool change: everything before it done, the controller idle (not held: it can be jogged)
    expect(s.last?.state).toBe('Idle');
    expect(s.jobState).toBe('waiting');
    await s.resume();
    await wait(150);
    expect(s.last?.wpos?.[0]).toBeCloseTo(20, 3);
    await s.send('$J=G53 G90 X-50 Y-30 Z-10 F3000');
    await wait(150);
    expect(s.last?.mpos).toEqual([-50, -30, -10]);
    await s.close();
    await sim.close();
  });

  it('lathe: X as a diameter in words and reports', async () => {
    const sim = new SimGrbl({ lathe: true, wco: [-30, 0, -120], speed: 500 });
    const s = new Streamer(sim, {}, { pollMs: 5 });
    await s.send('G0 X20 Z-5');
    await wait(80);
    expect(sim.pos).toEqual([-20, 0, -125]);
    expect(s.last?.wpos).toEqual([20, 0, -5]);
    await s.close();
    await sim.close();
  });
});

describe('probing (simulated controller)', () => {
  it('G38.2 stops on contact, reports [PRB], answers the line only then, and holds the next lines back', async () => {
    const sim = new SimGrbl({ mpos: [0, 0, -50], speed: 300 });
    sim.contact = (p) => p[2] <= -61.234;
    const probes: number[][] = [];
    const s = new Streamer(sim, { probe: (p) => probes.push([...p.mpos, p.ok ? 1 : 0]) }, { pollMs: 5 });
    const order: string[] = [];
    await new Promise((r) => setTimeout(r, 20)); // the welcome line first (it means: reset)
    const a = s.request('G91 G38.2 Z-20 F100').then((r) => order.push(`probe ${r.ok}`));
    const b = s.request('G90').then((r) => order.push(`g90 ${r.ok}`));
    await Promise.all([a, b]);
    expect(order).toEqual(['probe true', 'g90 true']);
    expect(probes).toHaveLength(1);
    expect(probes[0]![2]).toBeCloseTo(-61.234, 2);
    expect(s.lastProbe?.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.last?.pins).toBe('P');
    await s.close();
    await sim.close();
  });

  it('no contact within the distance: ALARM:5, and the waiting request hears of it; $X unlocks', async () => {
    const sim = new SimGrbl({ mpos: [0, 0, -50], speed: 300 });
    sim.contact = (p) => p[2] <= -90;
    const s = new Streamer(sim, {}, { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    const r = await s.request('G91 G38.2 Z-10 F200');
    expect(r).toMatchObject({ ok: false, alarm: 5 });
    expect((await s.request('G0 X1')).ok).toBe(false);
    await s.request('$X');
    expect((await s.request('G90 G0 X1')).ok).toBe(true);
    await s.close();
    await sim.close();
  });

  it('M8 switches the flood output, seen in the status', async () => {
    const sim = new SimGrbl({ speed: 300 });
    const s = new Streamer(sim, {}, { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    await s.request('M8');
    await new Promise((r) => setTimeout(r, 30));
    expect(s.last?.acc).toBe('F');
    await s.request('M9');
    await new Promise((r) => setTimeout(r, 30));
    expect(s.last?.acc).toBeUndefined();
    await s.close();
    await sim.close();
  });
});

describe('work offsets (simulated controller)', () => {
  it('G10 L2 sets the offset in machine coordinates, L20 so the current position reads the value; neither moves', async () => {
    const sim = new SimGrbl({ wco: [-100, -50, -20], mpos: [-60, -30, -5], speed: 300 });
    const s = new Streamer(sim, {}, { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    await s.request('G10 L2 P1 Z-30.5');
    expect(sim.wco).toEqual([-100, -50, -30.5]);
    await s.request('G10 L20 P1 X0 Y0');
    expect(sim.wco).toEqual([-60, -30, -30.5]);
    expect(sim.pos).toEqual([-60, -30, -5]);
    await s.close();
    await sim.close();
  });
});
