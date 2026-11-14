/**
 * A record of what went over the wire, for finding out afterwards what happened on a real
 * machine: every line sent and received with its time, real-time bytes by name, and what the app
 * itself did in between (a program started, a stop, a lost link). Status polls are left out, and
 * of the status reports only those that say something new are kept.
 *
 * Kept in memory while the page is open (the last 40 000 entries); saved as a text file on
 * request, with the controller's settings and the job at the end.
 */
import type { Transport } from '@swarf/grbl';

export interface Entry {
  /** Milliseconds since the record began. */
  t: number;
  /** tx: sent; rx: received; ev: something the app did or noticed. */
  k: 'tx' | 'rx' | 'ev';
  s: string;
  /** For a status report: how many identical ones followed it. */
  n?: number;
}

const REALTIME: Record<number, string> = {
  0x18: 'reset',
  0x21: 'feed hold',
  0x7e: 'cycle start',
  0x84: 'safety door',
  0x85: 'jog cancel',
  0x90: 'feed 100%',
  0x91: 'feed +10%',
  0x92: 'feed -10%',
  0x93: 'feed +1%',
  0x94: 'feed -1%',
  0x95: 'rapid 100%',
  0x96: 'rapid 50%',
  0x97: 'rapid 25%',
  0x99: 'spindle 100%',
  0x9a: 'spindle +10%',
  0x9b: 'spindle -10%',
  0x9c: 'spindle +1%',
  0x9d: 'spindle -1%',
};

export class Recorder {
  entries: Entry[] = [];
  max = 40000;
  /** Entries dropped from the front since the start. */
  dropped = 0;
  #t0: number;
  #now: () => number;
  #partial = '';
  #lastStatus: Entry | null = null;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#t0 = now();
  }

  #add(k: Entry['k'], s: string): Entry {
    const e: Entry = { t: Math.round(this.#now() - this.#t0), k, s };
    this.entries.push(e);
    if (this.entries.length > this.max) {
      const cut = this.entries.length - this.max;
      this.entries.splice(0, cut);
      this.dropped += cut;
    }
    return e;
  }

  ev(text: string): void {
    this.#lastStatus = null;
    this.#add('ev', text);
  }

  /** Something written to the controller. */
  tx(data: string): void {
    // a single byte: a real-time command (the status poll is not worth a line)
    if (data.length === 1) {
      if (data === '?') return;
      const c = data.charCodeAt(0);
      this.#lastStatus = null;
      this.#add('tx', `[${REALTIME[c] ?? `0x${c.toString(16)}`}]`);
      return;
    }
    this.#lastStatus = null;
    for (const line of data.split(/\r?\n/)) if (line) this.#add('tx', line);
  }

  /** Text as it arrives from the controller, in whatever pieces. */
  rx(chunk: string): void {
    const lines = (this.#partial + chunk).split(/\r?\n/);
    this.#partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('<')) {
        // the same report again: count it
        if (this.#lastStatus && this.#lastStatus.s === line) {
          this.#lastStatus.n = (this.#lastStatus.n ?? 0) + 1;
          continue;
        }
        this.#lastStatus = this.#add('rx', line);
      } else {
        this.#lastStatus = null;
        this.#add('rx', line);
      }
    }
  }

  /** The record as text: one entry a line, `seconds  direction  text`. */
  text(head: string[] = [], tail: string[] = []): string {
    const out = [...head];
    if (this.dropped) out.push(`(${this.dropped} earlier entries are no longer kept)`);
    out.push('');
    for (const e of this.entries) {
      const t = (e.t / 1000).toFixed(3).padStart(10);
      out.push(`${t}  ${e.k === 'tx' ? '>' : e.k === 'rx' ? '<' : '#'} ${e.s}${e.n ? `   (and ${e.n} more the same)` : ''}`);
    }
    if (tail.length) out.push('', ...tail);
    return out.join('\n') + '\n';
  }
}

/** The transport, with everything that passes written down. */
export function recorded<T extends Transport>(t: T, rec: Recorder): T {
  const write = t.write.bind(t);
  const onData = t.onData.bind(t);
  t.write = async (data: string) => {
    rec.tx(data);
    return write(data);
  };
  t.onData = (cb: (text: string) => void) =>
    onData((text) => {
      rec.rx(text);
      cb(text);
    });
  return t;
}
