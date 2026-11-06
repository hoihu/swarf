import { describe, expect, it } from 'vitest';
import { analyseScan, calibratePlane, extractLine, triangulate, type LaserPlane, type Rgba } from '../src/lib/camera/laser.ts';
import { project, type Lens, type Pose, type V2, type V3 } from '../src/lib/camera/geometry.ts';

const lens: Lens = { width: 1280, height: 720, fx: 1060, fy: 1058, cx: 652, cy: 349, dist: [-0.16, 0.09, 0.0006, -0.0004, 0] };
function lookAt(C: V3, target: V3, up: V3): Pose {
  const n = (v: V3): V3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = n([target[0] - C[0], target[1] - C[1], target[2] - C[2]]);
  const x = n(cross(z, up));
  const y = cross(z, x);
  return { R: [...x, ...y, ...z] as Pose['R'], t: [-(x[0] * C[0] + x[1] * C[1] + x[2] * C[2]), -(y[0] * C[0] + y[1] * C[1] + y[2] * C[2]), -(z[0] * C[0] + z[1] * C[1] + z[2] * C[2])] };
}
const pose = lookAt([70, -210, 190], [40, 25, 15], [0, 0, 1]);
const truth: LaserPlane = (() => {
  const l = Math.hypot(0, 1, 0.6);
  const n: V3 = [0, 1 / l, 0.6 / l];
  return { n, k: n[1] * -55 + n[2] * 70 };
})();
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/** The line on the surface z = h(x, y) along x, with the machine at p: points (by stepping x, solving y). */
function lineOn(p: V3, h: (x: number, y: number) => number, x0: number, x1: number, step = 0.5): V3[] {
  const out: V3[] = [];
  for (let x = x0; x <= x1; x += step) {
    // n·(X − p) = k with X = (x, y, h(x, y)): solve for y by a few fixed-point steps
    let y = p[1];
    for (let i = 0; i < 20; i++) y = p[1] + (truth.k - truth.n[0] * (x - p[0]) - truth.n[2] * (h(x, y) - p[2])) / truth.n[1];
    out.push([x, y, h(x, y)]);
  }
  return out;
}

describe('line laser', () => {
  it('calibration finds the sheet from the line on the top at four heights', () => {
    const views = [20, 30, 40, 50].map((hgt) => {
      const p: V3 = [40, 25, hgt];
      const pts = lineOn(p, () => 0, 5, 75).filter((X) => X[1] > 3 && X[1] < 47);
      return { p, pixels: pts.map((X) => project(lens, pose, X)!).map(([u, v]) => [u + 0.15 * rnd(), v + 0.15 * rnd()] as V2) };
    });
    const got = calibratePlane(lens, pose, 0, views, (X) => X[0] > 2 && X[0] < 78 && X[1] > 2 && X[1] < 48);
    for (let i = 0; i < 3; i++) expect(got.n[i]).toBeCloseTo(truth.n[i]!, 3);
    expect(got.k).toBeCloseTo(truth.k, 1);
    expect(got.rms).toBeLessThan(0.05);
  });

  it('turns line pixels back into the points the light fell on', () => {
    const p: V3 = [30, 10, 35];
    const h = (x: number) => (x < 40 ? 0 : 12); // a step: the top, then a clamp
    const pts = lineOn(p, h, 5, 75);
    const px = pts.map((X) => project(lens, pose, X)!);
    const back = triangulate(lens, pose, truth, p, px);
    for (let i = 0; i < pts.length; i++) for (let a = 0; a < 3; a++) expect(back[i]![a]).toBeCloseTo(pts[i]![a]!, 6);
  });

  it('finds the line in a picture to a tenth of a pixel, ignoring things that only got brighter', () => {
    const w = 400;
    const h = 200;
    const off = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const g = 90 + 20 * Math.sin(i * 0.37) + 4 * rnd();
      off.set([g, g, g, 255], i * 4);
    }
    const on = new Uint8ClampedArray(off);
    const centre = (u: number) => 80 + 0.12 * u + 6 * Math.sin(u / 60);
    for (let u = 0; u < w; u++)
      for (let v = 0; v < h; v++) {
        const i = (v * w + u) * 4;
        const red = 140 * Math.exp(-(((v - centre(u)) / 1.3) ** 2));
        on[i] = Math.min(255, on[i]! + red);
        on[i + 1] = Math.min(255, on[i + 1]! + red * 0.08);
      }
    // something grey moved (the tool): brighter in all channels, not a laser
    for (let u = 300; u < 340; u++)
      for (let v = 20; v < 60; v++) for (let c = 0; c < 3; c++) on[(v * w + u) * 4 + c] = Math.min(255, on[(v * w + u) * 4 + c]! + 60);
    const line = extractLine({ width: w, height: h, data: on } as Rgba, { width: w, height: h, data: off } as Rgba);
    expect(line.length).toBeGreaterThan(w * 0.95);
    const err = line.map(([u, v]) => Math.abs(v - centre(u)));
    expect(Math.max(...err)).toBeLessThan(0.15);
  });

  it('the scan: the top (tilted), and the clamps beside the block with their height', () => {
    const block = { x: 80, y: 50, top: 0, bottom: -15 };
    const topAt = (x: number, y: number) => 0.0004 * x - 0.0006 * y;
    const clamps = [
      { x0: -22, y0: 16, x1: -4, y1: 34, top: 8 },
      { x0: 84, y0: 16, x1: 102, y1: 34, top: 8 },
    ];
    const pts: V3[] = [];
    for (let y = -30; y <= 80; y += 1)
      for (let x = -40; x <= 120; x += 0.5) {
        const onBlock = x >= 0 && y >= 0 && x <= 80 && y <= 50;
        const c = clamps.find((k) => x >= k.x0 && x <= k.x1 && y >= k.y0 && y <= k.y1);
        pts.push([x, y, (onBlock ? topAt(x, y) : c ? c.top : block.bottom) + 0.02 * rnd()]);
      }
    const r = analyseScan(pts, block);
    expect(r.top.slopeX).toBeCloseTo(0.04, 2);
    expect(r.top.slopeY).toBeCloseTo(-0.06, 2);
    expect(r.top.flatness).toBeLessThan(0.05);
    expect(r.obstacles).toHaveLength(2);
    for (const [i, c] of clamps.entries()) {
      const o = r.obstacles.sort((a, b) => a.x0 - b.x0)[i]!;
      // to the cell, and a cell more for the cells along its edge (half clamp, half table)
      expect(Math.abs(o.x0 - c.x0)).toBeLessThan(2.1);
      expect(Math.abs(o.x1 - c.x1)).toBeLessThan(2.1);
      expect(Math.abs(o.y0 - c.y0)).toBeLessThan(2.1);
      expect(Math.abs(o.y1 - c.y1)).toBeLessThan(2.1);
      expect(o.top).toBeCloseTo(8, 1);
    }
  });
});
