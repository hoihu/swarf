/**
 * Camera geometry without OpenCV: the pinhole model with OpenCV's distortion (k1 k2 p1 p2 k3),
 * the GL projection matrix that matches a calibrated camera, the centre of a marker seen in
 * perspective, and the tool-tip offset from clicks. OpenCV conventions: camera x right, y down,
 * z forward; R, t map machine coordinates into the camera (Xc = R·X + t).
 */

export type V2 = [number, number];
export type V3 = [number, number, number];
/** Row-major 3×3. */
export type M3 = [number, number, number, number, number, number, number, number, number];

export interface Lens {
  /** Image size the lens was calibrated at. */
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** k1, k2, p1, p2, k3 */
  dist: [number, number, number, number, number];
}

export interface Pose {
  R: M3;
  t: V3;
}

export const mulMV = (R: M3, v: V3): V3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
export const transpose = (R: M3): M3 => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Rotation vector (axis × angle, as OpenCV's rvec) → matrix. */
export function rodrigues(r: V3): M3 {
  const th = Math.hypot(...r);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = [r[0] / th, r[1] / th, r[2] / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** Normalized image coordinates → distorted normalized coordinates. */
export function distort(x: number, y: number, d: Lens['dist']): V2 {
  const [k1, k2, p1, p2, k3] = d;
  const r2 = x * x + y * y;
  const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  return [x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x), y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y];
}

/** Distorted normalized coordinates → undistorted (fixed-point iteration, as OpenCV's undistortPoints). */
export function undistortNormalized(xd: number, yd: number, d: Lens['dist']): V2 {
  const [k1, k2, p1, p2, k3] = d;
  let x = xd;
  let y = yd;
  for (let i = 0; i < 20; i++) {
    const r2 = x * x + y * y;
    const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
    x = (xd - dx) / radial;
    y = (yd - dy) / radial;
  }
  return [x, y];
}

/** A point (machine coordinates) → pixel in the camera's (distorted) image. Null behind the camera. */
export function project(lens: Lens, pose: Pose, X: V3): V2 | null {
  const c = add(mulMV(pose.R, X), pose.t);
  if (c[2] <= 1e-9) return null;
  const [xd, yd] = distort(c[0] / c[2], c[1] / c[2], lens.dist);
  return [lens.fx * xd + lens.cx, lens.fy * yd + lens.cy];
}

/** Pixel in the distorted image → normalized undistorted coordinates (the ray x, y, 1). */
export function pixelToRay(lens: Lens, u: number, v: number): V2 {
  return undistortNormalized((u - lens.cx) / lens.fx, (v - lens.cy) / lens.fy, lens.dist);
}

/** A pixel of the undistorted image (same intrinsics, no distortion) → the pixel of the camera image it shows. */
export function undistortedToDistorted(lens: Lens, u: number, v: number): V2 {
  const [xd, yd] = distort((u - lens.cx) / lens.fx, (v - lens.cy) / lens.fy, lens.dist);
  return [lens.fx * xd + lens.cx, lens.fy * yd + lens.cy];
}

/**
 * The GL projection matrix (column-major, as THREE.Matrix4.elements) of a pinhole camera with
 * these intrinsics, for an image of the calibrated size: a point at GL camera coordinates (x, y,
 * z), z < 0 in front, lands where the undistorted image shows it (GL window coordinates, where
 * pixel i spans i..i+1: OpenCV's pixel coordinate u is at u + 0.5).
 */
export function glProjection(lens: Lens, near: number, far: number): number[] {
  const { width: w, height: h, fx, fy } = lens;
  // OpenCV puts a pixel's centre at whole numbers, GL at +0.5: the principal point in GL's terms
  const cx = lens.cx + 0.5;
  const cy = lens.cy + 0.5;
  // rows of the matrix
  const r0 = [(2 * fx) / w, 0, 1 - (2 * cx) / w, 0];
  const r1 = [0, (2 * fy) / h, (2 * cy) / h - 1, 0];
  const r2 = [0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near)];
  const r3 = [0, 0, -1, 0];
  const rows = [r0, r1, r2, r3];
  const out: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(rows[r]![c]!);
  return out;
}

/**
 * The GL view matrix (column-major) of a pose: OpenCV's camera frame turned to GL's (y up,
 * looking down −z).
 */
export function glView(pose: Pose): number[] {
  const { R, t } = pose;
  const rows = [
    [R[0], R[1], R[2], t[0]],
    [-R[3], -R[4], -R[5], -t[1]],
    [-R[6], -R[7], -R[8], -t[2]],
    [0, 0, 0, 1],
  ];
  const out: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(rows[r]![c]!);
  return out;
}

/** Where the diagonals of a quadrilateral cross: the true centre of a square seen in perspective. */
export function quadCenter(c: [V2, V2, V2, V2]): V2 {
  const [a, b, cc, d] = c;
  // a + s (cc − a) = b + u (d − b)
  const r: V2 = [cc[0] - a[0], cc[1] - a[1]];
  const q: V2 = [d[0] - b[0], d[1] - b[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-12) return [(a[0] + b[0] + cc[0] + d[0]) / 4, (a[1] + b[1] + cc[1] + d[1]) / 4];
  const s = ((b[0] - a[0]) * q[1] - (b[1] - a[1]) * q[0]) / den;
  return [a[0] + s * r[0], a[1] + s * r[1]];
}

/**
 * The tool tip's offset from the marker, from clicks on the tip. The pose was solved with the
 * marker's centre at the machine position M, so it describes a frame shifted by the offset m
 * (marker = tip + m): the tip at machine position M sits at M − m there. Each click (the
 * undistorted ray x, y through the tip) gives two linear equations in w = R·m:
 * a − w ∥ (x, y, 1) with a = R·M + t. Least squares over all clicks; m = Rᵀ·w.
 */
export function tipOffset(pose: Pose, clicks: { M: V3; ray: V2 }[]): { m: V3; residual: number } {
  // normal equations AᵀA w = Aᵀb
  const AtA = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const Atb = [0, 0, 0];
  const rows: { a: V3; b: number }[] = [];
  for (const { M, ray } of clicks) {
    const a = add(mulMV(pose.R, M), pose.t);
    const [x, y] = ray;
    // (a_x − w_x) − x (a_z − w_z) = 0  →  −w_x + x w_z = −(a_x − x a_z)
    rows.push({ a: [-1, 0, x], b: -(a[0] - x * a[2]) });
    rows.push({ a: [0, -1, y], b: -(a[1] - y * a[2]) });
  }
  for (const { a, b } of rows) {
    for (let i = 0; i < 3; i++) {
      Atb[i]! += a[i]! * b;
      for (let j = 0; j < 3; j++) AtA[i * 3 + j]! += a[i]! * a[j]!;
    }
  }
  const w = solve3(AtA as M3, Atb as V3);
  // in mm at the tip (camera space, scaled by depth 1)
  const residual = Math.sqrt(rows.reduce((s, r) => s + (r.a[0] * w[0] + r.a[1] * w[1] + r.a[2] * w[2] - r.b) ** 2, 0) / rows.length);
  return { m: mulMV(transpose(pose.R), w), residual };
}

/** The pose for the tip instead of the marker: Xc = R (X − m) + t. */
export function shiftPose(pose: Pose, m: V3): Pose {
  return { R: pose.R, t: sub(pose.t, mulMV(pose.R, m)) };
}

function solve3(A: M3, b: V3): V3 {
  const det = (m: M3) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) throw new Error('the clicks do not pin the tool tip down: click it at positions farther apart');
  const col = (i: number): M3 => A.map((v, k) => (k % 3 === i ? b[Math.floor(k / 3)]! : v)) as M3;
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/** The camera's position in machine coordinates. */
export function cameraCenter(pose: Pose): V3 {
  const c = mulMV(transpose(pose.R), pose.t);
  return [-c[0], -c[1], -c[2]];
}
