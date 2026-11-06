/**
 * Setting the work zero by touching (mill): the cutter is the probe, wired to the controller's probe
 * input; it touches either a touch plate of known thickness lying on the stock, or the stock itself
 * with a clip on it (conductive stock). Every touch is grbl's G38.2: towards the part until the
 * input closes, back off, again slowly; the second trigger counts. Moves near the work are guarded
 * (G38.3: stop if anything is touched on the way) rather than rapids.
 */
import type { V3 } from './camera/geometry.ts';
import { machine } from './machine.svelte.ts';
import { simWorld } from './simworld.ts';
import { store } from './store.svelte.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n3 = (v: number) => v.toFixed(3);

export interface SurfaceResult {
  points: { x: number; y: number; z: number }[];
  highest: number;
  lowest: number;
  mean: number;
  /** Plane fit z = a + bx·x + by·y: slope in mm per 100 mm, and the largest departure from it. */
  slopeX: number;
  slopeY: number;
  flatness: number;
}

export interface CornerResult {
  /** Front-left corner and top, work coordinates before the new zero was set. */
  corner: V3;
  /** The front edge against X, degrees (counter-clockwise positive). */
  angle: number;
}

class Probe {
  busy = $state(false);
  step = $state('');
  error = $state('');
  /** What the last routine found, in words. */
  result = $state('');
  surface = $state<SurfaceResult | null>(null);
  corner = $state<CornerResult | null>(null);
  #stop = false;

  /** The probe input is closed now (the plate or the stock touches the cutter). */
  get touching(): boolean {
    return machine.status?.pins?.includes('P') ?? false;
  }

  cancel(): void {
    this.#stop = true;
  }

  /** Work offset (machine coordinates of work zero), from the controller. */
  #wco(): V3 {
    const s = machine.status;
    if (!s?.mpos || !s.wpos) throw new Error('No position from the controller yet.');
    return [s.mpos[0] - s.wpos[0], s.mpos[1] - s.wpos[1], s.mpos[2] - s.wpos[2]];
  }

  #wpos(): V3 {
    const p = machine.status?.wpos;
    if (!p) throw new Error('No position from the controller yet.');
    return [...p] as V3;
  }

  async #do(line: string): Promise<void> {
    if (this.#stop) throw new Error('Stopped.');
    const r = await machine.request(line);
    if (!r.ok) throw new Error(r.alarm === 5 ? 'Nothing touched within the distance: is the plate (or the clip) connected, and the cutter above it?' : r.alarm === 4 ? 'The probe input was already closed before moving: check the plate and the clip.' : (r.message ?? `the controller refused "${line}"`));
  }

  /** Wait until the controller is idle again (the status follows the moves). */
  async #settle(): Promise<void> {
    await sleep(80);
    for (let i = 0; i < 600; i++) {
      if (machine.status?.state === 'Idle') return;
      if (machine.status?.state === 'Alarm') throw new Error('The controller is in alarm.');
      await sleep(50);
    }
    throw new Error('The machine did not stop moving.');
  }

  /** Guarded move to a work position: stops (and fails) if anything is touched on the way. */
  async #moveTo(p: Partial<{ x: number; y: number; z: number }>, f = 1200): Promise<void> {
    const words = (['x', 'y', 'z'] as const).filter((k) => p[k] !== undefined).map((k) => `${k.toUpperCase()}${n3(p[k]!)}`);
    if (!words.length) return;
    machine.probe = null;
    await this.#do(`G90 G38.3 ${words.join(' ')} F${f}`);
    await this.#settle();
    if ((machine.probe as { ok: boolean } | null)?.ok) throw new Error(`Touched something on the way to ${words.join(' ')}: stopped there.`);
  }

  /** Touch along one axis (+1 / −1) up to `dist` mm; returns the work coordinate where it triggered (slow second touch). */
  async #touch(axis: 'X' | 'Y' | 'Z', dir: 1 | -1, dist: number): Promise<number> {
    const i = axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
    const wco = this.#wco();
    machine.probe = null;
    try {
      await this.#do(`G91 G38.2 ${axis}${n3(dir * dist)} F150`);
    } finally {
      await machine.request('G90');
    }
    await this.#settle();
    // back off and touch again, slowly
    await this.#do(`G91 G0 ${axis}${n3(-dir * 1)}`);
    await machine.request('G90');
    await this.#settle();
    machine.probe = null;
    try {
      await this.#do(`G91 G38.2 ${axis}${n3(dir * 2)} F25`);
    } finally {
      await machine.request('G90');
    }
    await this.#settle();
    const hit = machine.probe as { mpos: V3; ok: boolean } | null;
    if (!hit?.ok) throw new Error('The second, slow touch did not trigger.');
    // back off again
    await this.#do(`G91 G0 ${axis}${n3(-dir * 1)}`);
    await machine.request('G90');
    await this.#settle();
    return hit.mpos[i]! - wco[i]!;
  }

  async #run<T>(name: string, f: () => Promise<T>): Promise<T | null> {
    if (this.busy) return null;
    this.error = '';
    this.result = '';
    this.#stop = false;
    if (!machine.connected) {
      this.error = 'Connect the machine first.';
      return null;
    }
    if (machine.status?.state !== 'Idle') {
      this.error = 'The machine must be idle.';
      return null;
    }
    if (store.job.stock.kind !== 'block') {
      this.error = 'Probing is for the mill.';
      return null;
    }
    if (this.touching) {
      this.error = 'The probe input is closed already: is the plate or the clip touching the cutter?';
      return null;
    }
    this.busy = true;
    this.step = name;
    try {
      return await f();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      this.busy = false;
      this.step = '';
    }
  }

  /**
   * Z zero by touching the top: on a touch plate of `thickness` (0: the stock itself, clip on it),
   * straight below the cutter, within `down` mm. Sets work Z so the stock top reads as the job's.
   */
  async zeroZ(thickness: number, toolDiameter: number, down = 30): Promise<void> {
    await this.#run('Touching the top', async () => {
      const stock = store.job.stock as Extract<typeof store.job.stock, { kind: 'block' }>;
      if (machine.simulated) {
        const w = this.#wpos();
        const wco = this.#wco();
        const o = simWorld.origin!;
        simWorld.toolDiameter = toolDiameter;
        // the simulated plate lies where the cutter is
        simWorld.plate = thickness > 0 ? { x: w[0] + wco[0] - o[0], y: w[1] + wco[1] - o[1], size: 40, thickness } : null;
      }
      const before = this.#wco();
      const z = await this.#touch('Z', -1, down);
      // the surface touched is the stock top plus the plate: work Z there becomes stock.top + thickness
      const shift = z - (stock.top + thickness);
      await this.#do(`G10 L2 P1 Z${n3(before[2] + shift)}`);
      await this.#settle();
      await this.#moveTo({ z: stock.top + thickness + 5 });
      if (machine.simulated) simWorld.plate = null;
      this.result = `Z zero set: the top was ${Math.abs(shift).toFixed(3)} mm ${shift < 0 ? 'lower' : 'higher'} than the old zero said.${thickness > 0 ? ' Take the plate away.' : ''}`;
    });
  }

  /**
   * The top's evenness: touched at `nx` × `ny` points (stock itself, clip on it), from the current
   * height (which must be above the top). Z zero is not changed: see setZ.
   */
  async checkSurface(toolDiameter: number, nx = 3, ny = 3, inset = 6): Promise<void> {
    await this.#run('Touching the top at several points', async () => {
      const stock = store.job.stock as Extract<typeof store.job.stock, { kind: 'block' }>;
      if (machine.simulated) {
        simWorld.toolDiameter = toolDiameter;
        simWorld.plate = null;
      }
      const safe = this.#wpos()[2];
      if (safe < stock.top + 2) throw new Error(`Start above the top (at least Z${stock.top + 2}).`);
      const pts: SurfaceResult['points'] = [];
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const x = inset + ((stock.x - 2 * inset) * (j % 2 ? nx - 1 - i : i)) / Math.max(1, nx - 1);
          const y = inset + ((stock.y - 2 * inset) * j) / Math.max(1, ny - 1);
          this.step = `Point ${pts.length + 1} of ${nx * ny}`;
          await this.#moveTo({ z: safe });
          await this.#moveTo({ x, y });
          await this.#moveTo({ z: stock.top + 2 });
          const z = await this.#touch('Z', -1, 6);
          pts.push({ x, y, z });
        }
      await this.#moveTo({ z: safe });
      this.surface = analyseSurface(pts);
      const s = this.surface;
      this.result = `Top from ${s.lowest.toFixed(3)} to ${s.highest.toFixed(3)} (spread ${(s.highest - s.lowest).toFixed(3)} mm); sloping ${s.slopeX.toFixed(3)} mm per 100 mm in X, ${s.slopeY.toFixed(3)} in Y; ${s.flatness.toFixed(3)} mm off flat.`;
    });
  }

  /** Make the top read as the job's stock top at its highest point (to face it) or on average. */
  async setZ(which: 'highest' | 'mean'): Promise<void> {
    const s = this.surface;
    if (!s) return;
    await this.#run('Setting Z zero', async () => {
      const stock = store.job.stock as Extract<typeof store.job.stock, { kind: 'block' }>;
      const shift = (which === 'highest' ? s.highest : s.mean) - stock.top;
      await this.#do(`G10 L2 P1 Z${n3(this.#wco()[2] + shift)}`);
      await this.#settle();
      this.surface = { ...s, points: s.points.map((p) => ({ ...p, z: p.z - shift })), highest: s.highest - shift, lowest: s.lowest - shift, mean: s.mean - shift };
      this.result = `Z zero moved ${shift >= 0 ? 'up' : 'down'} ${Math.abs(shift).toFixed(3)} mm: the ${which === 'highest' ? 'highest point' : 'average'} of the top is now Z${stock.top}.`;
    });
  }

  /**
   * The front-left corner (stock itself, clip on it): start with the cutter above the corner,
   * within a few millimetres, higher than the top. Touches the top, the left side once and the
   * front side twice (for its angle); sets X, Y and Z zero on the corner.
   */
  async findCorner(toolDiameter: number): Promise<void> {
    await this.#run('Finding the corner', async () => {
      const stock = store.job.stock as Extract<typeof store.job.stock, { kind: 'block' }>;
      if (machine.simulated) {
        simWorld.toolDiameter = toolDiameter;
        simWorld.plate = null;
      }
      const r = toolDiameter / 2;
      const [sx, sy, safe] = this.#wpos();
      if (safe < stock.top + 2) throw new Error(`Start above the top (at least Z${stock.top + 2}), over the front-left corner.`);
      // the top, a little inside the corner
      this.step = 'Touching the top';
      await this.#moveTo({ x: sx + 6, y: sy + 6 });
      const top = await this.#touch('Z', -1, safe - stock.top + 6);
      const depth = top - Math.min(3, stock.z / 3);
      const clear = r + 6;
      // the left side, once; the front side, twice
      const side = async (at: { x: number; y: number }, axis: 'X' | 'Y'): Promise<number> => {
        await this.#moveTo({ z: top + 3 });
        await this.#moveTo(at);
        await this.#moveTo({ z: depth });
        const v = await this.#touch(axis, 1, 12);
        await this.#moveTo({ z: top + 3 });
        return v + r;
      };
      this.step = 'Touching the left side';
      const yl = sy + 8;
      const xl = await side({ x: sx - clear, y: yl }, 'X');
      this.step = 'Touching the front side (1 of 2)';
      const x1 = sx + 8;
      const y1 = await side({ x: x1, y: sy - clear }, 'Y');
      this.step = 'Touching the front side (2 of 2)';
      const x2 = sx + Math.min(stock.x - 16, 50);
      const y2 = await side({ x: x2, y: sy - clear }, 'Y');
      // the front edge's direction; the left edge square to it, through the touched point
      const a = Math.atan2(y2 - y1, x2 - x1);
      const d: [number, number] = [Math.cos(a), Math.sin(a)];
      // corner = front line ∩ left line: p1 + t d = pl + s (−d_y, d_x)
      const p1: [number, number] = [x1, y1];
      const pl: [number, number] = [xl, yl];
      const nrm: [number, number] = [-d[1], d[0]];
      const den = d[0] * nrm[1] - d[1] * nrm[0];
      const t = ((pl[0] - p1[0]) * nrm[1] - (pl[1] - p1[1]) * nrm[0]) / den;
      const cx = p1[0] + t * d[0];
      const cy = p1[1] + t * d[1];
      // the touch on the left side was at yl, not at the corner: correct for the angle
      this.corner = { corner: [cx, cy, top], angle: (a * 180) / Math.PI };
      const wco = this.#wco();
      await this.#do(`G10 L2 P1 X${n3(wco[0] + cx)} Y${n3(wco[1] + cy)} Z${n3(wco[2] + top - stock.top)}`);
      await this.#settle();
      await this.#moveTo({ z: stock.top + 5 });
      await this.#moveTo({ x: 0, y: 0 });
      const ang = (a * 180) / Math.PI;
      this.result = `Work zero on the corner (it was ${(cx).toFixed(3)}, ${(cy).toFixed(3)}, ${(top - stock.top).toFixed(3)} off). The front edge is ${Math.abs(ang) < 0.05 ? 'square to X' : `turned ${ang.toFixed(2)}° against X: square the block, or the cuts will be turned against it by as much`}.`;
    });
  }
}

/** Highest, lowest, mean, and a plane through the points (least squares) with the largest departure from it. */
export function analyseSurface(points: SurfaceResult['points']): SurfaceResult {
  const n = points.length;
  const zs = points.map((p) => p.z);
  const mean = zs.reduce((s, z) => s + z, 0) / n;
  // z = a + b x + c y by normal equations (3 × 3)
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    syy += p.y * p.y;
    sxy += p.x * p.y;
    sz += p.z;
    sxz += p.x * p.z;
    syz += p.y * p.z;
  }
  const A = [n, sx, sy, sx, sxx, sxy, sy, sxy, syy];
  const B = [sz, sxz, syz];
  const det = (m: number[]) => m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  const D = det(A);
  let a = mean;
  let b = 0;
  let c = 0;
  if (Math.abs(D) > 1e-9) {
    const col = (i: number) => A.map((v, k) => (k % 3 === i ? B[Math.floor(k / 3)]! : v));
    a = det(col(0)) / D;
    b = det(col(1)) / D;
    c = det(col(2)) / D;
  }
  const flatness = Math.max(...points.map((p) => Math.abs(p.z - (a + b * p.x + c * p.y))));
  return { points, highest: Math.max(...zs), lowest: Math.min(...zs), mean, slopeX: b * 100, slopeY: c * 100, flatness };
}

export const probe = new Probe();
if (typeof window !== "undefined") (window as unknown as { __swarfProbe?: Probe }).__swarfProbe = probe;
