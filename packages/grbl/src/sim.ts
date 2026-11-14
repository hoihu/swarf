/**
 * A simulated grblHAL controller as a Transport: it answers like the real one (ok, status reports
 * with MPos and WCO, $I with the receive buffer size), moves in real time at the programmed feed
 * (G0 at the rapid rate), jogs ($J=), holds and resumes, and pauses at M0. For trying the app
 * without a machine, and for the camera calibration, whose routine jogs the machine and watches it.
 *
 * Probing (G38.2–G38.5) stops where `contact` says the tool touches, reports [PRB:…] and answers
 * the line only then, as grbl does; no contact within the distance raises ALARM:5. M8/M9 switch
 * the flood output (A:F in the status), which the simulated camera reads as the line laser.
 *
 * Not modelled: acceleration, arcs as arcs (G2/G3 go straight to their end point), limits.
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
  /** G0. */
  rapid?: boolean;
  /** Done when the motion queued before it is over (the spindle switches in step with the moves). */
  then?: () => void;
  /** G38.2/.3: stop on contact; .4/.5: stop when contact is lost. `fail`: alarm when it never happens. */
  probe?: { towards: boolean; fail: boolean };
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
  /** Lines held back while a probing move runs (grbl parses nothing else meanwhile). */
  #held: string[] = [];
  #alarm = false;
  /** Flood (M8) and mist (M7) outputs. */
  flood = false;
  mist = false;
  /** Does the tool touch something at this machine position? (the probe input) */
  contact: (mpos: V3) => boolean = () => false;
  /** Spindle speed as commanded (0: off). */
  spindle = 0;
  #s = 0;
  /** Called as the machine moves (every step of every move), for whoever watches for collisions. */
  onStep: ((mpos: V3, move: { jog: boolean; probe: boolean; rapid: boolean }) => void) | null = null;

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
    if (this.#alarm) return 'Alarm';
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
    if (data.length === 1 && data.charCodeAt(0) >= 0x99 && data.charCodeAt(0) <= 0x9d) {
      // spindle speed override
      const c = data.charCodeAt(0);
      this.spindleOverride = c === 0x99 ? 100 : Math.max(10, Math.min(200, this.spindleOverride + (c === 0x9a ? 10 : c === 0x9b ? -10 : c === 0x9c ? 1 : -1)));
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 0x90 && data.charCodeAt(0) <= 0x94) {
      // feed override: 100 %, ±10 %, ±1 % (10 to 200 %); it acts on the move under way too
      const c = data.charCodeAt(0);
      this.feedOverride = c === 0x90 ? 100 : Math.max(10, Math.min(200, this.feedOverride + (c === 0x91 ? 10 : c === 0x92 ? -10 : c === 0x93 ? 1 : -1)));
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 0x95 && data.charCodeAt(0) <= 0x97) {
      // rapid override: 100, 50 or 25 %
      this.rapidOverride = [100, 50, 25][data.charCodeAt(0) - 0x95]!;
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 0x80) return; // other real-time commands: ignored
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
      this.spindleOverride = this.feedOverride = this.rapidOverride = 100;
      this.#queue = [];
      this.#held = [];
      this.#hold = this.#m0 = false;
      // a reset stops the spindle and the coolant, and goes back to the power-on modes
      this.spindle = 0;
      this.flood = this.mist = false;
      this.#absolute = true;
      return this.#emit('\r\nGrblHAL 1.1f [\'$\' or \'$HELP\' for help]\r\n');
    }
    for (const raw of data.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (this.#probing()) this.#held.push(line);
      else this.#answer(line);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
  }

  #answer(line: string): void {
    const r = this.#line(line);
    if (r !== null) this.#emit(`${r}\r\n`);
  }

  #probing(): boolean {
    const m = this.#queue[0];
    return !!m && m !== 'M0' && !!m.probe;
  }

  /** Spindle speed override, percent. */
  spindleOverride = 100;
  /** Feed override, percent (feed moves and probing; jogs are not overridden). */
  feedOverride = 100;
  /** Rapid override, percent: 100, 50 or 25. */
  rapidOverride = 100;

  /** How fast this move goes now, mm/min: its rate with the overrides in force. */
  #rate(m: Motion): number {
    if (m.jog) return m.f;
    return (m.f * (m.rapid ? this.rapidOverride : this.feedOverride)) / 100;
  }

  #report(): string {
    const x = (v: V3): string => [this.lathe ? v[0] * 2 : v[0], v[1], v[2]].map(fmt).join(',');
    const pins = this.contact(this.pos) ? '|Pn:P' : '';
    const acc = this.flood || this.mist ? `|A:${this.flood ? 'F' : ''}${this.mist ? 'M' : ''}` : '';
    return `<${this.state}|MPos:${x(this.pos)}|FS:${this.#moving()},${Math.round((this.spindle * this.spindleOverride) / 100)}|WCO:${x(this.wco)}|Ov:${this.feedOverride},${this.rapidOverride},${this.spindleOverride}${pins}${acc}>`;
  }

  /** One line: the reply ('ok', 'error:n' or the answer of a $ command); null while a probe runs (answered when it ends). */
  #line(line: string): string | null {
    if (line === '$X') {
      this.#alarm = false;
      return '[MSG:Caution: Unlocked]\r\nok';
    }
    if (this.#alarm && !line.startsWith('$')) return 'error:9';
    if (line === '$I') return '[VER:1.1f.20260101:simulated]\r\n[OPT:VNL,35,' + this.#rx + ']\r\nok';
    if (line === '$#') return `[G54:${[this.lathe ? this.wco[0] * 2 : this.wco[0], this.wco[1], this.wco[2]].map(fmt).join(',')}]\r\nok`;
    if (line.startsWith('$J=')) return this.#gcode(line.slice(3), true);
    if (line.startsWith('$')) return 'ok';
    return this.#gcode(line, false);
  }

  #gcode(text: string, jog: boolean): string | null {
    const code = text.replace(/\(.*?\)|;.*$/g, '').toUpperCase();
    const words = [...code.matchAll(/([A-Z])\s*(-?[\d.]+)/g)].map((m) => ({ l: m[1]!, v: Number(m[2]) }));
    let machineCoords = false;
    let absolute = this.#absolute;
    let motion: number | null = null;
    let g10 = false;
    let L = 0;
    const axes: Partial<Record<'X' | 'Y' | 'Z', number>> = {};
    let f: number | null = null;
    let m0 = false;
    let probe: Motion['probe'] | null = null;
    let spin: boolean | null = null;
    for (const w of words) {
      if (w.l === 'G' && Math.abs(w.v - Math.round(w.v)) > 1e-6) {
        if (Math.abs(w.v - 38.2) < 1e-6) probe = { towards: true, fail: true };
        else if (Math.abs(w.v - 38.3) < 1e-6) probe = { towards: true, fail: false };
        else if (Math.abs(w.v - 38.4) < 1e-6) probe = { towards: false, fail: true };
        else if (Math.abs(w.v - 38.5) < 1e-6) probe = { towards: false, fail: false };
        else return 'error:20';
      } else if (w.l === 'M' && w.v === 8) this.flood = true;
      else if (w.l === 'M' && w.v === 7) this.mist = true;
      else if (w.l === 'M' && w.v === 9) this.flood = this.mist = false;
      else if (w.l === 'S') this.#s = w.v;
      else if (w.l === 'M' && (w.v === 3 || w.v === 4)) spin = true;
      else if (w.l === 'M' && (w.v === 5 || w.v === 30 || w.v === 2)) spin = false;
      else if (w.l === 'G') {
        if (w.v === 53) machineCoords = true;
        else if (w.v === 90) absolute = true;
        else if (w.v === 91) absolute = false;
        else if ([0, 1, 2, 3, 33].includes(w.v)) motion = w.v;
        else if (w.v === 10) g10 = true;
      } else if (w.l === 'L') L = w.v;
      else if (w.l === 'X' || w.l === 'Y' || w.l === 'Z') axes[w.l] = w.l === 'X' && this.lathe ? w.v / 2 : w.v;
      else if (w.l === 'F') f = w.v;
      else if (w.l === 'M' && (w.v === 0 || w.v === 1)) m0 = true;
    }
    if (jog && spin !== null) return 'error:16';
    if (spin !== null) {
      // in step with the moves: when those queued before it are done
      const rpm = spin ? this.#s : 0;
      this.#queue.push({ to: this.#end(), f: 1, jog: false, then: () => (this.spindle = rpm) });
    }
    if (g10) {
      // G10 L2 P1: the work offset itself (machine coordinates); L20 P1: so that here reads the given values
      if (L !== 2 && L !== 20) return 'error:20';
      const end = this.#end();
      (['X', 'Y', 'Z'] as const).forEach((a, i) => {
        if (axes[a] !== undefined) this.wco[i] = L === 2 ? axes[a]! : end[i]! - axes[a]!;
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
    if (!Object.keys(axes).length) return probe ? 'error:26' : 'ok';
    if ((jog || probe) && f === null && !this.#feed) return 'error:22';
    if (jog && f === null) return 'error:22';
    const from = this.#end();
    const to = [...from] as V3;
    (['X', 'Y', 'Z'] as const).forEach((a, i) => {
      const v = axes[a];
      if (v === undefined) return;
      to[i] = !absolute ? from[i]! + v : machineCoords ? v : v + this.wco[i]!;
    });
    if (probe) {
      // already touching (or not, for .4/.5) before moving: an alarm for every variant, as grbl does
      if (this.contact(this.#end()) === probe.towards) {
        this.#alarm = true;
        return 'ALARM:4';
      }
      this.#queue.push({ to, f: f ?? this.#feed, jog: false, probe });
      return null;
    }
    const rapid = !jog && (motion ?? this.#motion) === 0;
    const speed = jog ? f! : rapid ? this.#rapid : this.#feed;
    this.#queue.push({ to, f: speed, jog, rapid });
    return 'ok';
  }

  #prb(ok: boolean): string {
    const p = this.pos;
    return `[PRB:${[this.lathe ? p[0] * 2 : p[0], p[1], p[2]].map(fmt).join(',')}:${ok ? 1 : 0}]`;
  }

  /** A probing move ended (touched, or reached its end): report, answer the line, go on with the held ones. */
  #probeDone(ok: boolean, fail: boolean): void {
    this.#queue.shift();
    if (ok || !fail) this.#emit(`${this.#prb(ok)}\r\nok\r\n`);
    else {
      this.#alarm = true;
      this.#queue = [];
      this.#held = [];
      this.#emit('ALARM:5\r\n');
      return;
    }
    const held = this.#held;
    this.#held = [];
    for (const line of held) {
      if (this.#probing()) this.#held.push(line);
      else this.#answer(line);
    }
  }

  /** The feed rate of the move under way as the report gives it (0 when nothing moves). */
  #moving(): number {
    const m = this.#queue[0];
    if (!m || m === 'M0' || this.#hold) return 0;
    return Math.round(this.#rate(m));
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
      const f = this.#rate(m);
      // no more than half a millimetre at a time where someone watches the way
      const step = this.onStep ? Math.min(f * dt, 0.5) : f * dt;
      if (this.onStep && !m.probe) {
        const go = Math.min(step, len);
        this.onStep(len > 1e-12 ? (this.pos.map((v, i) => v + (d[i]! * go) / len) as V3) : this.pos, { jog: m.jog, probe: false, rapid: !!m.rapid });
      }
      if (m.probe) {
        // move, and find where along this step the input changed (to a micrometre)
        const from = this.pos;
        const go = Math.min(step, len);
        const at = (t: number) => from.map((v, i) => v + (d[i]! * t) / Math.max(len, 1e-12)) as V3;
        const hit = (t: number) => this.contact(at(t)) === m.probe!.towards;
        if (hit(go)) {
          let lo = 0;
          let hi = go;
          while (hi - lo > 0.0005) {
            const mid = (lo + hi) / 2;
            if (hit(mid)) hi = mid;
            else lo = mid;
          }
          this.pos = at(hi);
          this.#probeDone(true, m.probe.fail);
          return;
        }
        this.pos = at(go);
        if (go >= len - 1e-12) {
          this.#probeDone(false, m.probe.fail);
          return;
        }
        dt = 0;
        continue;
      }
      if (step >= len) {
        this.pos = [...m.to] as V3;
        this.#queue.shift();
        m.then?.();
        dt -= len / f;
      } else {
        this.pos = this.pos.map((v, i) => v + (d[i]! * step) / len) as V3;
        dt -= step / f;
      }
    }
  }
}
