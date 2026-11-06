/**
 * The camera: which one, its live picture, and its calibration (lens, then position in machine
 * coordinates), kept per camera in this browser. The view switch decides what the main area
 * shows: the 3D preview, the raw camera picture (while calibrating), or the toolpath drawn over
 * the camera picture.
 */
import { BOARD, TABLE_MARKER, TOOL_MARKER, calibrateLens, detectBoard, detectMarkers, loadCv, solvePose, type BoardView, type CV, type Marker } from './cv.ts';
import { pixelToRay, project, quadCenter, rodrigues, shiftPose, sub, mulMV, tipOffset, type Lens, type Pose, type V2, type V3 } from './geometry.ts';
import { SimCamera } from './sim.ts';
import { machine } from '../machine.svelte.ts';
import { store } from '../store.svelte.ts';

const KEY = 'swarf.camera';
export const SIM_SOURCE = 'sim';

export interface CameraCalib {
  lens?: Lens & { rms: number; views: number };
  /** Camera pose: Xc = R·X + t. `frame` machine: X in machine coordinates (needs the work offset live); work: in work coordinates. */
  pose?: Pose & { frame: 'machine' | 'work'; kind: 'lathe' | 'mill'; rms: number; points: number; method: 'machine' | 'marker'; tipPx?: number };
}

export type CameraView = 'scene' | 'camera' | 'overlay';

function loadAll(): Record<string, CameraCalib> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, CameraCalib>;
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lathe = () => store.job.machine.kind === 'lathe';
/** X as the controller writes and reports it ↔ the physical X (a radius on a lathe in diameter mode). */
const xScale = () => (lathe() && store.job.machine.xMode === 'diameter' ? 0.5 : 1);

class Camera {
  sources = $state<{ id: string; label: string }[]>([{ id: SIM_SOURCE, label: 'Simulated camera' }]);
  source = $state<string>(SIM_SOURCE);
  running = $state(false);
  status = $state('');
  error = $state('');
  view = $state<CameraView>('scene');
  calib = $state<CameraCalib>({});
  /** Lens calibration in progress: the views kept so far, the last detection to draw. */
  capturing = $state(false);
  views = $state<BoardView[]>([]);
  board = $state<BoardView | null>(null);
  markers = $state<Marker[]>([]);
  /** Pose routine: what it is doing, and whether it waits for a click on the tool tip. */
  busy = $state(false);
  progress = $state('');
  awaitingClick = $state(false);
  clicks = $state<V2[]>([]);
  width = $state(0);
  height = $state(0);

  readonly video: HTMLVideoElement | null = typeof document === 'undefined' ? null : Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
  /** A new picture since `n`? (The simulated camera counts them; a webcam always has one.) */
  newFrame(n: number): number {
    return this.#sim ? this.#sim.frameNo : n + 1;
  }
  /** Where the picture is: the webcam's video, or the simulated camera's canvas. */
  frame = $state.raw<HTMLVideoElement | HTMLCanvasElement | null>(null);
  #cv: CV | null = null;
  #sim: SimCamera | null = null;
  #stream: MediaStream | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #loop: ReturnType<typeof setInterval> | null = null;
  #click: ((p: V2) => void) | null = null;
  #stop = false;

  get ready(): boolean {
    return !!(this.calib.lens && this.calib.pose && this.calib.pose.kind === store.job.machine.kind);
  }

  async cv(): Promise<CV> {
    if (this.#cv) return this.#cv;
    this.status = 'Loading OpenCV (13 MB, once)…';
    this.#cv = await loadCv();
    (window as unknown as { __swarfCv?: unknown }).__swarfCv = { cv: this.#cv, detectMarkers, detectBoard };
    this.status = '';
    return this.#cv;
  }

  /** The cameras of this computer (labels only once the user has allowed one). */
  async listSources(): Promise<void> {
    const list = [{ id: SIM_SOURCE, label: 'Simulated camera' }];
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices();
      for (const d of devices ?? []) if (d.kind === 'videoinput') list.push({ id: d.deviceId, label: d.label || `Camera ${list.length}` });
    } catch {
      // no camera access
    }
    this.sources = list;
  }

  async start(source = this.source): Promise<void> {
    this.stop();
    this.error = '';
    this.source = source;
    try {
      if (source === SIM_SOURCE) {
        const cv = await this.cv();
        this.#sim = new SimCamera(cv, () => this.#simWorld());
        this.frame = this.#sim.canvas;
        this.width = this.#sim.width;
        this.height = this.#sim.height;
      } else {
        this.#stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: source ? { exact: source } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 } } });
        void this.listSources();
        const v = this.video!;
        v.srcObject = this.#stream;
        await v.play().catch(() => {});
        for (let i = 0; i < 50 && !v.videoWidth; i++) await sleep(50);
        this.frame = v;
        this.width = v.videoWidth;
        this.height = v.videoHeight;
      }
      this.calib = loadAll()[this.#key()] ?? {};
      this.running = true;
      if (this.view === 'scene') this.view = 'camera';
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.stop();
    }
  }

  stop(): void {
    this.#stopLoop();
    this.#stop = true;
    this.#sim?.dispose();
    this.#sim = null;
    for (const t of this.#stream?.getTracks() ?? []) t.stop();
    this.#stream = null;
    if (this.video) this.video.srcObject = null;
    this.frame = null;
    this.running = false;
    this.capturing = false;
    if (this.view !== 'scene') this.view = 'scene';
  }

  /** Calibrations are per camera and picture size. */
  #key(): string {
    return `${this.source}@${this.width}x${this.height}`;
  }

  #save(): void {
    const all = loadAll();
    all[this.#key()] = $state.snapshot(this.calib) as CameraCalib;
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      // not kept: the session still has it
    }
  }

  forget(what: 'lens' | 'pose'): void {
    const c = { ...this.calib };
    delete c.pose;
    if (what === 'lens') delete c.lens;
    this.calib = c;
    this.#save();
    if (this.view === 'overlay') this.view = 'camera';
  }

  /** The current picture. */
  grab(): ImageData | null {
    const v = this.frame;
    if (!v || !this.width) return null;
    this.#canvas ??= document.createElement('canvas');
    const c = this.#canvas;
    if (c.width !== this.width || c.height !== this.height) {
      c.width = this.width;
      c.height = this.height;
    }
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(v, 0, 0, this.width, this.height);
    return g.getImageData(0, 0, c.width, c.height);
  }

  /** The work offset now: machine coordinates of work zero (lathe x a radius), from the controller. */
  wco(): V3 | null {
    const s = machine.status;
    if (!s?.mpos || !s.wpos) return null;
    const k = xScale();
    return [(s.mpos[0] - s.wpos[0]) * k, s.mpos[1] - s.wpos[1], s.mpos[2] - s.wpos[2]];
  }

  /** The machine position now (lathe x a radius). */
  mpos(): V3 | null {
    const p = machine.status?.mpos;
    return p ? [p[0] * xScale(), p[1], p[2]] : null;
  }

  #simWorld() {
    return { job: store.job, mpos: this.mpos() ?? [0, 0, 0], wco: this.wco() ?? [0, 0, 0], board: this.capturing } as const;
  }

  // ---------- lens ----------

  /** Watch for the board; keep views that differ from the ones kept (position, size, tilt). */
  async startLens(): Promise<void> {
    const cv = await this.cv();
    this.views = [];
    this.capturing = true;
    this.view = 'camera';
    this.#stopLoop();
    this.#loop = setInterval(() => {
      const img = this.grab();
      if (!img) return;
      const b = detectBoard(cv, img);
      this.board = b;
      if (!b || b.img.length < 12) return;
      if (this.views.every((v) => differs(v, b, img.width))) this.views = [...this.views, b];
    }, 350);
  }

  stopLens(): void {
    this.#stopLoop();
    this.capturing = false;
    this.board = null;
  }

  async computeLens(): Promise<void> {
    const cv = await this.cv();
    this.stopLens();
    const fit = calibrateLens(cv, $state.snapshot(this.views) as BoardView[], this.width, this.height);
    this.calib = { lens: { width: this.width, height: this.height, fx: fit.fx, fy: fit.fy, cx: fit.cx, cy: fit.cy, dist: fit.dist, rms: fit.rms, views: this.views.length } };
    this.#save();
  }

  // ---------- pose ----------

  /** A click on the camera picture (image pixels), while the routine waits for one. */
  click(p: V2): void {
    this.#click?.(p);
  }

  cancel(): void {
    this.#stop = true;
    this.#click?.([NaN, NaN]);
  }

  /**
   * The machine moves the marker on the tool through a grid around where it is now, the camera
   * finds the marker at each point: that pins the camera's pose (for the marker). Then the user
   * clicks the tool tip at a few of the points, which gives the marker's offset from the tip.
   * span: half-width in X and Y and height in Z (mill); radial and axial travel (lathe).
   */
  async calibratePose(span: { x: number; y: number; z: number }): Promise<void> {
    const lens = this.calib.lens;
    if (!lens) throw new Error('Calibrate the lens first.');
    const cv = await this.cv();
    const start = this.mpos();
    if (!machine.connected || !start) throw new Error('Connect the machine first: it moves the marker.');
    if (machine.status?.state !== 'Idle') throw new Error('The machine must be idle.');
    this.#stop = false;
    this.busy = true;
    this.view = 'camera';
    this.clicks = [];
    try {
      const pts: V3[] = [];
      if (lathe()) {
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) pts.push([start[0] + (span.x * i) / 3, 0, start[2] + (span.z * (i % 2 ? 3 - j : j)) / 3]);
      } else {
        for (const dz of [0, span.z])
          for (const dy of [-span.y, 0, span.y]) for (const dx of [-span.x, 0, span.x]) pts.push([start[0] + dx, start[1] + dy, start[2] + dz]);
      }
      const obj: V3[] = [];
      const img: V2[] = [];
      for (const [i, p] of pts.entries()) {
        this.progress = `Moving the marker: point ${i + 1} of ${pts.length}`;
        await this.#moveTo(p);
        const seen = await this.#findMarker(cv, TOOL_MARKER);
        if (seen) {
          obj.push(p);
          img.push(seen);
        }
      }
      if (obj.length < 6) throw new Error(`The camera found the tool marker at only ${obj.length} of ${pts.length} points. Is it on the tool, facing the camera, and in the picture?`);
      const sol = solvePose(cv, obj, img, lens);
      const markerPose: Pose = { R: rodrigues(sol.rvec), t: sol.tvec };

      // the tip: clicked at the grid's far corners
      const corners: V3[] = lathe()
        ? [start, [start[0] + span.x, 0, start[2] + span.z], [start[0] + span.x, 0, start[2]], [start[0], 0, start[2] + span.z]]
        : [
            [start[0] - span.x, start[1] - span.y, start[2]],
            [start[0] + span.x, start[1] + span.y, start[2] + span.z],
            [start[0] + span.x, start[1] - span.y, start[2]],
            [start[0] - span.x, start[1] + span.y, start[2] + span.z],
          ];
      const clicks: { M: V3; px: V2 }[] = [];
      for (const [i, M] of corners.entries()) {
        this.progress = `Moving to click point ${i + 1} of ${corners.length}`;
        await this.#moveTo(M);
        this.progress = `Click the very tip of the tool in the picture (${i + 1} of ${corners.length})`;
        this.awaitingClick = true;
        const px = await new Promise<V2>((r) => (this.#click = r));
        this.awaitingClick = false;
        this.#click = null;
        if (this.#stop) throw new Error('Stopped.');
        this.clicks = [...this.clicks, px];
        clicks.push({ M, px });
      }
      const { m } = tipOffset(markerPose, clicks.map((c) => ({ M: c.M, ray: pixelToRay(lens, c.px[0], c.px[1]) })));
      const pose = shiftPose(markerPose, m);
      const tipPx = Math.sqrt(clicks.reduce((s, c) => {
        const q = project(lens, pose, c.M)!;
        return s + (q[0] - c.px[0]) ** 2 + (q[1] - c.px[1]) ** 2;
      }, 0) / clicks.length);
      this.progress = 'Back to the start';
      await this.#moveTo(start);
      this.calib = { ...this.calib, pose: { ...pose, frame: 'machine', kind: store.job.machine.kind, rms: sol.rms, points: obj.length, method: 'machine', tipPx } };
      this.#save();
      this.progress = '';
      this.view = 'overlay';
    } finally {
      this.busy = false;
      this.awaitingClick = false;
      this.#click = null;
    }
  }

  /**
   * Quick: the table marker lies on the stock top, centre at work (x, y), edges along X and Y,
   * its top edge towards +Y. `size`: its black square, measured.
   */
  async calibratePoseFromMarker(at: { x: number; y: number }, size: number): Promise<void> {
    const lens = this.calib.lens;
    if (!lens) throw new Error('Calibrate the lens first.');
    if (store.job.stock.kind !== 'block') throw new Error('The marker method is for the mill: lay the marker flat on the stock.');
    const cv = await this.cv();
    const seen: Marker[] = [];
    for (let i = 0; i < 5; i++) {
      const img = this.grab();
      const m = img ? detectMarkers(cv, img).find((x) => x.id === TABLE_MARKER) : undefined;
      if (m) seen.push(m);
      await sleep(80);
    }
    if (!seen.length) throw new Error(`The camera does not see the table marker (number ${TABLE_MARKER}).`);
    const c = [0, 1, 2, 3].map((k) => [seen.reduce((s, m) => s + m.corners[k]![0], 0) / seen.length, seen.reduce((s, m) => s + m.corners[k]![1], 0) / seen.length]) as V2[];
    const h = size / 2;
    // IPPE_SQUARE wants the corners in the marker's own frame, in this order
    const sol = solvePose(cv, [[-h, h, 0], [h, h, 0], [h, -h, 0], [-h, -h, 0]], c, lens, 'square');
    const R = rodrigues(sol.rvec);
    // marker frame → work: shifted to (x, y, top); → machine: plus the work offset
    const origin: V3 = [at.x, at.y, store.job.stock.top];
    let t = sub(sol.tvec, mulMV(R, origin));
    const wco = this.wco();
    if (wco) t = sub(t, mulMV(R, wco));
    this.calib = { ...this.calib, pose: { R, t, frame: wco ? 'machine' : 'work', kind: 'mill', rms: sol.rms, points: 4, method: 'marker' } };
    this.#save();
    this.view = 'overlay';
  }

  async #moveTo(p: V3): Promise<void> {
    if (this.#stop) throw new Error('Stopped.');
    const k = xScale();
    const words = lathe() ? `X${(p[0] / k).toFixed(3)} Z${p[2].toFixed(3)}` : `X${p[0].toFixed(3)} Y${p[1].toFixed(3)} Z${p[2].toFixed(3)}`;
    await machine.send(`$J=G53 G90 ${words} F2000`);
    const t0 = performance.now();
    for (;;) {
      if (this.#stop) {
        await machine.jogCancel();
        throw new Error('Stopped.');
      }
      const now = this.mpos();
      const st = machine.status?.state;
      if (now && st === 'Idle' && Math.hypot(now[0] - p[0], now[1] - p[1], now[2] - p[2]) < 0.01) break;
      if (st === 'Alarm') throw new Error('The machine went into alarm: check the travel limits and the grid size.');
      if (performance.now() - t0 > 60_000) throw new Error('The machine did not get there within a minute.');
      await sleep(60);
    }
    await sleep(350); // let it settle (and the picture catch up)
  }

  /** The marker's centre in the picture, averaged over a few frames. */
  async #findMarker(cv: CV, id: number): Promise<V2 | null> {
    const found: V2[] = [];
    for (let i = 0; i < 3; i++) {
      const img = this.grab();
      if (img) {
        const ms = detectMarkers(cv, img);
        this.markers = ms;
        const m = ms.find((x) => x.id === id);
        if (m) found.push(quadCenter(m.corners));
      }
      await sleep(70);
    }
    if (!found.length) return null;
    return [found.reduce((s, p) => s + p[0], 0) / found.length, found.reduce((s, p) => s + p[1], 0) / found.length];
  }

  #stopLoop(): void {
    if (this.#loop) clearInterval(this.#loop);
    this.#loop = null;
  }
}

/** A board view worth keeping next to an earlier one: elsewhere in the picture, nearer or farther, or tilted otherwise. */
function differs(a: BoardView, b: BoardView, width: number): boolean {
  const stats = (v: BoardView) => {
    const n = v.img.length;
    const cx = v.img.reduce((s, p) => s + p[0], 0) / n;
    const cy = v.img.reduce((s, p) => s + p[1], 0) / n;
    const sx = Math.sqrt(v.img.reduce((s, p) => s + (p[0] - cx) ** 2, 0) / n);
    const sy = Math.sqrt(v.img.reduce((s, p) => s + (p[1] - cy) ** 2, 0) / n);
    return { cx, cy, sx, sy };
  };
  const p = stats(a);
  const q = stats(b);
  const moved = Math.hypot(p.cx - q.cx, p.cy - q.cy) > width * 0.08;
  const scaled = Math.abs(Math.log((q.sx * q.sy) / (p.sx * p.sy))) > 0.3;
  const tilted = Math.abs(Math.log(q.sx / q.sy) - Math.log(p.sx / p.sy)) > 0.15;
  return moved || scaled || tilted;
}

export const camera = new Camera();
// for tests and the curious: the calibration and the live state
if (typeof window !== "undefined") (window as unknown as { __swarfCamera?: Camera }).__swarfCamera = camera;
export { BOARD, TABLE_MARKER, TOOL_MARKER };
