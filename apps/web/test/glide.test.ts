import { describe, expect, it } from 'vitest';
import { Glide } from '../src/lib/glide.ts';

describe('Glide: the tool marker between status reports', () => {
  it('goes from where it was shown to the new report over the time between reports', () => {
    const g = new Glide();
    g.report({ x: 0, y: 0, z: 0 }, 1000);
    expect(g.at(1000)).toEqual({ x: 0, y: 0, z: 0 });
    g.report({ x: 10, y: 0, z: 0 }, 1200);
    expect(g.at(1200).x).toBeCloseTo(0);
    expect(g.at(1300).x).toBeCloseTo(5);
    expect(g.at(1400).x).toBeCloseTo(10);
    expect(g.at(2000).x).toBeCloseTo(10);
    expect(g.moving(1300)).toBe(true);
    expect(g.moving(1400)).toBe(false);
  });
  it('takes a report that comes early from where the marker is, without a jump', () => {
    const g = new Glide();
    g.report({ x: 0, y: 0, z: 0 }, 0);
    g.report({ x: 10, y: 0, z: 0 }, 200);
    g.report({ x: 20, y: 0, z: 0 }, 300); // halfway there: the next leg starts at x 5
    expect(g.at(300).x).toBeCloseTo(5);
    expect(g.at(400).x).toBeGreaterThan(5);
  });
  it('keeps the glide short after a long pause (a machine that stood still)', () => {
    const g = new Glide();
    g.report({ x: 0, y: 0, z: 0 }, 0);
    g.report({ x: 10, y: 0, z: 0 }, 60000);
    expect(g.at(60000 + 400).x).toBeCloseTo(10);
  });
});
