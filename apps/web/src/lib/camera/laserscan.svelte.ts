/**
 * The line laser in use (mill): calibrating its sheet over the probed top, and scanning the setup
 * into points, a description of the top and the obstacles beside the block. The laser is switched
 * with the flood coolant output (M8 on, M9 off), so each picture can be compared with one without
 * the line.
 */
import type { V2, V3 } from './geometry.ts';
import { analyseScan, calibratePlane, extractLine, triangulate, type Obstacle, type Rgba, type ScanResult } from './laser.ts';
import { camera } from './camera.svelte.ts';
import { machine } from '../machine.svelte.ts';
import { store } from '../store.svelte.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class LaserScan {
  busy = $state(false);
  step = $state('');
  error = $state('');
  result = $state<ScanResult | null>(null);
  /** The scanned points, work coordinates (for the 3D preview). */
  cloud = $state.raw<V3[] | null>(null);
  #stop = false;

  cancel(): void {
    this.#stop = true;
  }

  #block() {
    const s = store.job.stock;
    if (s.kind !== 'block') throw new Error('The laser scan is for the mill.');
    return s;
  }

  async #laser(on: boolean): Promise<void> {
    const r = await machine.request(on ? 'M8' : 'M9');
    if (!r.ok) throw new Error(r.message ?? 'The controller refused M8/M9.');
    // until the status shows it, and the camera has a new picture since
    for (let i = 0; i < 40 && !!machine.status?.acc?.includes('F') !== on; i++) await sleep(50);
    await this.#freshFrame();
  }

  /** A picture of the machine as it is now (the picture lags the machine: wait that out, then for a new one). */
  async #freshFrame(): Promise<Rgba> {
    await sleep(camera.lag + 30);
    const n0 = camera.newFrame(-1);
    for (let i = 0; i < 40 && camera.newFrame(-1) <= n0; i++) await sleep(20);
    const img = camera.grab();
    if (!img) throw new Error('No camera picture.');
    return img;
  }

  /** Jog to a machine position and wait until it is there and still. */
  async #moveTo(p: V3): Promise<void> {
    if (this.#stop) throw new Error('Stopped.');
    await machine.send(`$J=G53 G90 X${p[0].toFixed(3)} Y${p[1].toFixed(3)} Z${p[2].toFixed(3)} F2500`);
    for (let i = 0; i < 1200; i++) {
      const m = camera.mpos();
      if (m && machine.status?.state === 'Idle' && Math.hypot(m[0] - p[0], m[1] - p[1], m[2] - p[2]) < 0.01) return;
      if (machine.status?.state === 'Alarm') throw new Error('The machine went into alarm.');
      await sleep(40);
    }
    throw new Error('The machine did not get there.');
  }

  async #run(name: string, f: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.error = '';
    this.#stop = false;
    if (!camera.ready || !camera.calib.lens || !camera.calib.pose) {
      this.error = 'Calibrate the camera first (lens and position).';
      return;
    }
    if (!machine.connected || machine.status?.state !== 'Idle') {
      this.error = 'Connect the machine; it must be idle.';
      return;
    }
    this.busy = true;
    this.step = name;
    try {
      await f();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      await machine.request('M9').catch(() => {});
      this.busy = false;
      this.step = '';
    }
  }

  /**
   * The sheet's place on the spindle head: Z zero must be on the block's top (touch plate). The
   * cutter goes over the middle of the block and up through four heights; at each, the line on
   * the top (a known plane) gives points of the sheet.
   */
  async calibrate(): Promise<void> {
    await this.#run('Calibrating the laser', async () => {
      const s = this.#block();
      const lens = camera.calib.lens!;
      const pose = camera.calib.pose!;
      const wco = camera.wco();
      if (!wco) throw new Error('No work offset from the controller.');
      const zTop = wco[2] + s.top;
      const views: { p: V3; pixels: V2[] }[] = [];
      for (const [i, h] of [20, 28, 36, 44].entries()) {
        this.step = `Laser calibration: height ${i + 1} of 4`;
        const p: V3 = [wco[0] + s.x / 2, wco[1] + s.y / 2, zTop + h];
        await this.#moveTo(p);
        await this.#laser(false);
        const off = await this.#freshFrame();
        await this.#laser(true);
        const on = await this.#freshFrame();
        views.push({ p, pixels: extractLine(on, off) });
      }
      await this.#laser(false);
      const inset = 3;
      const fit = calibratePlane(lens, pose, zTop, views, (X) => {
        const x = X[0] - wco[0];
        const y = X[1] - wco[1];
        return x > inset && y > inset && x < s.x - inset && y < s.y - inset;
      });
      camera.setLaser({ n: fit.n, k: fit.k, rms: fit.rms, points: fit.points });
    });
  }

  /**
   * Sweep the line across the block and 35 mm around it, 1 mm at a time, at the current height
   * (which must clear everything): the points, the top's evenness, and what stands beside it.
   */
  async scan(margin = 35, step = 1): Promise<void> {
    await this.#run('Scanning', async () => {
      const s = this.#block();
      const lens = camera.calib.lens!;
      const pose = camera.calib.pose!;
      const plane = camera.calib.laser;
      if (!plane) throw new Error('Calibrate the laser first.');
      const wco = camera.wco();
      const start = camera.mpos();
      if (!wco || !start) throw new Error('No position from the controller.');
      if (start[2] - wco[2] < s.top + 15) throw new Error(`Start higher: at least Z${s.top + 15}, and above any clamp.`);
      // the line moves along the sheet's horizontal normal when the machine does
      const nh = Math.hypot(plane.n[0], plane.n[1]);
      if (nh < 0.2) throw new Error('The laser sheet is too steep to sweep: tilt it more.');
      const d: [number, number] = [plane.n[0] / nh, plane.n[1] / nh];
      // where the line falls on the top relative to the machine position, along d
      const zTop = wco[2] + s.top;
      const offset = (plane.k - plane.n[2] * (zTop - start[2])) / nh;
      // the region (work) along d, and the machine positions that put the line there
      const corners = [[-margin, -margin], [s.x + margin, -margin], [s.x + margin, s.y + margin], [-margin, s.y + margin]];
      const along = corners.map(([x, y]) => x! * d[0] + y! * d[1]);
      const from = Math.min(...along);
      const to = Math.max(...along);
      const centre: [number, number] = [s.x / 2, s.y / 2];
      const cAlong = centre[0] * d[0] + centre[1] * d[1];
      const points: V3[] = [];
      await this.#laser(false);
      const off = await this.#freshFrame();
      await this.#laser(true);
      const n = Math.ceil((to - from) / step);
      for (let i = 0; i <= n; i++) {
        this.step = `Scanning: ${i + 1} of ${n + 1}`;
        const sLine = from + i * step;
        // move the tool so the line is at sLine (from the block's centre along d)
        const t = sLine - offset - cAlong;
        const p: V3 = [wco[0] + centre[0] + d[0] * t, wco[1] + centre[1] + d[1] * t, start[2]];
        await this.#moveTo(p);
        const on = await this.#freshFrame();
        // nothing on the work is as high as the tool tip: points up there are the light on the spindle head
        for (const X of triangulate(lens, pose, plane, p, extractLine(on, off))) if (X[2] < p[2] - 3) points.push([X[0] - wco[0], X[1] - wco[1], X[2] - wco[2]]);
      }
      await this.#laser(false);
      await this.#moveTo(start);
      this.cloud = points;
      this.result = analyseScan(points, { x: s.x, y: s.y, top: s.top, bottom: s.top - s.z });
    });
  }

  /** The obstacles found, into the job (replacing earlier scanned ones), so the checks keep clear of them. */
  addObstacles(): void {
    const found = this.result?.obstacles ?? [];
    const keep = store.job.obstacles.filter((o) => !o.name.startsWith('scanned '));
    const add = found.map((o: Obstacle, i) => ({ name: `scanned ${i + 1}`, x0: round(o.x0), y0: round(o.y0), x1: round(o.x1), y1: round(o.y1), top: round(o.top) }));
    store.set({ ...store.job, obstacles: [...keep, ...add] });
  }

  clear(): void {
    this.cloud = null;
    this.result = null;
  }
}

const round = (v: number) => Math.round(v * 10) / 10;

export const laserScan = new LaserScan();
// for tests: the pieces, to look at a single frame
if (typeof window !== 'undefined') (window as unknown as { __swarfLaserLib?: unknown }).__swarfLaserLib = { extractLine, triangulate };
if (typeof window !== 'undefined') (window as unknown as { __swarfLaser?: LaserScan }).__swarfLaser = laserScan;
