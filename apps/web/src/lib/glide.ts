import type { Vec3 } from '@swarf/cam';

/**
 * The tool marker of a connected machine, between its status reports (a few a second): instead
 * of jumping to each report it goes from where it is shown to the new one over the time the last
 * reports came apart, so it moves smoothly, a report behind. Times in milliseconds.
 */
export class Glide {
  #from: Vec3 | null = null;
  #to: Vec3 | null = null;
  #t0 = 0;
  #dur = 0;
  #last = -Infinity;

  /** A new reported position, at time `now`. */
  report(p: Vec3, now: number): void {
    const gap = now - this.#last;
    this.#from = this.#to ? this.at(now) : { ...p };
    this.#to = { ...p };
    this.#t0 = now;
    // as long as the reports come apart, within reason (the first one, or after a pause: briefly)
    this.#dur = Number.isFinite(gap) ? Math.max(40, Math.min(400, gap)) : 0;
    this.#last = now;
  }

  /** Where to show the marker at time `now`. */
  at(now: number): Vec3 {
    const to = this.#to ?? { x: 0, y: 0, z: 0 };
    const from = this.#from ?? to;
    const u = this.#dur > 0 ? Math.max(0, Math.min(1, (now - this.#t0) / this.#dur)) : 1;
    return { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u, z: from.z + (to.z - from.z) * u };
  }

  /** Still on its way to the last report. */
  moving(now: number): boolean {
    return this.#dur > 0 && now - this.#t0 < this.#dur;
  }

  /** Forget it (the machine is gone). */
  reset(): void {
    this.#from = this.#to = null;
    this.#last = -Infinity;
    this.#dur = 0;
  }
}
