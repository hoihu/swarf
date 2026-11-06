/**
 * A simulated grblHAL controller as a Transport: it answers like the real one (ok, status reports
 * with MPos and WCO, $I with the receive buffer size), moves in real time at the programmed feed
 * (G0 at the rapid rate), jogs ($J=), holds and resumes, and pauses at M0. For trying the app
 * without a machine, and for the camera calibration, whose routine jogs the machine and watches it.
 *
 * Not modelled: acceleration, arcs as arcs (G2/G3 go straight to their end point), alarms, limits.
 * Lathe mode: X in reports and words is a diameter (G7), as swarf assumes grblHAL reports it.
 */
import type { Transport } from './streamer.ts';

export interface SimOptions {
  lathe?: boolean;
  /** Work offset (G54), machine coordinates; X a radius on the lathe. */
  wco?: [number, number, number];
  /** Where the machine starts, machine coordinates. */
  mpos?: [number, number, number];
  rapid?: number;
  /** Speed-up factor for tests (1 = real time). */
  speed?: number;
  rxBuffer?: number;
}

type V3 = [number, number, number];
interface Motion {
  to: V3;
  /** mm/min */
  f: number;
  jog: boolean;
}

const fmt = (n: number) => n.toFixed(3);

export class SimGrbl implements Transport {
  readonly lathe: boolean;
  /** Machine position; X is a radius on the lathe. */
  pos: V3;
  wco: V3;
  #cb: (t: string) => void = () => {};
  #queue: (Motion | 'M0')[] = [];
  #hold = false;
  #m0 = false;
  #absolute = true;
  #motion = 0;
  #feed = 600;
  #rapid: number;
  #speed: number;
  #rx: number;
  #timer: ReturnType<typeof setInterval>;
  #last = Date.now();
  #closed = false;

  constructor(o: SimOptions = {}) {
    this.lathe = o.lathe ?? false;
    this.pos = [...(o.mpos ?? [0, 0, 0])] as V3;
    this.wco = [...(o.wco ?? [0, 0, 0])] as V3;
    this.#rapid = o.rapid ?? 3000;
    this.#speed = o.speed ?? 1;
    this.#rx = o.rxBuffer ?? 1024;
    this.#timer = setInterval(() => this.#tick(), 10);
    setTimeout(() => this.#emit('\r\nGrblHAL 1.1f [\'$\' or \'$HELP\' for help]\r\n'), 0);
  }

  get label(): string {
    return `Simulated ${this.lathe ? 'lathe' : 'mill'}`;
  }

  get state(): string {
    if (this.#hold || this.#m0) return 'Hold:0';
    const head = this.#queue[0];
    if (!head) return 'Idle';
    return head !== 'M0' && head.jog ? 'Jog' : 'Run';
  }

  onData(cb: (t: string) => void): void {
    this.#cb = cb;
  }

  #emit(t: string): void {
    if (!this.#closed) this.#cb(t);
  }

  async write(data: string): Promise<void> {
    if (data === '\x85') {
      // jog cancel: drop the jogs, stop where it is
      this.#queue = this.#queue.filter((m) => m === 'M0' || !m.jog);
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 0x80) return; // overrides: ignored
    if (data === '?') return this.#emit(`${this.#report()}\r\n`);
    if (data === '!') {
      this.#hold = true;
      return;
    }
    if (data === '~') {
      this.#hold = false;
      if (this.#m0) {
        this.#m0 = false;
        if (this.#queue[0] === 'M0') this.#queue.shift();
      }
      return;
    }
    if (data === '\x18') {
      this.#queue = [];
      this.#hold = this.#m0 = false;
      return this.#emit('\r\nGrblHAL 1.1f [\'$\' or \'$HELP\' for help]\r\n');
    }
    for (const raw of data.split('\n')) {
      const line = raw.trim();
      if (line) this.#emit(`${this.#line(line)}\r\n`);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
  }

  #report(): string {
    const x = (v: V3): string => [this.lathe ? v[0] * 2 : v[0], v[1], v[2]].map(fmt).join(',');
    return `<${this.state}|MPos:${x(this.pos)}|FS:${this.#queue.length ? this.#feed : 0},0|WCO:${x(this.wco)}>`;
  }

  /** One line: the reply ('ok', 'error:n' or the answer of a $ command). */
  #line(line: string): string {
    if (line === '$I') return '[VER:1.1f.20260101:simulated]\r\n[OPT:VNL,35,' + this.#rx + ']\r\nok';
    if (line === '$#') return `[G54:${[this.lathe ? this.wco[0] * 2 : this.wco[0], this.wco[1], this.wco[2]].map(fmt).join(',')}]\r\nok`;
    if (line.startsWith('$J=')) return this.#gcode(line.slice(3), true);
    if (line.startsWith('$')) return 'ok';
    return this.#gcode(line, false);
  }

  #gcode(text: string, jog: boolean): string {
    const code = text.replace(/\(.*?\)|;.*$/g, '').toUpperCase();
    const words = [...code.matchAll(/([A-Z])\s*(-?[\d.]+)/g)].map((m) => ({ l: m[1]!, v: Number(m[2]) }));
    let machineCoords = false;
    let absolute = this.#absolute;
    let motion: number | null = null;
    let l20 = false;
    const axes: Partial<Record<'X' | 'Y' | 'Z', number>> = {};
    let f: number | null = null;
    let m0 = false;
    for (const w of words) {
      if (w.l === 'G') {
        if (w.v === 53) machineCoords = true;
        else if (w.v === 90) absolute = true;
        else if (w.v === 91) absolute = false;
        else if ([0, 1, 2, 3, 33].includes(w.v)) motion = w.v;
        else if (w.v === 10) l20 = true;
      } else if (w.l === 'L' && w.v !== 20) l20 = false;
      else if (w.l === 'X' || w.l === 'Y' || w.l === 'Z') axes[w.l] = w.l === 'X' && this.lathe ? w.v / 2 : w.v;
      else if (w.l === 'F') f = w.v;
      else if (w.l === 'M' && (w.v === 0 || w.v === 1)) m0 = true;
    }
    if (l20) {
      // G10 L20 P1: set the work offset so the current position reads the given values
      const end = this.#end();
      (['X', 'Y', 'Z'] as const).forEach((a, i) => {
        if (axes[a] !== undefined) this.wco[i] = end[i]! - axes[a]!;
      });
      return 'ok';
    }
    if (!jog) {
      this.#absolute = absolute;
      if (motion !== null && motion !== 33) this.#motion = motion;
    }
    if (f !== null && !jog) this.#feed = f;
    if (m0) {
      this.#queue.push('M0');
      return 'ok';
    }
    if (!Object.keys(axes).length) return 'ok';
    if (jog && f === null) return 'error:22';
    const from = this.#end();
    const to = [...from] as V3;
    (['X', 'Y', 'Z'] as const).forEach((a, i) => {
      const v = axes[a];
      if (v === undefined) return;
      to[i] = !absolute ? from[i]! + v : machineCoords ? v : v + this.wco[i]!;
    });
    const speed = jog ? f! : (motion ?? this.#motion) === 0 ? this.#rapid : this.#feed;
    this.#queue.push({ to, f: speed, jog });
    return 'ok';
  }

  /** Where the queued motion ends (machine coordinates). */
  #end(): V3 {
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const m = this.#queue[i]!;
      if (m !== 'M0') return [...m.to] as V3;
    }
    return [...this.pos] as V3;
  }

  #tick(): void {
    const now = Date.now();
    let dt = ((now - this.#last) / 60000) * this.#speed; // minutes
    this.#last = now;
    if (this.#hold) return;
    while (dt > 0 && this.#queue.length) {
      const m = this.#queue[0]!;
      if (m === 'M0') {
        this.#m0 = true;
        return;
      }
      const d = m.to.map((v, i) => v - this.pos[i]!) as V3;
      const len = Math.hypot(...d);
      const step = m.f * dt;
      if (step >= len) {
        this.pos = [...m.to] as V3;
        this.#queue.shift();
        dt -= len / m.f;
      } else {
        this.pos = this.pos.map((v, i) => v + (d[i]! * step) / len) as V3;
        dt = 0;
      }
    }
  }
}
