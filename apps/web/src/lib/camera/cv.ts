/**
 * OpenCV (opencv.js, about 13 MB) loaded on first use, only for the camera: ChArUco and ArUco
 * detection, lens calibration and the camera pose. Everything else in camera/ is plain math.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

let loading: Promise<CV> | null = null;

/**
 * Loaded as a plain script, not through the bundler: the package's CommonJS export is a Promise,
 * and Vite's interop wraps it in an object that only looks like one (awaiting it throws).
 */
export function loadCv(): Promise<CV> {
  loading ??= (async () => {
    const url = (await import('@techstark/opencv-js/dist/opencv.js?url')).default as string;
    const g = window as unknown as { cv?: CV };
    if (!g.cv) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('OpenCV did not load'));
        document.head.appendChild(s);
      });
    }
    // the script leaves a Promise of the module in window.cv (or the module once it is ready)
    let m = g.cv;
    if (m instanceof Promise) m = await m;
    if (!m.Mat) await new Promise<void>((resolve) => (m.onRuntimeInitialized = () => resolve()));
    // never hand out something with a `then`: an await would try to unwrap it again
    return { cv: m } as { cv: CV };
  })().then((box) => (box as { cv: CV }).cv) as Promise<CV>;
  return loading;
}

/** What is printed: the board for the lens, markers for the tool and the table. */
export const BOARD = { nx: 7, ny: 5, square: 35, marker: 26 } as const;
export const TOOL_MARKER = 40;
export const TABLE_MARKER = 41;

type P2 = [number, number];
type P3 = [number, number, number];

export interface BoardView {
  /** Corner pixels and their positions on the board (mm, z = 0). */
  img: P2[];
  obj: P3[];
  /** Marker outlines found, for drawing. */
  markers: P2[][];
}

export interface Marker {
  id: number;
  corners: [P2, P2, P2, P2];
}

export interface LensFit {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  dist: [number, number, number, number, number];
  rms: number;
}

/** Objects that keep their OpenCV state between calls. */
class Detectors {
  readonly board: CV;
  readonly charuco: CV;
  readonly aruco: CV;
  readonly corners: { x: number; y: number }[];
  constructor(cv: CV) {
    const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);
    this.board = new cv.aruco_CharucoBoard(new cv.Size(BOARD.nx, BOARD.ny), BOARD.square, BOARD.marker, dict, new cv.Mat());
    this.charuco = new cv.aruco_CharucoDetector(this.board, new cv.aruco_CharucoParameters(), new cv.aruco_DetectorParameters(), new cv.aruco_RefineParameters(10, 3, true));
    const params = new cv.aruco_DetectorParameters();
    params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX ?? 1;
    this.aruco = new cv.aruco_ArucoDetector(dict, params, new cv.aruco_RefineParameters(10, 3, true));
    const all = this.board.getChessboardCorners();
    this.corners = Array.from({ length: all.size() }, (_, i) => all.get(i) as { x: number; y: number });
  }
}

const detectors = new WeakMap<object, Detectors>();
const det = (cv: CV): Detectors => {
  let d = detectors.get(cv);
  if (!d) detectors.set(cv, (d = new Detectors(cv)));
  return d;
};

function grey(cv: CV, image: ImageData): CV {
  const rgba = cv.matFromImageData(image);
  const g = new cv.Mat();
  cv.cvtColor(rgba, g, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  return g;
}

/** The ChArUco board in a camera image (null when too little of it is seen). */
export function detectBoard(cv: CV, image: ImageData, minCorners = 8): BoardView | null {
  const d = det(cv);
  const g = grey(cv, image);
  const cc = new cv.Mat();
  const ci = new cv.Mat();
  const mc = new cv.MatVector();
  const mi = new cv.Mat();
  try {
    d.charuco.detectBoard(g, cc, ci, mc, mi);
    const markers: P2[][] = [];
    for (let i = 0; i < mc.size(); i++) {
      const m = mc.get(i);
      markers.push([0, 1, 2, 3].map((k) => [m.data32F[k * 2], m.data32F[k * 2 + 1]] as P2));
      m.delete();
    }
    const n = ci.total();
    if (n < minCorners) return markers.length ? { img: [], obj: [], markers } : null;
    const img: P2[] = [];
    const obj: P3[] = [];
    for (let i = 0; i < n; i++) {
      const c = d.corners[ci.data32S[i]]!;
      obj.push([c.x, c.y, 0]);
      img.push([cc.data32F[i * 2], cc.data32F[i * 2 + 1]]);
    }
    return { img, obj, markers };
  } finally {
    for (const m of [g, cc, ci, mc, mi]) m.delete();
  }
}

/** ArUco markers in a camera image (corners clockwise from the marker's top left, sub-pixel). */
export function detectMarkers(cv: CV, image: ImageData): Marker[] {
  const d = det(cv);
  const g = grey(cv, image);
  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rejected = new cv.MatVector();
  try {
    d.aruco.detectMarkers(g, corners, ids, rejected);
    const out: Marker[] = [];
    for (let i = 0; i < corners.size(); i++) {
      const m = corners.get(i);
      out.push({ id: ids.data32S[i], corners: [0, 1, 2, 3].map((k) => [m.data32F[k * 2], m.data32F[k * 2 + 1]]) as Marker['corners'] });
      m.delete();
    }
    return out;
  } finally {
    for (const m of [g, corners, ids, rejected]) m.delete();
  }
}

const f64 = (cv: CV, rows: number, cols: number, type: number, data: number[]) => cv.matFromArray(rows, cols, type, data);

/** Lens calibration from board views (k3 held at 0: webcams rarely need it, and it overfits). */
export function calibrateLens(cv: CV, views: BoardView[], width: number, height: number): LensFit {
  const objs = new cv.MatVector();
  const imgs = new cv.MatVector();
  for (const v of views) {
    const o = f64(cv, v.obj.length, 1, cv.CV_32FC3, v.obj.flat());
    const p = f64(cv, v.img.length, 1, cv.CV_32FC2, v.img.flat());
    objs.push_back(o);
    imgs.push_back(p);
    o.delete();
    p.delete();
  }
  const K = new cv.Mat();
  const D = new cv.Mat();
  const rv = new cv.MatVector();
  const tv = new cv.MatVector();
  const sdi = new cv.Mat();
  const sde = new cv.Mat();
  const pve = new cv.Mat();
  try {
    const rms = cv.calibrateCameraExtended(objs, imgs, new cv.Size(width, height), K, D, rv, tv, sdi, sde, pve, cv.CALIB_FIX_K3, new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 100, 1e-9));
    const k = Array.from(K.data64F as Float64Array);
    const dd = Array.from(D.data64F as Float64Array);
    return { fx: k[0]!, fy: k[4]!, cx: k[2]!, cy: k[5]!, dist: [dd[0] ?? 0, dd[1] ?? 0, dd[2] ?? 0, dd[3] ?? 0, dd[4] ?? 0], rms };
  } finally {
    for (const m of [objs, imgs, K, D, rv, tv, sdi, sde, pve]) m.delete();
  }
}

/**
 * Camera pose from known 3D points and where they are seen. Returns the rotation vector and
 * translation (Xc = R·X + t) and the reprojection error in pixels.
 */
export function solvePose(
  cv: CV,
  obj: P3[],
  img: P2[],
  lens: { fx: number; fy: number; cx: number; cy: number; dist: number[] },
  method: 'iterative' | 'square' = 'iterative',
): { rvec: P3; tvec: P3; rms: number } {
  const o = f64(cv, obj.length, 1, cv.CV_64FC3, obj.flat());
  const p = f64(cv, img.length, 1, cv.CV_64FC2, img.flat());
  const K = f64(cv, 3, 3, cv.CV_64F, [lens.fx, 0, lens.cx, 0, lens.fy, lens.cy, 0, 0, 1]);
  const D = f64(cv, 1, 5, cv.CV_64F, lens.dist);
  const rvec = new cv.Mat();
  const tvec = new cv.Mat();
  const proj = new cv.Mat();
  const jac = new cv.Mat();
  try {
    const ok = cv.solvePnP(o, p, K, D, rvec, tvec, false, method === 'square' ? cv.SOLVEPNP_IPPE_SQUARE : cv.SOLVEPNP_ITERATIVE);
    if (!ok) throw new Error('no camera position fits these points');
    if (method === 'iterative') cv.solvePnPRefineLM(o, p, K, D, rvec, tvec, new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 50, 1e-10));
    cv.projectPoints(o, rvec, tvec, K, D, proj, jac);
    let sum = 0;
    for (let i = 0; i < img.length; i++) sum += (proj.data64F[i * 2] - img[i]![0]) ** 2 + (proj.data64F[i * 2 + 1] - img[i]![1]) ** 2;
    return { rvec: Array.from(rvec.data64F as Float64Array) as P3, tvec: Array.from(tvec.data64F as Float64Array) as P3, rms: Math.sqrt(sum / img.length) };
  } finally {
    for (const m of [o, p, K, D, rvec, tvec, proj, jac]) m.delete();
  }
}

/** The board as an image, `pxPerMm` pixels per millimetre (white margin around it). */
export function boardImage(cv: CV, pxPerMm: number, marginMm = 0): ImageData {
  const d = det(cv);
  const w = Math.round((BOARD.nx * BOARD.square + 2 * marginMm) * pxPerMm);
  const h = Math.round((BOARD.ny * BOARD.square + 2 * marginMm) * pxPerMm);
  const m = new cv.Mat();
  d.board.generateImage(new cv.Size(w, h), m, Math.round(marginMm * pxPerMm), 1);
  return toImageData(cv, m);
}

/** One marker as an image with a white border of one cell. */
export function markerImage(cv: CV, id: number, px: number): ImageData {
  const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);
  const inner = new cv.Mat();
  cv.generateImageMarker(dict, id, Math.round((px * 6) / 8), inner, 1);
  const m = new cv.Mat();
  const pad = Math.round(px / 8);
  cv.copyMakeBorder(inner, m, pad, pad, pad, pad, cv.BORDER_CONSTANT, new cv.Scalar(255));
  inner.delete();
  return toImageData(cv, m);
}

function toImageData(cv: CV, grey: CV): ImageData {
  const rgba = new cv.Mat();
  cv.cvtColor(grey, rgba, cv.COLOR_GRAY2RGBA);
  const out = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  grey.delete();
  rgba.delete();
  return out;
}
