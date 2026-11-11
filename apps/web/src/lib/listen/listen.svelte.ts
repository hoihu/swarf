/**
 * The microphone on the cut: a spectrum ten times a second, judged by chatter.ts against the
 * spindle speed the controller reports and the teeth of the tool that is in.
 */
import { Ear, background, listen, stableSpeeds, type Heard, type Spectrum } from './chatter.ts';
import { machine } from '../machine.svelte.ts';
import { store } from '../store.svelte.ts';
import { tooling } from '../tooling.svelte.ts';

const KEY = 'swarf.listen';

class Listening {
  on = $state(false);
  error = $state('');
  /** What is heard now, steadied over a second or so. */
  state = $state<Heard['state']>('quiet');
  /** The ring's pitch while it chatters, Hz. */
  hz = $state<number | null>(null);
  /** The last ring heard (kept after it stops, with the speed it was heard at). */
  last = $state<{ hz: number; rpm: number; teeth: number; at: number } | null>(null);
  /** The spindle speed as heard from the teeth, rpm (null: not told). */
  heardRpm = $state<number | null>(null);
  /** Peaks of the machine running in air, left out. */
  air = $state<number[]>([]);
  /** The latest spectrum and judgment, for drawing (not reactive: read by the panel's own loop). */
  spectrum: Spectrum | null = null;
  heard: Heard | null = null;
  /** Teeth, when the user says so (null: from the tool that is in). */
  teethSet = $state<number | null>(null);

  #ctx: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #node: AnalyserNode | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ear = new Ear(12);
  #buf: Float32Array<ArrayBuffer> | null = null;

  constructor() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { air?: number[] };
      if (Array.isArray(v.air)) this.air = v.air.filter(Number.isFinite);
    } catch {
      // none
    }
  }

  /** Cutting edges of the tool that is in (the lathe: one). */
  get teeth(): number {
    if (this.teethSet) return this.teethSet;
    if (store.job.machine.kind === 'lathe') return 1;
    const t = store.job.tools.find((x) => x.id === tooling.active);
    return t?.flutes ?? (t?.type === 'drill' ? 2 : 2);
  }
  /** The spindle speed as the controller reports it (with its override), rpm. */
  get rpm(): number {
    return machine.status?.spindle ?? 0;
  }

  async start(): Promise<void> {
    this.error = '';
    try {
      // as the microphone hears it: no echo cancelling, noise suppression or level control (they eat steady tones)
      this.#stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      this.#ctx = new AudioContext();
      await this.#ctx.resume();
      const src = this.#ctx.createMediaStreamSource(this.#stream);
      this.#node = this.#ctx.createAnalyser();
      this.#node.fftSize = 8192;
      this.#node.smoothingTimeConstant = 0.5;
      src.connect(this.#node);
      this.#buf = new Float32Array(this.#node.frequencyBinCount);
      this.#ear.reset();
      this.on = true;
      this.#timer = setInterval(() => this.#tick(), 100);
    } catch (e) {
      this.stop();
      this.error = e instanceof DOMException && e.name === 'NotAllowedError' ? 'The browser was not allowed to use the microphone.' : `No microphone: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#stream?.getTracks().forEach((t) => t.stop());
    void this.#ctx?.close();
    this.#ctx = null;
    this.#stream = null;
    this.#node = null;
    this.on = false;
    this.state = 'quiet';
    this.hz = null;
    this.spectrum = null;
    this.heard = null;
  }

  #tick(): void {
    if (!this.#node || !this.#buf || !this.#ctx) return;
    this.#node.getFloatFrequencyData(this.#buf);
    const s: Spectrum = { db: this.#buf, binHz: this.#ctx.sampleRate / this.#node.fftSize };
    this.hearSpectrum(s);
  }

  /** Judge one spectrum (the microphone's, or a test's). */
  hearSpectrum(s: Spectrum): void {
    const rpm = this.rpm;
    const h = listen(s, rpm, this.teeth, { background: this.air });
    this.spectrum = s;
    this.heard = h;
    const v = this.#ear.hear(h);
    this.state = v.state;
    this.hz = v.hz;
    this.heardRpm = h.turning && h.teeth && rpm > 0 && Math.abs(h.turning * 60 - rpm) > rpm * 0.01 ? Math.round(h.turning * 60) : null;
    if (v.state === 'chatter' && v.hz) this.last = { hz: v.hz, rpm: Math.round(h.turning ? h.turning * 60 : rpm), teeth: this.teeth, at: Date.now() };
  }

  /** The spindle running, nothing cutting: what is heard now is the machine, not the cut. */
  learnAir(): void {
    if (!this.spectrum) return;
    this.air = background(this.spectrum);
    this.last = null;
    this.#ear.reset();
    try {
      localStorage.setItem(KEY, JSON.stringify({ air: this.air }));
    } catch {
      // not kept
    }
  }
  forgetAir(): void {
    this.air = [];
    try {
      localStorage.removeItem(KEY);
    } catch {
      // nothing to forget
    }
  }

  /** Speeds to try for the last ring heard: in step with it, within what the machine and the override can do. */
  get suggestions(): { rpm: number; percent: number }[] {
    const l = this.last;
    if (!l || l.rpm <= 0) return [];
    const m = store.job.machine;
    const ov = machine.status?.ov?.[2] ?? 100;
    // the programmed speed is what the override works on
    const programmed = l.rpm / (ov / 100);
    return stableSpeeds(l.hz, l.teeth, l.rpm, Math.max(m.minRpm, programmed * 0.5), Math.min(m.maxRpm, programmed * 1.5)).map((rpm) => ({ rpm, percent: Math.round((rpm / programmed) * 100) }));
  }

  /** Bring the spindle override to `percent` (in steps of 10 and 1, as the controller takes them). */
  async setOverride(percent: number): Promise<void> {
    let now = machine.status?.ov?.[2] ?? 100;
    const target = Math.max(10, Math.min(200, Math.round(percent)));
    for (let i = 0; i < 40 && now !== target; i++) {
      const d = target - now;
      const step = Math.abs(d) >= 10 ? 10 : 1;
      await machine.spindleOv(d > 0 ? (step === 10 ? 'spindlePlus10' : 'spindlePlus1') : step === 10 ? 'spindleMinus10' : 'spindleMinus1');
      now += Math.sign(d) * step;
    }
  }
}

export const listening = new Listening();
if (typeof window !== 'undefined') Object.assign(window, { __swarfListening: listening });
