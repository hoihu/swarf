import { describe, expect, it } from 'vitest';
import { measureBlock, type Grey } from '../src/lib/camera/setup.ts';
import { pixelToRay, type Lens, type Pose, type V3 } from '../src/lib/camera/geometry.ts';

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

/** Ray-cast picture of a block (top at z 0, height h) on a table, seen through the lens. */
function render(pose: Pose, block: { cx: number; cy: number; sx: number; sy: number; angle: number; h: number }, noise = 4): Grey {
  const { width: w, height: h } = lens;
  const lum = new Float32Array(w * h);
  const R = pose.R;
  // camera centre and ray directions in world coordinates
  const C: V3 = [-(R[0] * pose.t[0] + R[3] * pose.t[1] + R[6] * pose.t[2]), -(R[1] * pose.t[0] + R[4] * pose.t[1] + R[7] * pose.t[2]), -(R[2] * pose.t[0] + R[5] * pose.t[1] + R[8] * pose.t[2])];
  const a = (block.angle * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // into the block's frame: centred, turned back
  const toB = (p: V3): V3 => [(p[0] - block.cx) * ca + (p[1] - block.cy) * sa, -(p[0] - block.cx) * sa + (p[1] - block.cy) * ca, p[2]];
  const lo: V3 = [-block.sx / 2, -block.sy / 2, -block.h];
  const hi: V3 = [block.sx / 2, block.sy / 2, 0];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const [x, y] = pixelToRay(lens, u, v);
      const dc: V3 = [x, y, 1];
      const d: V3 = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
      const o = toB(C);
      const db: V3 = [d[0] * ca + d[1] * sa, -d[0] * sa + d[1] * ca, d[2]];
      // slab test
      let t0 = -Infinity;
      let t1 = Infinity;
      let face = -1;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(db[i]!) < 1e-12) {
          if (o[i]! < lo[i]! || o[i]! > hi[i]!) t0 = Infinity;
          continue;
        }
        let ta = (lo[i]! - o[i]!) / db[i]!;
        let tb = (hi[i]! - o[i]!) / db[i]!;
        let f = i * 2;
        if (ta > tb) {
          [ta, tb] = [tb, ta];
          f = i * 2 + 1;
        }
        if (ta > t0) {
          t0 = ta;
          face = f;
        }
        t1 = Math.min(t1, tb);
      }
      let L: number;
      if (t0 <= t1 && t0 > 0) {
        // faces: 0 x−, 1 x+, 2 y− (front), 3 y+, 4 z−, 5 z+ (top)
        L = [125, 120, 140, 110, 60, 185][face]!;
      } else {
        // the table at z = −h, with a little texture
        const t = (-block.h - C[2]) / d[2];
        const px = C[0] + t * d[0];
        const py = C[1] + t * d[1];
        L = 70 + 6 * Math.sin(px * 0.7) * Math.sin(py * 0.9);
      }
      lum[v * w + u] = L + noise * rnd();
    }
  // the camera's own softness: a 3 × 3 blur
  const out = new Float32Array(w * h);
  for (let v = 1; v < h - 1; v++)
    for (let u = 1; u < w - 1; u++) {
      let s = 0;
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) s += lum[(v + dv) * w + u + du]!;
      out[v * w + u] = s / 9;
    }
  return { width: w, height: h, lum: out };
}

describe('measuring the block from the camera', () => {
  const stock = { x: 80, y: 50, top: 0 };
  const pose = lookAt([70, -210, 190], [40, 25, 15], [0, 0, 1]);

  it('finds a block that is off, a different size and turned, to a tenth of a millimetre', () => {
    // the real block: front-left corner at (1.5, −2.0), 82.4 × 48.7, turned 0.8°
    const sx = 82.4;
    const sy = 48.7;
    const ang = 0.8;
    const a = (ang * Math.PI) / 180;
    const corner = [1.5, -2.0];
    const cx = corner[0]! + (sx / 2) * Math.cos(a) - (sy / 2) * Math.sin(a);
    const cy = corner[1]! + (sx / 2) * Math.sin(a) + (sy / 2) * Math.cos(a);
    const g = render(pose, { cx, cy, sx, sy, angle: ang, h: 15 });
    const fit = measureBlock(g, lens, pose, [0, 0, 0], stock);
    expect(fit.corner[0]).toBeCloseTo(1.5, 1);
    expect(fit.corner[1]).toBeCloseTo(-2.0, 1);
    expect(fit.x).toBeCloseTo(sx, 1);
    expect(fit.y).toBeCloseTo(sy, 1);
    expect(Math.abs(fit.angle - ang)).toBeLessThan(0.1);
    for (const e of fit.edges) expect(e.rms).toBeLessThan(0.15);
  });

  it('a block where the job has it reads as such', () => {
    const g = render(pose, { cx: 40, cy: 25, sx: 80, sy: 50, angle: 0, h: 15 });
    const fit = measureBlock(g, lens, pose, [0, 0, 0], stock);
    expect(Math.hypot(...fit.corner)).toBeLessThan(0.1);
    expect(Math.abs(fit.x - 80)).toBeLessThan(0.1);
    expect(Math.abs(fit.y - 50)).toBeLessThan(0.1);
  });

  it('says which edge it cannot find when the block is far from the job', () => {
    const g = render(pose, { cx: 40 + 35, cy: 25, sx: 80, sy: 50, angle: 0, h: 15 });
    expect(() => measureBlock(g, lens, pose, [0, 0, 0], stock)).toThrow(/edge/);
  });
});
