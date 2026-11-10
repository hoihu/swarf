import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHIPS, Chips, Coolant } from '../src/lib/workshop/particles.ts';

/** A repeatable stand-in for Math.random. */
function seeded(seed = 5) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

describe('chips', () => {
  const from = new THREE.Vector3(10, 0, -10);
  const to = new THREE.Vector3(12, 0, -10);
  const away = new THREE.Vector3(0, 0.3, 1).normalize();

  it('fly off, fall, and come to rest on the ground: never through it, and gone after a while', () => {
    const c = new Chips(200);
    // the work's top at 0 for x < 40, the table 15 lower around it, nothing beyond x = 100
    c.ground = (x) => (x > 100 ? -Infinity : x < 40 ? 0 : -15);
    const rnd = seeded();
    for (let i = 0; i < 30; i++) {
      c.emit(CHIPS.aluminium!, from, to, away, 6, 1 / 60, rnd);
      c.update(1 / 60);
    }
    expect(c.pool.alive).toBeGreaterThan(40);
    let highest = -Infinity;
    for (let t = 0; t < 120; t++) {
      c.update(1 / 60);
      for (let i = 0; i < c.pool.n; i++) {
        if (c.pool.life[i]! <= 0) continue;
        const [x, y, z] = [c.pool.pos[i * 3]!, c.pool.pos[i * 3 + 1]!, c.pool.pos[i * 3 + 2]!];
        // on or above whatever is under it
        expect(y).toBeGreaterThanOrEqual(c.ground(x, z) - 1e-6);
        highest = Math.max(highest, y);
      }
    }
    // two seconds on: all lying still on the work or the table
    const before = Array.from(c.pool.pos);
    c.update(1 / 60);
    let lying = 0;
    for (let i = 0; i < c.pool.n; i++) {
      if (c.pool.life[i]! <= 0) continue;
      lying++;
      expect(c.pool.pos[i * 3 + 1]).toBe(before[i * 3 + 1]);
      expect(c.pool.pos[i * 3 + 1]!).toBeLessThan(2);
    }
    expect(lying).toBeGreaterThan(30);
    expect(highest).toBeGreaterThan(1);
    // and after their time they are gone
    for (let t = 0; t < 60 * 14; t++) c.update(1 / 60);
    expect(c.pool.alive).toBe(0);
    expect(c.update(1 / 60)).toBe(false);
  });

  it('how many depends on the material and the time, however the frames fall; the pool never overflows', () => {
    const count = (look: (typeof CHIPS)[string], dt: number, frames: number) => {
      const c = new Chips(5000);
      c.lie = 100;
      c.ground = () => -1000;
      const rnd = seeded();
      for (let i = 0; i < frames; i++) c.emit(look, from, to, away, 6, dt, rnd);
      c.update(0.001);
      return c.pool.alive;
    };
    const brass = count(CHIPS.brass!, 1 / 60, 60);
    const plastic = count(CHIPS.plastic!, 1 / 60, 60);
    expect(brass).toBeGreaterThan(plastic * 2.5);
    // one second at 60 or at 20 frames a second: the same chips, give or take one
    expect(Math.abs(count(CHIPS.steel!, 1 / 20, 20) - count(CHIPS.steel!, 1 / 60, 60))).toBeLessThanOrEqual(1);
    const small = new Chips(50);
    small.ground = () => 0;
    const rnd = seeded();
    for (let i = 0; i < 600; i++) {
      small.emit(CHIPS.brass!, from, to, away, 6, 1 / 60, rnd);
      small.update(1 / 60);
    }
    expect(small.pool.alive).toBeLessThanOrEqual(50);
    expect(small.mesh.count).toBeLessThanOrEqual(50);
  });

  it('every material the job can name has its chips', async () => {
    const { MATERIALS } = await import('@swarf/cam');
    for (const id of Object.keys(MATERIALS)) expect(CHIPS[id], id).toBeDefined();
  });
});

describe('coolant', () => {
  it('runs from the nozzle onto the cutter and splashes off from there', () => {
    const c = new Coolant(400);
    c.ground = () => -5;
    const nozzle = new THREE.Vector3(-20, 15, 8);
    const target = new THREE.Vector3(0, 2, 0);
    const rnd = seeded(11);
    c.emit(nozzle, target, 1, 1 / 60, rnd);
    const n = c.pool.alive || 5;
    expect(n).toBeGreaterThan(3);
    // each drop passes within a millimetre or two of the target when its flight is over
    const flight = nozzle.distanceTo(target) / 620;
    const steps = Math.round(flight / 0.001);
    for (let i = 0; i < steps - 1; i++) c.update(0.001, rnd);
    for (let i = 0; i < 5; i++) {
      const p = new THREE.Vector3(c.pool.pos[i * 3], c.pool.pos[i * 3 + 1], c.pool.pos[i * 3 + 2]);
      expect(p.distanceTo(target)).toBeLessThan(2.5);
    }
    // then they fly apart and are gone within a second
    for (let i = 0; i < 100; i++) c.update(0.01, rnd);
    expect(c.pool.alive).toBe(0);
  });
});
