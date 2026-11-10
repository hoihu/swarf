/**
 * Moving the machine by hand: single steps, and jogging for as long as a button is held.
 *
 * Holding does not send one long move to be cancelled on release: if the cancel never arrived (a
 * pulled cable, a hung tab) the machine would run to the end of that move. It feeds short pieces,
 * a tenth of a second of travel each, and keeps only a quarter of a second queued; the controller
 * joins them into one smooth move. On release the jog is cancelled at once (grbl's jog cancel);
 * should that be lost, the machine stops by itself within what was queued.
 */

export interface JogPort {
  /** One line and the controller's answer to it. */
  request(line: string): Promise<{ ok: boolean; error?: number; message?: string }>;
  /** Stop the jog under way and drop the queued ones. */
  cancel(): unknown;
}

export type JogAxis = 'X' | 'Y' | 'Z';

/** Seconds of travel in each piece, and how much is kept queued. */
const PIECE = 0.1;
const AHEAD = 0.25;

const say = (r: { error?: number; message?: string }) => (r.error === 15 ? 'That would leave the machine\'s travel (soft limits).' : r.error === 9 || r.error === 8 ? 'The controller is not idle (alarm or hold): unlock or reset it first.' : (r.message ?? 'The controller refused the move.'));

export class Jogger {
  /** What the last move was refused for, in words. */
  error = '';
  #port: JogPort;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  /** The hold under way (one at a time). */
  #held: object | null = null;

  constructor(port: JogPort, now: () => number = () => performance.now(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.#port = port;
    this.#now = now;
    this.#sleep = sleep;
  }

  get holding(): boolean {
    return this.#held !== null;
  }

  /** One step of `dist` mm along an axis (relative), at `feed` mm/min. */
  async step(axis: JogAxis, dir: 1 | -1, dist: number, feed: number): Promise<boolean> {
    if (this.#held || !(dist > 0) || !(feed > 0)) return false;
    this.error = '';
    const r = await this.#port.request(`$J=G91 G21 ${axis}${(dir * dist).toFixed(3)} F${Math.round(feed)}`);
    if (!r.ok) this.error = say(r);
    return r.ok;
  }

  /** Jog along an axis until `release()`. */
  async hold(axis: JogAxis, dir: 1 | -1, feed: number): Promise<void> {
    if (this.#held || !(feed > 0)) return;
    const mine = {};
    this.#held = mine;
    this.error = '';
    const piece = Math.max(0.002, (feed / 60) * PIECE);
    const line = `$J=G91 G21 ${axis}${(dir * piece).toFixed(3)} F${Math.round(feed)}`;
    const t0 = this.#now();
    let sent = 0;
    while (this.#held === mine) {
      if (sent - (this.#now() - t0) / 1000 >= AHEAD) {
        await this.#sleep(15);
        continue;
      }
      // (nothing is awaited between the check above and this write: after a release nothing more goes out)
      const r = await this.#port.request(line);
      if (!r.ok) {
        if (this.#held === mine) {
          this.error = say(r);
          this.release();
        }
        return;
      }
      sent += PIECE;
    }
  }

  /** Let go: the jog stops now. Safe to call at any time. */
  release(): void {
    if (!this.#held) return;
    this.#held = null;
    void this.#port.cancel();
    // once more in a moment: a piece already on its way when the first cancel went out
    void this.#sleep(120).then(() => {
      if (!this.#held) void this.#port.cancel();
    });
  }
}
