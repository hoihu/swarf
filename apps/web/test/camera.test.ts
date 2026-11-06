import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { distort, glProjection, glView, pixelToRay, project, quadCenter, rodrigues, shiftPose, tipOffset, undistortNormalized, type Lens, type Pose, type V3 } from '../src/lib/camera/geometry.ts';

const lens: Lens = { width: 1280, height: 720, fx: 1100, fy: 1095, cx: 652, cy: 347, dist: [-0.12, 0.06, 0.0008, -0.0005, 0.0] };
const pose: Pose = { R: rodrigues([1.9, 0.3, -0.2]), t: [-40, 30, 420] };
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const points = (n: number): V3[] => Array.from({ length: n }, () => [rnd(-60, 60), rnd(-60, 60), rnd(-40, 40)]);

describe('camera geometry', () => {
  it('undistorting inverts distorting', () => {
    for (let i = 0; i < 50; i++) {
      const x = rnd(-0.6, 0.6);
      const y = rnd(-0.35, 0.35);
      const [xd, yd] = distort(x, y, lens.dist);
      const [ux, uy] = undistortNormalized(xd, yd, lens.dist);
      expect(ux).toBeCloseTo(x, 9);
      expect(uy).toBeCloseTo(y, 9);
    }
  });

  it('the GL matrices put a point where the pinhole model does (three.js, no distortion)', () => {
    const pinhole = { ...lens, dist: [0, 0, 0, 0, 0] as Lens['dist'] };
    const cam = new THREE.PerspectiveCamera();
    cam.projectionMatrix.fromArray(glProjection(pinhole, 1, 5000));
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.matrixAutoUpdate = false;
    cam.matrix.fromArray(glView(pose)).invert();
    cam.updateMatrixWorld(true);
    for (const X of points(40)) {
      const [u, v] = project(pinhole, pose, X)!;
      const ndc = new THREE.Vector3(...X).project(cam);
      // GL window coordinates: OpenCV's pixel u (centre) is at u + 0.5
      expect((ndc.x + 1) / 2 * lens.width - 0.5).toBeCloseTo(u, 6);
      expect((1 - ndc.y) / 2 * lens.height - 0.5).toBeCloseTo(v, 6);
      expect(Math.abs(ndc.z)).toBeLessThan(1);
    }
  });

  it('a square seen in perspective: its centre is where the diagonals cross, not the corners\' mean', () => {
    const c: V3 = [10, -5, 20];
    const R = rodrigues([0.5, -0.4, 0.3]);
    const corners = [[-15, -15], [15, -15], [15, 15], [-15, 15]].map(([a, b]) => {
      const p = [R[0] * a! + R[1] * b!, R[3] * a! + R[4] * b!, R[6] * a! + R[7] * b!];
      return project({ ...lens, dist: [0, 0, 0, 0, 0] }, pose, [c[0] + p[0]!, c[1] + p[1]!, c[2] + p[2]!])!;
    }) as [[number, number], [number, number], [number, number], [number, number]];
    const want = project({ ...lens, dist: [0, 0, 0, 0, 0] }, pose, c)!;
    const got = quadCenter(corners);
    expect(Math.hypot(got[0] - want[0], got[1] - want[1])).toBeLessThan(1e-6);
    const mean = [corners.reduce((s, p) => s + p[0], 0) / 4, corners.reduce((s, p) => s + p[1], 0) / 4];
    expect(Math.hypot(mean[0]! - want[0], mean[1]! - want[1])).toBeGreaterThan(0.05);
  });

  it('finds the tool tip from clicks well enough that the overlay lands within a pixel', () => {
    const m: V3 = [3, -8, 42]; // marker 42 mm above the tip, a little to the side
    // `pose` is what the marker gives (marker centre at M); the true camera, for the tip at M, is shiftPose(pose, m)
    const truth = shiftPose(pose, m);
    // clicked at opposite corners of the routine's grid, half a pixel off
    const tips: V3[] = [[-40, -25, 0], [40, 25, 30], [40, -25, 0], [-40, 25, 30]];
    for (let trial = 0; trial < 20; trial++) {
      const clicks = tips.map((M) => {
        const [u, v] = project(lens, truth, M)!;
        return { M, ray: pixelToRay(lens, u + rnd(-0.5, 0.5), v + rnd(-0.5, 0.5)) };
      });
      const { m: found, residual } = tipOffset(pose, clicks);
      expect(residual).toBeLessThan(0.3); // mm at the tip
      const solved = shiftPose(pose, found);
      for (const X of points(30)) {
        const a = project(lens, truth, X)!;
        const b = project(lens, solved, X)!;
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1);
      }
    }
  });
});
