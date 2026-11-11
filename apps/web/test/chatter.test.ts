import { describe, expect, it } from 'vitest';
import { Ear, background, listen, spectrumOf, stableSpeeds } from '../src/lib/listen/chatter.ts';

const RATE = 48000;

/** A second of sound: tones (Hz, amplitude) over noise. */
function sound(tones: [number, number][], noise = 0.01, seed = 5): Float32Array {
  const n = 16384;
  const out = new Float32Array(n);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    let v = noise * rnd();
    for (const [hz, a] of tones) v += a * Math.sin((2 * Math.PI * hz * i) / RATE + hz);
    out[i] = v;
  }
  return out;
}

/** A three-flute cutter at `rpm`: the tooth rate and its multiples, falling off, and a little run-out at the turning rate's. */
const cutting = (rpm: number, teeth = 3): [number, number][] => {
  const f = rpm / 60;
  const out: [number, number][] = [];
  for (let k = 1; k <= 10; k++) out.push([f * teeth * k, 0.2 / k]);
  for (const k of [1, 2, 4]) out.push([f * k, 0.03]);
  return out;
};

describe('listening to the cut', () => {
  it('silence is quiet', () => {
    expect(listen(spectrumOf(sound([]), RATE), 6000, 3).state).toBe('quiet');
  });

  it('a clean cut is the teeth and their multiples: no chatter', () => {
    const h = listen(spectrumOf(sound(cutting(6000)), RATE), 6000, 3);
    expect(h.state).toBe('cutting');
    expect(h.teeth!.hz).toBeCloseTo(300, 0);
    expect(h.stray).toBeNull();
  });

  it('a ring between the multiples is chatter, with its pitch', () => {
    const h = listen(spectrumOf(sound([...cutting(6000), [1840, 0.3]]), RATE), 6000, 3);
    expect(h.state).toBe('chatter');
    expect(Math.abs(h.stray!.hz - 1840)).toBeLessThan(3);
    // a faint one is not
    const faint = listen(spectrumOf(sound([...cutting(6000), [1840, 0.004]]), RATE), 6000, 3);
    expect(faint.state).toBe('cutting');
  });

  it('a spindle that turns 4 % slower than asked is not chatter: the multiples are found where they are', () => {
    const h = listen(spectrumOf(sound(cutting(5760)), RATE), 6000, 3);
    expect(h.state).toBe('cutting');
    expect(h.turning! * 60).toBeGreaterThan(5730);
    expect(h.turning! * 60).toBeLessThan(5790);
    // and a ring is still told from them
    expect(listen(spectrumOf(sound([...cutting(5760), [2210, 0.3]]), RATE), 6000, 3).state).toBe('chatter');
  });

  it('what the machine sounds like in air is left out', () => {
    const pump: [number, number][] = [[1270, 0.25], [3810, 0.1]];
    const air = background(spectrumOf(sound(pump), RATE));
    expect(air.some((hz) => Math.abs(hz - 1270) < 3)).toBe(true);
    const s = spectrumOf(sound([...cutting(6000), ...pump]), RATE);
    expect(listen(s, 6000, 3).state).toBe('chatter');
    expect(listen(s, 6000, 3, { background: air }).state).toBe('cutting');
  });

  it('on the lathe (one edge, a slow spindle) a ring is chatter too', () => {
    const turning: [number, number][] = [[15, 0.1], [30, 0.05], [45, 0.03]];
    const h = listen(spectrumOf(sound([...turning, [640, 0.3], [1280, 0.1]]), RATE), 900, 1);
    expect(h.state).toBe('chatter');
    expect(Math.abs(h.stray!.hz - 640)).toBeLessThan(3);
  });

  it('the speeds at which the teeth fall in step with the ring', () => {
    // 1840 Hz, three teeth: 36800 / k rpm
    expect(stableSpeeds(1840, 3, 6000, 500, 8000)).toEqual([5260, 7360, 4600]);
    // the speed that chatters is not offered again
    expect(stableSpeeds(1800, 3, 6000, 500, 8000)).not.toContain(6000);
    // a lathe at 900 rpm ringing at 640 Hz: 38400 / k, the nearest in reach
    expect(stableSpeeds(640, 1, 900, 100, 2000)).toEqual([870, 940, 850]);
    // nothing in reach: an empty list
    expect(stableSpeeds(300, 1, 500, 100, 600).every((n) => n >= 100 && n <= 600)).toBe(true);
    expect(stableSpeeds(1840, 3, 6000, 6500, 7000)).toEqual([]);
  });

  it('calls it chatter only when it lasts at one pitch', () => {
    const ear = new Ear(10);
    const clean = listen(spectrumOf(sound(cutting(6000)), RATE), 6000, 3);
    const ring = (hz: number, seed: number) => listen(spectrumOf(sound([...cutting(6000), [hz, 0.3]], 0.01, seed), RATE), 6000, 3);
    for (let i = 0; i < 10; i++) expect(ear.hear(clean).state).toBe('cutting');
    // a clank: two frames
    expect(ear.hear(ring(1840, 1)).state).toBe('cutting');
    expect(ear.hear(ring(1840, 2)).state).toBe('cutting');
    for (let i = 0; i < 8; i++) ear.hear(clean);
    // a ring that stays
    let last = ear.hear(clean);
    for (let i = 0; i < 8; i++) last = ear.hear(ring(1840 + i, i + 3));
    expect(last.state).toBe('chatter');
    expect(Math.abs(last.hz! - 1843)).toBeLessThan(6);
    // pitches all over the place: not one ring
    const ear2 = new Ear(10);
    let l2 = ear2.hear(clean);
    for (let i = 0; i < 10; i++) l2 = ear2.hear(ring(900 + i * 331, i + 20));
    expect(l2.state).toBe('cutting');
  });
});
