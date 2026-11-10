/**
 * Streams a G-code program to grbl/grblHAL with the character-counting protocol: as many lines
 * as fit in the controller's receive buffer are in flight; each `ok` (or `error`) frees the
 * oldest. Real-time commands (status, hold, resume, reset, overrides) are single bytes that
 * bypass the buffer. Transport-agnostic: Web Serial in the app, a fake controller in tests.
 */
import { ALARMS, ERRORS, classify, type Incoming, type MachineState, type ProbeResult, type Status } from './status.ts';

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
  /** Stops a jog ($J=) at once, without a reset. */
  jogCancel: '\x85',
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

/** The controller's answer to one line. */
export interface Reply {
  ok: boolean;
  error?: number;
  alarm?: number;
  message?: string;
}

/**
 * `waiting`: the program reached a pause of its own (M0/M1: a tool change). Everything before it is
 * done and the controller is idle and free: jog, probe, set the zero; `resume()` goes on.
 */
export type JobState = 'idle' | 'running' | 'paused' | 'waiting' | 'done' | 'failed' | 'stopped';

/** A program pause the sender keeps to itself (a controller paused by M0 accepts no jog or zero setting). */
const PAUSE = /^M0*[01]$/i;

export interface StreamerEvents {
  status?: (s: Status) => void;
  /** Lines acknowledged so far, of the total. */
  progress?: (acked: number, total: number, sourceLine: number) => void;
  job?: (state: JobState, message?: string) => void;
  /** A probing cycle finished (G38.x). */
  probe?: (p: ProbeResult) => void;
  /**
   * The controller stopped answering status requests (true: cable, power, network), or answers
   * again (false). Nothing can be stopped from here while it is lost.
   */
  link?: (lost: boolean) => void;
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
  /** Who waits for the answer to each of those lines (null: nobody), oldest first. */
  #replies: (((r: Reply) => void) | null)[] = [];
  /** The last probing result. */
  lastProbe: ProbeResult | null = null;
  /** No status report for a while. */
  lost = false;
  #lastStatus = Date.now();
  /** A stop under way: motion is being held; the reset follows when it stands (or after a moment). */
  #stopping: ReturnType<typeof setTimeout> | null = null;
  /**
   * Idle status reports in a row since the last line was acknowledged. An `ok` only says a line was
   * taken in, not that its move is over; two idle reports after it say the machine is at rest.
   */
  #idle = 0;
  #polling = true;
  get #atRest(): boolean {
    return this.#polling ? this.#idle >= 2 : this.state === 'Idle' || this.state === 'Unknown';
  }

  constructor(t: Transport, ev: StreamerEvents = {}, opts: StreamerOptions = {}) {
    this.#t = t;
    this.#ev = ev;
    this.#rx = opts.rxBuffer ?? 127;
    t.onData((text) => this.#onData(text));
    this.#polling = opts.pollMs !== 0;
    if (opts.pollMs !== 0) {
      const every = opts.pollMs ?? 200;
      this.#poll = setInterval(() => {
        void this.#t.write(RT.status).catch(() => {});
        // ten polls unanswered: the link is gone
        if (!this.lost && Date.now() - this.#lastStatus > Math.max(2000, every * 10)) this.#linkLost('The controller does not answer any more');
      }, every);
    }
  }

  #linkLost(why: string): void {
    this.lost = true;
    this.#ev.link?.(true);
    for (const r of this.#replies.splice(0)) r?.({ ok: false, message: `${why}.` });
    this.#mdi = 0;
    if (this.busy || this.jobState === 'waiting') {
      this.#queue = [];
      this.#setJob('failed', `${why}: the connection is lost. The machine may still be running what it had been sent: use its emergency stop.`);
    }
  }

  /** Lines of a job are on their way or held: nothing else may be sent. (Not while `waiting`.) */
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
  /**
   * `skipLeadingPause`: a pause (M0) before the program's first move is passed over (the first tool
   * is loaded and whoever starts the program has said so).
   */
  async run(program: string, o: { skipLeadingPause?: boolean } = {}): Promise<void> {
    if (this.busy || this.jobState === 'waiting') throw new Error('A job is already running.');
    if (this.lost) throw new Error('The controller does not answer.');
    if (this.state === 'Alarm') throw new Error('The controller is in alarm: unlock ($X) or home first.');
    if (this.state !== 'Idle' && this.state !== 'Unknown' && this.state !== 'Check') throw new Error(`The controller must be idle to start a program (it is in ${this.state}).`);
    this.#queue = prepare(program);
    if (o.skipLeadingPause) {
      const p = this.#queue.findIndex((l) => PAUSE.test(l.text));
      if (p >= 0 && !this.#queue.slice(0, p).some((l) => /[XYZ]/i.test(l.text))) this.#queue.splice(p, 1);
    }
    this.#total = this.#queue.length;
    this.#acked = 0;
    this.#setJob('running');
    await this.#pump();
  }

  /** One line typed by hand (MDI), only while no job runs. */
  async send(line: string): Promise<void> {
    await this.#sendLine(line, null);
  }

  /**
   * One line, and the controller's answer to it: ok, an error, or an alarm raised before the
   * answer came (a failed probe: the controller raises an alarm instead of answering).
   */
  request(line: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      this.#sendLine(line, resolve).catch(reject);
    });
  }

  async #sendLine(line: string, reply: ((r: Reply) => void) | null): Promise<void> {
    if (this.busy) throw new Error('Not while a job runs.');
    const text = line.trim();
    if (!text) {
      reply?.({ ok: true });
      return;
    }
    this.#mdi++;
    this.#replies.push(reply);
    this.#ev.log?.('out', text);
    await this.#t.write(`${text}\n`);
  }

  async hold(): Promise<void> {
    await this.#t.write(RT.hold);
    if (this.jobState === 'running') this.#setJob('paused');
  }

  async resume(): Promise<void> {
    if (this.jobState === 'waiting') {
      // after a tool change: on with the program (its next lines say the modes and positions afresh)
      if (this.state !== 'Idle' && this.state !== 'Unknown' && this.state !== 'Check') throw new Error(`The controller must be idle to go on (it is in ${this.state}).`);
      this.#idle = 0;
      if (this.#mdi > 0) throw new Error('The controller is still answering the last command.');
      this.#setJob('running');
      await this.#pump();
      this.#maybeDone();
      return;
    }
    await this.#t.write(RT.resume);
    if (this.jobState === 'paused') this.#setJob('running');
  }

  /**
   * Stop: nothing more is sent, motion is held (it decelerates, so the position stays true), and
   * once it stands the controller is reset, which drops what it had buffered and stops the spindle.
   * If it does not come to a stand within a moment (a move that cannot be held), the reset comes
   * anyway. Not a substitute for the machine's emergency stop.
   */
  async stop(): Promise<void> {
    const was = this.jobState;
    this.#queue = [];
    this.#inflight = [];
    this.#used = 0;
    this.#mdi = 0;
    // before the reset: the controller's restart message must not report the job a second time
    if (was === 'running' || was === 'paused' || was === 'waiting') this.#setJob('stopped', 'Stopped: motion held, then the controller reset (spindle off).');
    await this.#haltThenReset();
  }

  /** `hold`: hold even if the last status said it stands (it may have started moving since). */
  async #haltThenReset(hold = false): Promise<void> {
    const moving = this.state === 'Run' || this.state === 'Jog' || (this.state === 'Hold' && this.last?.sub === 1);
    if (!moving && !hold) {
      await this.#reset();
      return;
    }
    if (this.#stopping) return;
    this.#stopping = setTimeout(() => void this.#reset().catch(() => {}), 1500);
    await this.#t.write(RT.hold);
  }

  async #reset(): Promise<void> {
    if (this.#stopping) clearTimeout(this.#stopping);
    this.#stopping = null;
    await this.#t.write(RT.reset);
  }

  async override(cmd: (typeof RT)['feed100' | 'feedPlus10' | 'feedMinus10' | 'jogCancel']): Promise<void> {
    await this.#t.write(cmd);
  }

  async close(): Promise<void> {
    if (this.#stopping) clearTimeout(this.#stopping);
    this.#stopping = null;
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
      // the program's own pause: not sent; wait there once everything before it is done
      if (PAUSE.test(next.text)) {
        this.#maybeWaiting();
        break;
      }
      const len = next.text.length + 1;
      if (this.#used + len > this.#rx && this.#inflight.length) break;
      this.#queue.shift();
      this.#inflight.push(next);
      this.#used += len;
      this.#ev.log?.('out', next.text);
      try {
        await this.#t.write(`${next.text}\n`);
      } catch (e) {
        this.#linkLost(`Sending failed (${e instanceof Error ? e.message : String(e)})`);
        return;
      }
    }
  }

  /** At the program's pause with nothing in flight and the machine at rest: hand over to the user. */
  #maybeWaiting(): void {
    if (this.jobState !== 'running' || this.#inflight.length || !PAUSE.test(this.#queue[0]?.text ?? '')) return;
    if (!this.#atRest) return;
    const at = this.#queue.shift()!;
    this.#acked++;
    this.#ev.progress?.(this.#acked, this.#total, at.source);
    this.#setJob('waiting');
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
        this.#lastStatus = Date.now();
        this.#idle = m.status.state === 'Idle' || m.status.state === 'Check' ? this.#idle + 1 : 0;
        if (this.lost) {
          this.lost = false;
          this.#ev.link?.(false);
        }
        this.#ev.status?.(m.status);
        // a stop under way: reset as soon as it stands
        if (this.#stopping && !(m.status.state === 'Run' || m.status.state === 'Jog' || (m.status.state === 'Hold' && m.status.sub === 1))) void this.#reset().catch(() => {});
        // M0 in the program pauses the controller: show it as paused, cycle start resumes
        if (this.jobState === 'running' && m.status.state === 'Hold') this.#setJob('paused');
        else if (this.jobState === 'paused' && m.status.state === 'Run') this.#setJob('running');
        this.#maybeWaiting();
        this.#maybeDone();
        return;
      case 'ok':
      case 'error': {
        if (this.#mdi > 0 && !this.#inflight.length) {
          this.#mdi--;
          this.#replies.shift()?.(m.kind === 'ok' ? { ok: true } : { ok: false, error: m.code, message: `error:${m.code}: ${ERRORS[m.code] ?? 'see the grblHAL error codes'}` });
          return;
        }
        const done = this.#inflight.shift();
        if (!done) return;
        this.#idle = 0;
        this.#used -= done.text.length + 1;
        this.#acked++;
        this.#ev.progress?.(this.#acked, this.#total, done.source);
        if (m.kind === 'error') {
          // the controller skipped this line and would go on with the ones after it, from the wrong
          // place: hold at once, then reset (drops what it has buffered, stops the spindle)
          this.#queue = [];
          this.#inflight = [];
          this.#used = 0;
          this.#setJob('failed', `error:${m.code} on line ${done.source + 1} (${done.text}): ${ERRORS[m.code] ?? 'see the grblHAL error codes'}. Motion held and the controller reset.`);
          void this.#haltThenReset(true).catch(() => {});
          return;
        }
        void this.#pump();
        this.#maybeDone();
        return;
      }
      case 'alarm':
        this.state = 'Alarm';
        // whoever waits for an answer gets the alarm (the controller may not answer the line after it)
        for (const r of this.#replies.splice(0)) r?.({ ok: false, alarm: m.code, message: `ALARM:${m.code}: ${ALARMS[m.code] ?? 'see the grblHAL alarm codes'}` });
        this.#mdi = 0;
        if (this.busy) {
          this.#queue = [];
          this.#inflight = [];
          this.#used = 0;
          this.#setJob('failed', `ALARM:${m.code}: ${ALARMS[m.code] ?? 'see the grblHAL alarm codes'}`);
        }
        return;
      case 'probe':
        this.lastProbe = m.probe;
        this.#ev.probe?.(m.probe);
        return;
      case 'welcome':
        // the controller restarted (reset, or it was just connected): nothing is in flight any more
        this.#inflight = [];
        this.#used = 0;
        this.#mdi = 0;
        for (const r of this.#replies.splice(0)) r?.({ ok: false, message: 'The controller reset.' });
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
    if (this.#atRest) this.#setJob('done');
  }
}
