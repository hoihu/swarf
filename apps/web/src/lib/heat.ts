import type { MillMaterial } from '@swarf/cam';

/** The time of a place never cut (while the preview looked). */
export const NOT_CUT = -1e9;

/**
 * For the glow of fresh cuts: when each cell of the mill material was last cut down, as the
 * preview saw it (comparing the height map with the last look). The preview puts `at` in a
 * texture the part's shader reads per pixel, so the glow is where the cut is whatever the mesh's
 * triangles are. A material made anew (scrubbing, a changed job) starts with nothing glowing.
 */
export class Heat {
  /** Per cell (row-major, as MillMaterial.h): when it was last cut down, or NOT_CUT. */
  at: Float32Array | null = null;
  /** The latest time anything was cut. */
  until = NOT_CUT;
  #of: MillMaterial | null = null;
  #prev: Float32Array | null = null;

  /** Look at the material at time `now`: stamps the cells lowered since. True if any was. */
  note(m: MillMaterial, now: number): boolean {
    if (m !== this.#of || !this.#prev || !this.at || this.#prev.length !== m.h.length) {
      this.#of = m;
      this.#prev = m.h.slice();
      this.at = new Float32Array(m.h.length).fill(NOT_CUT);
      this.until = NOT_CUT;
      return true;
    }
    let any = false;
    for (let k = 0; k < m.h.length; k++) {
      const h = m.h[k]!;
      if (h < this.#prev[k]! - 0.005) {
        this.at[k] = now;
        any = true;
      }
      this.#prev[k] = h;
    }
    if (any) this.until = now;
    return any;
  }
}
