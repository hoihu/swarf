/** The top touched at several points: how flat and level it is. */

export interface SurfaceResult {
  /** The points the figures are from. */
  points: { x: number; y: number; z: number }[];
  /** Touched but far off the others (a chip, a burr, a clamp's nose): left out of the figures. */
  outliers?: { x: number; y: number; z: number; off: number }[];
  /** Not touched: under a known obstacle, or something was in the way going down (where it stopped). */
  skipped?: { x: number; y: number; why: 'obstacle' | 'blocked'; z?: number }[];
  highest: number;
  lowest: number;
  mean: number;
  /** Plane fit z = a + bx·x + by·y: slope in mm per 100 mm, and the largest departure from it. */
  slopeX: number;
  slopeY: number;
  flatness: number;
}

/**
 * Highest, lowest, mean, and a plane through the points (least squares) with the largest departure
 * from it. With six points or more, a point far off the others is left out and reported: one whose
 * leaving out makes the rest fit a plane closely, and which is more than 0.15 mm and four times
 * that closeness off it (a warped top, off everywhere a little, keeps all its points).
 */
export function analyseSurface(all: SurfaceResult['points']): SurfaceResult {
  let points = all;
  const outliers: NonNullable<SurfaceResult['outliers']> = [];
  const worstOff = (pts: SurfaceResult['points'], f: ReturnType<typeof fitSurface>) => Math.max(...pts.map((p) => Math.abs(p.z - (f.a + f.b * p.x + f.c * p.y))));
  while (points.length >= 6) {
    let best: { i: number; rest: number; off: number } | null = null;
    for (let i = 0; i < points.length; i++) {
      const others = points.filter((_, k) => k !== i);
      const f = fitSurface(others);
      const rest = worstOff(others, f);
      const p = points[i]!;
      if (!best || rest < best.rest) best = { i, rest, off: p.z - (f.a + f.b * p.x + f.c * p.y) };
    }
    if (!best || Math.abs(best.off) <= Math.max(0.15, 4 * best.rest)) break;
    outliers.push({ ...points[best.i]!, off: best.off });
    points = points.filter((_, k) => k !== best.i);
  }
  const f = fitSurface(points);
  const zs = points.map((p) => p.z);
  return { points, outliers, highest: Math.max(...zs), lowest: Math.min(...zs), mean: f.mean, slopeX: f.b * 100, slopeY: f.c * 100, flatness: worstOff(points, f) };
}

/** z = a + b x + c y through the points (least squares), and their mean height. */
function fitSurface(points: SurfaceResult['points']): { a: number; b: number; c: number; mean: number } {
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
  return { a, b, c, mean };
}
