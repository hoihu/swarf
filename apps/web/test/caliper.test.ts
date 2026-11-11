import { describe, expect, it } from 'vitest';
import { findEnd, findShoulder, measureCylinder } from '../src/lib/camera/caliper.ts';
import { pixelToRay, type Lens, type Pose, type V3 } from '../src/lib/camera/geometry.ts';
import type { Grey } from '../src/lib/camera/setup.ts';

const lens: Lens = { width: 1280, height: 720, fx: 1060, fy: 1058, cx: 652, cy: 349, dist: [-0.16, 0.09, 0.0006, -0.0004, 0] };

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function lookAt(C: V3, target: V3, up: V3): Pose {
  const z = norm([target[0] - C[0], target[1] - C[1], target[2] - C[2]]);
  const x = norm(cross(z, up));
  const y = cross(z, x);
  return { R: [...x, ...y, ...z] as Pose['R'], t: [-dot(x, C), -dot(y, C), -dot(z, C)] };
}

/** A round body along one of the axes: through `at`, from a to b along it. */
interface Body { axis: 0 | 1 | 2; at: V3; a: number; b: number; r: number; lum: number }

/** Ray-cast picture of round bodies in front of a plain background, lit from the camera's upper left, with noise. */
function render(pose: Pose, C: V3, bodies: Body[], noise = 3): Grey {
  const { width: w, height: h } = lens;
  const lum = new Float32Array(w * h);
  const R = pose.R;
  const light = norm([0.4, -0.5, 0.8]);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const [x, y] = pixelToRay(lens, u, v);
      const d = norm([R[0] * x + R[3] * y + R[6], R[1] * x + R[4] * y + R[7], R[2] * x + R[5] * y + R[8]]);
      let best = Infinity;
      let L = 185 - 25 * (v / h);
      for (const b of bodies) {
        const [i, j, k] = b.axis === 2 ? [0, 1, 2] : b.axis === 0 ? [1, 2, 0] : [2, 0, 1];
        const o: V3 = [C[0] - b.at[0], C[1] - b.at[1], C[2] - b.at[2]];
        // the side
        const A = d[i!]! * d[i!]! + d[j!]! * d[j!]!;
        const B = 2 * (o[i!]! * d[i!]! + o[j!]! * d[j!]!);
        const Cc = o[i!]! * o[i!]! + o[j!]! * o[j!]! - b.r * b.r;
        const disc = B * B - 4 * A * Cc;
        if (disc > 0 && A > 1e-12) {
          const t = (-B - Math.sqrt(disc)) / (2 * A);
          const zk = o[k!]! + d[k!]! * t;
          if (t > 0 && t < best && zk >= b.a && zk <= b.b) {
            best = t;
            const n: V3 = [0, 0, 0];
            n[i!] = (o[i!]! + d[i!]! * t) / b.r;
            n[j!] = (o[j!]! + d[j!]! * t) / b.r;
            L = b.lum * (0.55 + 0.45 * Math.abs(dot(n, light)));
          }
        }
        // the two end faces
        for (const e of [b.a, b.b]) {
          if (Math.abs(d[k!]!) < 1e-12) continue;
          const t = (e - o[k!]!) / d[k!]!;
          const pi = o[i!]! + d[i!]! * t;
          const pj = o[j!]! + d[j!]! * t;
          if (t > 0 && t < best && pi * pi + pj * pj <= b.r * b.r) {
            best = t;
            L = b.lum * 0.8;
          }
        }
      }
      lum[v * w + u] = L + noise * rnd();
    }
  return { width: w, height: h, lum };
}

describe('measuring round things from the picture', () => {
  it('a cutter in the spindle: its diameter, and where its tip is', () => {
    // the camera in front of the mill, above, looking down at the work; machine Z up
    const C: V3 = [20, -260, 170];
    const pose = lookAt(C, [5, 0, 15], [0, 0, 1]);
    for (const tool of [{ r: 4, tip: 3.2 }, { r: 1.5, tip: -6.5 }, { r: 6, tip: 0 }]) {
      const bodies: Body[] = [
        { axis: 2, at: [10, 5, 0], a: tool.tip, b: tool.tip + 38, r: tool.r, lum: 150 },
        { axis: 2, at: [10, 5, 0], a: tool.tip + 38, b: 140, r: 22, lum: 60 },
      ];
      const g = render(pose, C, bodies);
      // where the tip is: looked for 15 mm either side of where it is expected (Z0 here)
      const first = measureCylinder(g, lens, pose, [10, 5, 0], [0, 0, 1], [12, 15, 18, 21, 24], 16);
      const tip = findEnd(g, lens, pose, [10, 5, 0], [0, 0, 1], -15, 12, first.diameter / 2, 1)!;
      expect(Math.abs(tip - tool.tip)).toBeLessThan(0.4);
      // then the diameter, over the 20 mm above the tip
      const fit = measureCylinder(g, lens, pose, [10, 5, tip], [0, 0, 1], [4, 7, 10, 13, 16, 19], 16);
      expect(fit.used).toBeGreaterThanOrEqual(5);
      expect(Math.abs(fit.diameter - 2 * tool.r)).toBeLessThan(0.25);
      expect(Math.abs(fit.offset)).toBeLessThan(0.3);
    }
  });

  it('tells a Ø6 from a Ø5 cutter, and a cutter that is not on the axis', () => {
    const C: V3 = [20, -260, 170];
    const pose = lookAt(C, [5, 0, 15], [0, 0, 1]);
    const at = (r: number, x = 10): Body[] => [{ axis: 2, at: [x, 5, 0], a: 0, b: 40, r, lum: 150 }];
    const d6 = measureCylinder(render(pose, C, at(3)), lens, pose, [10, 5, 0], [0, 0, 1], [5, 9, 13, 17], 12).diameter;
    const d5 = measureCylinder(render(pose, C, at(2.5)), lens, pose, [10, 5, 0], [0, 0, 1], [5, 9, 13, 17], 12).diameter;
    expect(d6 - d5).toBeGreaterThan(0.7);
    expect(d6 - d5).toBeLessThan(1.3);
    const off = measureCylinder(render(pose, C, at(3, 12)), lens, pose, [10, 5, 0], [0, 0, 1], [5, 9, 13, 17], 12);
    expect(Math.abs(Math.abs(off.offset) - 2)).toBeLessThan(0.4);
  });

  it('nothing there: no diameter', () => {
    const C: V3 = [20, -260, 170];
    const pose = lookAt(C, [5, 0, 15], [0, 0, 1]);
    const fit = measureCylinder(render(pose, C, []), lens, pose, [10, 5, 0], [0, 0, 1], [5, 9, 13, 17], 12);
    expect(fit.diameter).toBeNaN();
    expect(findEnd(render(pose, C, []), lens, pose, [10, 5, 0], [0, 0, 1], -15, 12, 3, 1)).toBeNull();
  });

  it('a bar in the chuck: its diameter, its front face, how far it stands out', () => {
    // the lathe: Z along the spindle (chuck on the −Z side), X towards the operator, Y up; the camera in front, above
    for (const bar of [{ r: 12.5, front: 1.2, chuck: -58.6 }, { r: 6, front: 0.4, chuck: -41 }]) {
      const mid = (bar.front + bar.chuck) / 2;
      const C: V3 = [190, 150, mid + 25];
      const pose = lookAt(C, [15, 0, mid + 10], [0, 1, 0]);
      const bodies: Body[] = [
        { axis: 2, at: [0, 0, 0], a: bar.chuck, b: bar.front, r: bar.r, lum: 165 },
        { axis: 2, at: [0, 0, 0], a: bar.chuck - 50, b: bar.chuck, r: 50, lum: 55 },
      ];
      const g = render(pose, C, bodies);
      // expected: Ø25 (or 12), 60 (or 40) out, the front at Z+1
      const out = bar.front - bar.chuck;
      const ts = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((k) => 1 - k * Math.round(out));
      const fit = measureCylinder(g, lens, pose, [0, 0, 0], [0, 0, 1], ts, bar.r * 2 + 6);
      expect(Math.abs(fit.diameter - 2 * bar.r)).toBeLessThan(0.3);
      const front = findEnd(g, lens, pose, [0, 0, 0], [0, 0, 1], -10, 14, fit.diameter / 2, -1)!;
      expect(Math.abs(front - bar.front)).toBeLessThan(0.5);
      const chuck = findShoulder(g, lens, pose, [0, 0, 0], [0, 0, 1], bar.chuck - 14, bar.chuck + 16, fit.diameter / 2)!;
      expect(Math.abs(chuck - bar.chuck)).toBeLessThan(0.6);
    }
  });
});
