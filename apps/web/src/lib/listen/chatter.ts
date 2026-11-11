/**
 * Listening to the cut. A cutter that cuts cleanly makes sound at the rate its teeth meet the
 * work and at multiples of it (and of the spindle's turning). Chatter is something else: the tool
 * or the work ringing at a frequency of its own, which shows as a strong, narrow peak that is NOT
 * on one of those multiples. This finds such a peak in a spectrum from the microphone, and works
 * out the spindle speeds at which the teeth would fall in step with the ringing, where it usually
 * dies down (the pockets between the "stability lobes").
 *
 * All of it is rule of thumb on a noisy signal: it says "this sounds like chatter at 1.8 kHz, try
 * 5500 rpm", not more.
 */

export interface Spectrum {
  /** Level per bin, dB (any reference: only differences are used). */
  db: Float32Array | number[];
  /** Width of a bin, Hz (bin i is at i · binHz). */
  binHz: number;
}

export interface Peak {
  hz: number;
  db: number;
  /** dB above the spectrum's floor. */
  over: number;
}

export interface Heard {
  state: 'quiet' | 'cutting' | 'chatter';
  /** The spindle's turning rate as heard (Hz): the nominal one, corrected to where the teeth's multiples really lie. Null when it could not be told. */
  turning: number | null;
  /** The strongest peak on a multiple of the tooth rate. */
  teeth: Peak | null;
  /** The strongest peak that is on no multiple and not in the background. */
  stray: Peak | null;
  /** The floor, dB. */
  floor: number;
}

export interface ListenOptions {
  /** Hz: below this is the machine's rumble and mains hum. */
  low?: number;
  high?: number;
  /** dB over the floor for a peak to count at all. */
  peak?: number;
  /** dB over the floor for a stray peak to be called chatter. */
  loud?: number;
  /** Peaks to leave out: what the machine sounds like running in air (see `background`). */
  background?: number[];
}

const at = (s: Spectrum, i: number) => s.db[i] as number;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

/** Local maxima at least `min` dB over the floor, strongest first, with their place between bins. */
export function peaks(s: Spectrum, floor: number, min: number, low: number, high: number): Peak[] {
  const i0 = Math.max(2, Math.ceil(low / s.binHz));
  const i1 = Math.min(s.db.length - 3, Math.floor(high / s.binHz));
  const out: Peak[] = [];
  for (let i = i0; i <= i1; i++) {
    const v = at(s, i);
    if (v - floor < min) continue;
    if (v < at(s, i - 1) || v < at(s, i + 1) || v < at(s, i - 2) || v < at(s, i + 2)) continue;
    // parabola through the top three bins
    const a = at(s, i - 1);
    const c = at(s, i + 1);
    const den = a - 2 * v + c;
    const off = Math.abs(den) > 1e-9 ? (0.5 * (a - c)) / den : 0;
    out.push({ hz: (i + off) * s.binHz, db: v, over: v - floor });
  }
  return out.sort((p, q) => q.db - p.db);
}

/** How close (Hz) a frequency must be to a multiple to count as on it. */
const tolerance = (hz: number, binHz: number) => Math.max(2 * binHz, hz * 0.006);

/**
 * What the spectrum says, for a spindle turning at about `rpm` with `teeth` cutting edges (1 on
 * the lathe). The turning rate is first corrected within ±6 % to where the multiples of the tooth
 * rate really lie (few hobby spindles turn at what was asked).
 */
export function listen(s: Spectrum, rpm: number, teeth: number, o: ListenOptions = {}): Heard {
  const low = o.low ?? 150;
  const high = Math.min(o.high ?? 8000, (s.db.length - 3) * s.binHz);
  const i0 = Math.ceil(low / s.binHz);
  const i1 = Math.floor(high / s.binHz);
  const band: number[] = [];
  for (let i = i0; i <= i1; i++) band.push(at(s, i));
  const floor = median(band);
  const found = peaks(s, floor, o.peak ?? 12, low, high).slice(0, 24);
  const none: Heard = { state: 'quiet', turning: null, teeth: null, stray: null, floor };
  if (!found.length) return none;
  const bg = o.background ?? [];
  const known = (hz: number) => bg.some((b) => Math.abs(b - hz) <= tolerance(hz, s.binHz) * 1.5);

  // Only the first multiples of the tooth rate are the teeth's sound; higher up they lie so close
  // together (and move so far with a small change of speed) that anything would pass for one.
  const MULTIPLES = 8;
  const onTooth = (hz: number, tooth: number, upTo = MULTIPLES): { m: number; d: number; tol: number } | null => {
    const m = Math.round(hz / tooth);
    if (m < 1 || m > upTo) return null;
    return { m, d: Math.abs(hz - m * tooth), tol: Math.min(tolerance(hz, s.binHz), tooth * 0.12) };
  };

  // the turning rate that puts most of the sound on multiples of the tooth rate: looked for
  // within ±5 %, and believed only when at least two different multiples agree on it
  let turning: number | null = null;
  let heard = false;
  if (rpm > 0) {
    const nominal = rpm / 60;
    turning = nominal;
    let best = 0;
    heard = false;
    for (let k = -50; k <= 50; k++) {
      const f = nominal * (1 + k / 1000);
      let score = 0;
      const ms = new Set<number>();
      for (const p of found) {
        const t = onTooth(p.hz, f * teeth);
        if (!t || t.d > t.tol) continue;
        score += p.over * (1 - (0.5 * t.d) / t.tol);
        ms.add(t.m);
      }
      if (ms.size < 2) continue;
      // (ties go to the speed nearest the nominal one)
      if (score > best + 1e-9 || (score > 0 && Math.abs(score - best) <= 1e-9 && Math.abs(f - nominal) < Math.abs(turning - nominal))) {
        best = score;
        turning = f;
        heard = true;
      }
    }
  }

  let teethPeak: Peak | null = null;
  let stray: Peak | null = null;
  for (const p of found) {
    if (known(p.hz)) continue;
    let onMultiple = false;
    if (turning) {
      // (with the turning rate heard from the teeth themselves, the higher multiples can be told too)
      const t = onTooth(p.hz, turning * teeth, heard ? 40 : MULTIPLES);
      // multiples of the tooth rate; and the first ones of the turning itself (run-out)
      const k = Math.round(p.hz / turning);
      onMultiple = (!!t && t.d <= t.tol) || (k >= 1 && k <= MULTIPLES && Math.abs(p.hz - k * turning) <= Math.min(tolerance(p.hz, s.binHz), turning * 0.12));
    }
    if (onMultiple) teethPeak ??= p;
    else stray ??= p;
  }
  const loud = o.loud ?? 20;
  // chatter: a stray peak well out of the floor that the teeth's own sound does not drown
  const chatter = !!stray && stray.over >= loud && (!teethPeak || stray.db >= teethPeak.db - 6);
  return { state: chatter ? 'chatter' : teethPeak || stray ? 'cutting' : 'quiet', turning, teeth: teethPeak, stray, floor };
}

/** The peaks of the machine running in air (spindle, pump, drive whine): given to `listen` as `background`. */
export function background(s: Spectrum, o: ListenOptions = {}): number[] {
  const low = o.low ?? 150;
  const high = Math.min(o.high ?? 8000, (s.db.length - 3) * s.binHz);
  const band: number[] = [];
  for (let i = Math.ceil(low / s.binHz); i <= Math.floor(high / s.binHz); i++) band.push(at(s, i));
  return peaks(s, median(band), o.peak ?? 12, low, high).slice(0, 40).map((p) => p.hz);
}

/**
 * Spindle speeds at which the teeth fall in step with a ringing at `hz`: 60 · hz / (teeth · k)
 * for k = 1, 2, 3 …, those the machine can run, nearest to the speed now first. With none in
 * reach (a lathe, a slow spindle and a high ring) the list is empty: change the speed by a tenth
 * either way and listen again.
 */
export function stableSpeeds(hz: number, teeth: number, now: number, min: number, max: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= 60; k++) {
    const n = (60 * hz) / (teeth * k);
    if (n < min) break;
    // (a speed within 3 % of the one that chatters is that one)
    if (n <= max && Math.abs(n - now) > now * 0.03) out.push(Math.round(n / 10) * 10);
  }
  return out.sort((a, b) => Math.abs(a - now) - Math.abs(b - now)).slice(0, 3);
}

/** Steady judgment over time: chatter only when it is heard at about the same pitch for most of the last moments. */
export class Ear {
  #last: Heard[] = [];
  frames: number;
  constructor(frames = 12) {
    this.frames = frames;
  }

  reset(): void {
    this.#last = [];
  }

  hear(h: Heard): { state: Heard['state']; hz: number | null; over: number } {
    this.#last.push(h);
    if (this.#last.length > this.frames) this.#last.shift();
    const ch = this.#last.filter((x) => x.state === 'chatter' && x.stray);
    if (ch.length >= Math.max(3, this.frames * 0.6)) {
      const hz = median(ch.map((x) => x.stray!.hz));
      const same = ch.filter((x) => Math.abs(x.stray!.hz - hz) <= hz * 0.03);
      if (same.length >= Math.max(3, this.frames * 0.5)) return { state: 'chatter', hz, over: median(same.map((x) => x.stray!.over)) };
    }
    const cutting = this.#last.filter((x) => x.state !== 'quiet').length;
    return { state: cutting > this.#last.length / 2 ? 'cutting' : 'quiet', hz: null, over: 0 };
  }
}

/** The spectrum of a piece of sound (Hann window, power in dB), for tests and recorded sound. `n` a power of two. */
export function spectrumOf(samples: ArrayLike<number>, rate: number, n = 8192): Spectrum {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (samples[i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  // in-place radix-2 FFT
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
  const db = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) db[i] = 10 * Math.log10((re[i]! * re[i]! + im[i]! * im[i]!) / (n * n) + 1e-14);
  return { db, binHz: rate / n };
}
