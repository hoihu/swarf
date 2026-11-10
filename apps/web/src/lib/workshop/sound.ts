/**
 * The machine's sound for the preview (off unless switched on): the spindle as a hum whose pitch
 * follows the speed, and cutting as hissing noise over it. Made with Web Audio, no samples.
 */
export class MachineSound {
  #ctx: AudioContext | null = null;
  #hum: GainNode | null = null;
  #cut: GainNode | null = null;
  #osc: OscillatorNode[] = [];
  #filter: BiquadFilterNode | null = null;

  /** Must be called from a click (browsers start audio only then). */
  start(): void {
    if (this.#ctx) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.#ctx = ctx;
    const out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(ctx.destination);
    // the spindle: two slightly detuned saws through a low-pass, and a sine an octave down
    const hum = ctx.createGain();
    hum.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.connect(hum).connect(out);
    for (const [type, detune, gain] of [['sawtooth', 0, 0.1], ['sawtooth', 9, 0.08], ['sine', -1200, 0.25]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(lp);
      o.start();
      this.#osc.push(o);
    }
    this.#hum = hum;
    // cutting: noise through a band-pass that follows the speed
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 0.9;
    const cut = ctx.createGain();
    cut.gain.value = 0;
    noise.connect(bp).connect(cut).connect(out);
    noise.start();
    this.#cut = cut;
    this.#filter = bp;
  }

  /** `rpm`: the spindle's speed (0: off); `cutting`: 0…1. */
  set(rpm: number, cutting: number): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#hum || !this.#cut) return;
    const t = ctx.currentTime;
    // a few teeth per turn, kept in a range one can bear
    const f = Math.min(420, Math.max(45, (rpm / 60) * 2));
    for (const o of this.#osc) o.frequency.setTargetAtTime(f, t, 0.15);
    this.#hum.gain.setTargetAtTime(rpm > 0 ? 0.16 : 0, t, rpm > 0 ? 0.25 : 0.5);
    this.#cut.gain.setTargetAtTime(rpm > 0 ? 0.22 * cutting : 0, t, 0.05);
    this.#filter?.frequency.setTargetAtTime(1200 + Math.min(4000, rpm * 0.5), t, 0.2);
  }

  stop(): void {
    void this.#ctx?.close();
    this.#ctx = null;
    this.#hum = this.#cut = null;
    this.#osc = [];
  }
}
