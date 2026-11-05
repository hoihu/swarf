/**
 * Streams a G-code program to grbl/grblHAL with the character-counting protocol: as many lines
 * as fit in the controller's receive buffer are in flight; each `ok` (or `error`) frees the
 * oldest. Real-time commands (status, hold, resume, reset, overrides) are single bytes that
 * bypass the buffer. Transport-agnostic: Web Serial in the app, a fake controller in tests.
 */
import { ALARMS, ERRORS, classify, type Incoming, type MachineState, type Status } from './status.ts';

export interface Transport {
  write(data: string): Promise<void>;
  /** Called with raw text as it arrives (any chunking). */
  onData(cb: (text: string) => void): void;
  close(): Promise<void>;
}

export const RT = {
  status: '?',
  hold: '!',
  resume: '~',
  reset: '\x18',
  feed100: '\x90',
  feedPlus10: '\x91',
  feedMinus10: '\x92',
} as const;

export interface StreamLine {
  /** What is sent (comments stripped). */
  text: string;
  /** 0-based line in the original program. */
  source: number;
}

/** The lines worth sending: comments, blank lines and % removed, words kept as written. */
export function prepare(program: string): StreamLine[] {
  const out: StreamLine[] = [];
  program.split(/\r?\n/).forEach((raw, source) => {
    const text = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim();
    if (text && text !== '%') out.push({ text, source });
  });
  return out;
}

export type JobState = 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';

export interface StreamerEvents {
  status?: (s: Status) => void;
  /** Lines acknowledged so far, of the total. */
  progress?: (acked: number, total: number, sourceLine: number) => void;
  job?: (state: JobState, message?: string) => void;
  /** Everything the controller says (except status reports) and everything sent, for the console. */
  log?: (dir: 'in' | 'out', text: string) => void;
}

export interface StreamerOptions {
  /** Receive buffer size in bytes: grbl 128, grblHAL usually 1024 (see $I, OPT field). */
  rxBuffer?: number;
  /** Status poll interval while connected, ms (0 = off). */
  pollMs?: number;
}

export class Streamer {
  state: MachineState = 'Unknown';
  last: Status | null = null;
  jobState: JobState = 'idle';
  #t: Transport;
  #ev: StreamerEvents;
  #rx: number;
  #partial = '';
  #wco: [number, number, number] | undefined;
  #queue: StreamLine[] = [];
  #inflight: StreamLine[] = [];
  #used = 0;
  #acked = 0;
  #total = 0;
  #poll: ReturnType<typeof setInterval> | null = null;
  /** Lines sent outside a job (MDI) wait for their ok too. */
  #mdi = 0;

  constructor(t: Transport, ev: StreamerEvents = {}, opts: StreamerOptions = {}) {
    this.#t = t;
    this.#ev = ev;
    this.#rx = opts.rxBuffer ?? 127;
    t.onData((text) => this.#onData(text));
    if (opts.pollMs !== 0) this.#poll = setInterval(() => void this.#t.write(RT.status).catch(() => {}), opts.pollMs ?? 200);
  }

  get busy(): boolean {
    return this.jobState === 'running' || this.jobState === 'paused';
  }

  /** Bytes of the receive buffer this streamer believes are taken. */
  get bufferUsed(): number {
    return this.#used;
  }

  /** Receive buffer bytes the sender fills (one less than the controller's buffer). */
  get rxBuffer(): number {
    return this.#rx;
  }

  setRxBuffer(bytes: number): void {
    this.#rx = Math.max(64, bytes - 1);
  }

  /** Start streaming a program. Refused while another job runs. */
  async run(program: string): Promise<void> {
    if (this.busy) throw new Error('A job is already running.');
    if (this.state === 'Alarm') throw new Error('The controller is in alarm: unlock ($X) or home first.');
    this.#queue = prepare(program);
    this.#total = this.#queue.length;
    this.#acked = 0;
    this.#setJob('running');
    await this.#pump();
  }

  /** One line typed by hand (MDI), only while no job runs. */
  async send(line: string): Promise<void> {
    if (this.busy) throw new Error('Not while a job runs.');
    const text = line.trim();
    if (!text) return;
    this.#mdi++;
    this.#ev.log?.('out', text);
    await this.#t.write(`${text}\n`);
  }

  async hold(): Promise<void> {
    await this.#t.write(RT.hold);
    if (this.jobState === 'running') this.#setJob('paused');
  }

  async resume(): Promise<void> {
    await this.#t.write(RT.resume);
    if (this.jobState === 'paused') this.#setJob('running');
  }

  /** Soft reset: stops motion at once (position may be lost while moving), drops the job. */
  async stop(): Promise<void> {
    const wasBusy = this.busy;
    this.#queue = [];
    this.#inflight = [];
    this.#used = 0;
    this.#mdi = 0;
    // before the reset: the controller's restart message must not report the job a second time
    if (wasBusy) this.#setJob('stopped', 'Stopped by soft reset.');
    await this.#t.write(RT.reset);
  }

  async override(cmd: (typeof RT)['feed100' | 'feedPlus10' | 'feedMinus10']): Promise<void> {
    await this.#t.write(cmd);
  }

  async close(): Promise<void> {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    await this.#t.close();
  }

  #setJob(s: JobState, message?: string): void {
    this.jobState = s;
    this.#ev.job?.(s, message);
  }

  async #pump(): Promise<void> {
    while (this.jobState === 'running' || this.jobState === 'paused') {
      const next = this.#queue[0];
      if (!next) break;
      const len = next.text.length + 1;
      if (this.#used + len > this.#rx && this.#inflight.length) break;
      this.#queue.shift();
      this.#inflight.push(next);
      this.#used += len;
      this.#ev.log?.('out', next.text);
      await this.#t.write(`${next.text}\n`);
    }
  }

  #onData(text: string): void {
    const lines = (this.#partial + text).split(/\r?\n/);
    this.#partial = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) this.#onLine(line);
  }

  #onLine(line: string): void {
    const { incoming, wco } = classify(line, this.#wco);
    if (wco) this.#wco = wco;
    if (incoming.kind !== 'status') this.#ev.log?.('in', line.trim());
    this.#handle(incoming);
  }

  #handle(m: Incoming): void {
    switch (m.kind) {
      case 'status':
        this.state = m.status.state;
        this.last = m.status;
        this.#ev.status?.(m.status);
        // M0 in the program pauses the controller: show it as paused, cycle start resumes
        if (this.jobState === 'running' && m.status.state === 'Hold') this.#setJob('paused');
        else if (this.jobState === 'paused' && m.status.state === 'Run') this.#setJob('running');
        this.#maybeDone();
        return;
      case 'ok':
      case 'error': {
        if (this.#mdi > 0 && !this.#inflight.length) {
          this.#mdi--;
          return;
        }
        const done = this.#inflight.shift();
        if (!done) return;
        this.#used -= done.text.length + 1;
        this.#acked++;
        this.#ev.progress?.(this.#acked, this.#total, done.source);
        if (m.kind === 'error') {
          this.#queue = [];
          this.#setJob('failed', `error:${m.code} on line ${done.source + 1} (${done.text}): ${ERRORS[m.code] ?? 'see the grblHAL error codes'}`);
          return;
        }
        void this.#pump();
        this.#maybeDone();
        return;
      }
      case 'alarm':
        this.state = 'Alarm';
        if (this.busy) {
          this.#queue = [];
          this.#inflight = [];
          this.#used = 0;
          this.#setJob('failed', `ALARM:${m.code}: ${ALARMS[m.code] ?? 'see the grblHAL alarm codes'}`);
        }
        return;
      case 'welcome':
        // the controller restarted (reset, or it was just connected): nothing is in flight any more
        this.#inflight = [];
        this.#used = 0;
        this.#mdi = 0;
        if (this.busy) {
          this.#queue = [];
          this.#setJob('stopped', 'The controller reset.');
        }
        return;
      case 'other': {
        // $I answers [OPT:flags,planner blocks,rx buffer bytes]
        const opt = /^\[OPT:[^,]*,(\d+),(\d+)/.exec(m.text);
        if (opt) this.setRxBuffer(Number(opt[2]));
        return;
      }
      default:
        return;
    }
  }

  /** All lines acknowledged and the machine back at rest. */
  #maybeDone(): void {
    if (this.jobState !== 'running') return;
    if (this.#queue.length || this.#inflight.length) return;
    if (this.state === 'Idle' || this.state === 'Unknown') this.#setJob('done');
  }
}
