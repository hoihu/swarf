import { describe, expect, it } from 'vitest';
import { EXAMPLES, MillMaterial } from '@swarf/cam';
import { Heat, NOT_CUT } from '../src/lib/heat.ts';

const block = () => {
  const s = EXAMPLES.mill().stock;
  if (s.kind !== 'block') throw new Error('no block');
  return new MillMaterial(s);
};
/** A pass along X at y, as the preview cuts it: points close together. */
const pass = (y: number) => Array.from({ length: 161 }, (_, i) => ({ x: i * 0.5, y, z: 0 }));
const at = (m: MillMaterial, x: number, y: number) => Math.floor(y / m.cell) * m.nx + Math.floor(x / m.cell);

describe('Heat: when each place was last cut', () => {
  it('stamps the cells a cut lowered with the time it was seen, and only those', () => {
    const m = block();
    const h = new Heat();
    h.note(m, 10);
    expect(h.at![at(m, 5, 5)]).toBe(NOT_CUT);
    // a facing pass along X at the front, then the next one a little later
    m.cutPath(pass(3), { id: 1, name: 'e', type: 'endmill', diameter: 6, flutes: 3 });
    expect(h.note(m, 11)).toBe(true);
    m.cutPath(pass(7), { id: 1, name: 'e', type: 'endmill', diameter: 6, flutes: 3 });
    h.note(m, 12);
    expect(h.at![at(m, 40, 3)]).toBe(11);
    expect(h.at![at(m, 40, 9)]).toBe(12);
    expect(h.at![at(m, 40, 30)]).toBe(NOT_CUT);
    expect(h.until).toBe(12);
    // nothing new: nothing changes
    expect(h.note(m, 13)).toBe(false);
    expect(h.at![at(m, 40, 9)]).toBe(12);
  });
  it('starts over, nothing glowing, with a material made anew', () => {
    const h = new Heat();
    const a = block();
    h.note(a, 1);
    a.cutPath(pass(3), { id: 1, name: 'e', type: 'endmill', diameter: 6, flutes: 3 });
    h.note(a, 2);
    const b = block();
    b.cutPath(pass(3), { id: 1, name: 'e', type: 'endmill', diameter: 6, flutes: 3 });
    h.note(b, 3);
    expect(h.at![at(b, 40, 3)]).toBe(NOT_CUT);
  });
});
