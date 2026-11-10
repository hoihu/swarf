/**
 * Tool lengths: keeping the work zero right from one tool to the next.
 *
 * Two ways, both by moving the work zero (G10 L20) by how the new tool's tip sits against the old
 * one's; no tool length offset in the controller is used or needed.
 *
 * - Stored offsets (tools that come back to the same place: a quick-change tool post on the
 *   lathe, fixed holders on a mill): each tool's tip against a reference tool's, learned once by
 *   touching off, applied at every change.
 * - A tool setter on the mill (a switch on the table, wired to the probe input; for collets,
 *   where a tool sits differently every time): each tool is touched on it; the difference of two
 *   readings is the difference of their lengths.
 *
 * All positions here are as the controller counts them (X a diameter on a lathe in diameter
 * mode); stored offsets are physical (X a radius) and converted with `xScale`.
 */

export type V3 = [number, number, number];

/** A tool's tip against the reference tool's, in the machine's axes (mm; X a radius). */
export interface ToolOffset {
  x: number;
  z: number;
}

/**
 * The zero was right for a tool with offset `from`; the tool now in the machine has `to`. The
 * work position the controller should show instead of `wpos` (the machine has not moved: the
 * new tip is elsewhere). `xScale`: physical X per controller X (0.5 in diameter mode).
 */
export function shifted(wpos: V3, from: ToolOffset, to: ToolOffset, xScale: number): { x: number; z: number } {
  return { x: wpos[0] + (to.x - from.x) / xScale, z: wpos[2] + (to.z - from.z) };
}

/**
 * The new tool has been touched off by hand, so the zero is right for it now (work offset
 * `wcoNow`); it was right for the tool before, with offset `from`, when the work offset was
 * `wcoThen`. The new tool's offset.
 */
export function learned(from: ToolOffset, wcoThen: V3, wcoNow: V3, xScale: number): ToolOffset {
  // wpos = mpos − wco: the same place reads (wcoThen − wcoNow) more with the new tool
  return { x: from.x + (wcoThen[0] - wcoNow[0]) * xScale, z: from.z + (wcoThen[2] - wcoNow[2]) };
}

// ---- the tool setter ----

export interface Setter {
  /** Machine X/Y over the setter, and the machine Z to come down from (above it with the longest tool). */
  x: number;
  y: number;
  z: number;
  /** How far down to look for it at most. */
  depth: number;
}

export interface SetterPort {
  /** One line and the controller's answer. */
  request(line: string): Promise<{ ok: boolean; message?: string }>;
  /** Machine position and work offset as last reported. */
  mpos(): V3;
  wco(): V3;
  /** The last probing result (cleared before each probing move by `clearProbe`). */
  probe(): { mpos: V3; ok: boolean } | null;
  clearProbe(): void;
  /** Wait until the controller is idle again and has reported so. */
  settle(): Promise<void>;
}

const n3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);

/**
 * Touch the tool on the setter: up (guarded) to the setter's height, across, down fast until it
 * triggers, off, down again slowly; then back up. Returns the machine Z at the slow trigger.
 * Every move near the setter stops on contact.
 */
export async function measureOnSetter(s: Setter, port: SetterPort): Promise<number> {
  const run = async (line: string, what: string) => {
    const r = await port.request(line);
    if (!r.ok) {
      await port.request('G90');
      throw new Error(`${what}: ${r.message ?? 'the controller refused it'}`);
    }
    await port.settle();
  };
  const guarded = async (words: string, what: string) => {
    port.clearProbe();
    await run(`G90 G38.3 ${words} F1500`, what);
    if (port.probe()?.ok) throw new Error(`${what}: touched something on the way and stopped there.`);
  };
  const wco = port.wco();
  if (port.mpos()[2] > s.z + 1e-3) {
    // already above the setter's height: across first is no worse, but come down to it guarded afterwards
  } else await guarded(`Z${n3(s.z - wco[2])}`, 'Up to the setter\'s height');
  await guarded(`X${n3(s.x - wco[0])} Y${n3(s.y - wco[1])}`, 'Across to the setter');
  if (port.mpos()[2] > s.z + 1e-3) await guarded(`Z${n3(s.z - wco[2])}`, 'Down to the setter\'s height');
  // fast, to find it
  port.clearProbe();
  try {
    await run(`G91 G38.2 Z${n3(-s.depth)} F300`, 'Looking for the setter (is it wired to the probe input, and under the tool?)');
  } finally {
    await port.request('G90');
  }
  await run('G91 G0 Z1.5', 'Backing off');
  await port.request('G90');
  port.clearProbe();
  try {
    await run('G91 G38.2 Z-3 F30', 'The slow touch');
  } finally {
    await port.request('G90');
  }
  const hit = port.probe();
  if (!hit?.ok) throw new Error('The slow touch did not trigger.');
  await run(`G90 G0 Z${n3(s.z - port.wco()[2])}`, 'Back up');
  return hit.mpos[2];
}

/**
 * The work Z the controller should show after a tool change, from two readings on the setter:
 * the tool the zero was right for triggered at machine Z `then`, the new one at `now` (a longer
 * tool triggers higher up, and its tip is that much lower than the Z shown).
 */
export function zAfterChange(wposZ: number, then: number, now: number): number {
  return wposZ - (now - then);
}
