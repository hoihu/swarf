import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSetup } from '../src/lib/sim/setups.ts';
import { solidsMesh } from '../src/lib/scene.ts';

const stock = { x: 60, y: 40, z: 8, top: 0.3 };
const none = { dx: 0, dy: 0, dsx: 0, dsy: 0, angle: 0, dz: 0, tiltX: 0, tiltY: 0 };

describe('what holds the block on the simulated table, in the preview', () => {
  it('draws each clamp but not the block, where it stands in work coordinates (scene: x, z, −y)', () => {
    const w = buildSetup(stock, none, 'side');
    const g = solidsMesh(w.solids, [0, 0, 0]);
    const meshes = g.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
    expect(meshes.length).toBe(2);
    const box = new THREE.Box3().setFromObject(meshes.find((m) => m.name === 'right block')!);
    // the right block: X 64…82, Y 11…29, from the bottom to 8 above the top
    expect(box.min.x).toBeCloseTo(64);
    expect(box.max.x).toBeCloseTo(82);
    expect(box.max.y).toBeCloseTo(8.3);
    expect(box.min.y).toBeCloseTo(-7.7);
    expect(box.min.z).toBeCloseTo(-29);
    expect(box.max.z).toBeCloseTo(-11);
  });
  it('moves with the work zero set since the simulator started', () => {
    const w = buildSetup(stock, none, 'vise');
    const a = new THREE.Box3().setFromObject(solidsMesh(w.solids, [0, 0, 0]));
    const b = new THREE.Box3().setFromObject(solidsMesh(w.solids, [-1, 2, -3]));
    expect(b.min.x - a.min.x).toBeCloseTo(-1);
    expect(b.min.z - a.min.z).toBeCloseTo(-2);
    expect(b.min.y - a.min.y).toBeCloseTo(-3);
  });
});
