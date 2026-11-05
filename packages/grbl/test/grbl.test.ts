import { describe, expect, it } from 'vitest';
import { RT, Streamer, classify, parseStatus, prepare, type JobState, type Transport } from '../src/index.ts';

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
  async write(data: string) {
    if (data.length === 1 && '?!~\x18\x90\x91\x92'.includes(data)) {
      this.realtime.push(data);
      if (data === RT.status) this.emit(`<${this.state}|MPos:1.000,2.000,3.000|FS:0,0|WCO:1.000,0.000,0.000>\r\n`);
      if (data === RT.hold) this.state = 'Hold:0';
      if (data === RT.resume) this.state = 'Run';
      if (data === RT.reset) {
        this.rx = [];
        this.used = 0;
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
    if (this.state.startsWith('Hold')) return;
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
    const s = new Streamer(g, { job: (st, m) => { states.push(st); if (m) message = m; } }, { pollMs: 0 });
    await s.run(program(50));
    await until(s, ['failed', 'done'], states);
    await s.close();
    expect(states.at(-1)).toBe('failed');
    expect(message).toMatch(/error:20 on line 9 .*unsupported G-code/);
    expect(g.executed.length).toBeLessThan(20);
  });

  it('pauses at M0 and resumes on cycle start', async () => {
    const g = new FakeGrbl();
    const states: JobState[] = [];
    const s = new Streamer(g, { job: (st) => states.push(st) }, { pollMs: 3 });
    await s.run('G0 X1\nM0\nG0 X2\nM30');
    await until(s, ['paused'], states);
    expect(g.executed).toEqual(['G0 X1', 'M0']);
    await s.resume();
    await until(s, ['done'], states);
    await s.close();
    expect(g.executed).toEqual(['G0 X1', 'M0', 'G0 X2', 'M30']);
    expect(states).toEqual(['running', 'paused', 'running', 'done']);
  });

  it('soft reset drops the job', async () => {
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

  it('learns the buffer size from $I', () => {
    const g = new FakeGrbl(1024);
    const s = new Streamer(g, {}, { pollMs: 0 });
    g.emit('[OPT:VNMHL,35,1024,3,0]\r\nok\r\n');
    void s.close();
    // one byte kept free, as grbl's own senders do
    expect(s.rxBuffer).toBe(1023);
  });
});
