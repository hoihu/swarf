import { describe, expect, it } from 'vitest';
import { withOps } from './support/fixtures.ts';
import {
  adaptivePlans,
  offsetRegion,
  inRegion,
  Job,
  MillMaterial,
  analyze,
  hasErrors,
  walk,
  samplePath,
} from '../src/index.ts';
import type { JobInput } from '../src/schema.ts';

describe('adaptive clearing', () => {
  const pocket = (strategy: 'rings' | 'adaptive', patch: Record<string, unknown> = {}, jobPatch: Partial<JobInput> = {}) =>
    withOps('mill', [{ type: 'mill_pocket_rect', tool: 1, x: 20, y: 15, w: 40, h: 20, zBottom: -8, zTop: 0, strategy, ...patch }], { stock: { kind: 'block', x: 80, y: 50, z: 15, top: 0 }, ...jobPatch });

  /** How wide the strip of material is that the cutter takes on each of its moves at depth (mm), from the material model. */
  function bites(job: Job, below: number): number[] {
    const a = analyze(job);
    const m = new MillMaterial(job.stock as Extract<Job['stock'], { kind: 'block' }>, 0.2);
    const tool = job.tools.find((t) => t.id === job.operations[0]!.tool)!;
    const r = tool.diameter! / 2;
    const out: number[] = [];
    for (const { from, move } of walk(a.program)) {
      if (move.type === 'rapid') continue;
      let prev = from;
      let took = 0;
      let went = 0;
      for (const p of samplePath(from, move, 0.2)) {
        const step = Math.hypot(p.x - prev.x, p.y - prev.y);
        // the cells this step takes away
        let n = 0;
        const i0 = Math.max(0, Math.floor((p.x - r) / m.cell));
        const i1 = Math.min(m.nx - 1, Math.floor((p.x + r) / m.cell));
        const j0 = Math.max(0, Math.floor((p.y - r) / m.cell));
        const j1 = Math.min(m.ny - 1, Math.floor((p.y + r) / m.cell));
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const dx = (i + 0.5) * m.cell - p.x;
            const dy = (j + 0.5) * m.cell - p.y;
            if (dx * dx + dy * dy <= r * r && m.h[j * m.nx + i]! > p.z + 0.05) n++;
          }
        m.cutPath([p], tool);
        // (only level travel at depth, away from where the cutter came down: the helix is another matter)
        if (Math.abs(p.z - prev.z) < 1e-6 && p.z <= below && Math.hypot(p.x - 40, p.y - 25) > 2.8) {
          took += n * m.cell * m.cell;
          went += step;
        }
        prev = p;
      }
      // (per move of some length: a single step is a handful of cells)
      if (went > 1.5) out.push(took / went);
    }
    return out;
  }
  const pct = (v: number[], q: number) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) * q)]!;

  it('clears the same pocket as the rings, down to the floor, with no complaint', () => {
    const rings = analyze(pocket('rings'));
    const job = pocket('adaptive');
    const adaptive = analyze(job);
    expect(adaptive.diagnostics).toEqual([]);
    const a = adaptive.material as MillMaterial;
    const b = rings.material as MillMaterial;
    let differ = 0;
    let floor = 0;
    for (let k = 0; k < a.h.length; k++) {
      if (Math.abs(a.h[k]! - b.h[k]!) > 0.05) differ++;
      if (a.h[k]! < -7.9) floor++;
    }
    // the floor is the pocket's area (40 × 20 less the corners the Ø6 tool leaves: 3² (4 − π) / 4 each)
    expect(floor * a.cell * a.cell).toBeGreaterThan(40 * 20 - 9 * (4 - Math.PI) - 12);
    // the same shape as the rings leave, to a row of cells along the wall
    expect(differ * a.cell * a.cell).toBeLessThan(120 * a.cell * 1.5);
    // in one level over the flutes' depth, not three
    const zs = new Set<number>();
    for (const { move } of walk(adaptive.program)) if (move.type === 'feed' && move.to.z < -0.5) zs.add(Math.round(move.to.z * 100) / 100);
    expect(Math.min(...zs)).toBe(-8);
  });

  it('takes no more than its bite beside the cutter, where the rings start with a slot', () => {
    const b = bites(pocket('adaptive'), -7.99);
    expect(b.length).toBeGreaterThan(100);
    // the bite is 0.15 × 6 = 0.9 mm
    // (a ring's strip is a little wider than its bite on the outside of the turn)
    expect(pct(b, 0.5)).toBeLessThan(1.15);
    expect(pct(b, 0.95)).toBeLessThan(1.4);
    expect(Math.max(...b)).toBeLessThan(2.6);
    const rings = bites(pocket('rings', { stepDown: 8 }), -7.99);
    expect(Math.max(...rings)).toBeGreaterThan(5.5);
    // a wider bite is a wider strip
    const wide = bites(pocket('adaptive', { load: 0.3 }), -7.99);
    expect(pct(wide, 0.5)).toBeGreaterThan(1.2);
    // (still far from a slot, also on the tight first rings and where it moves onto a new one)
    expect(pct(wide, 0.95)).toBeLessThan(4);
  });

  it('feeds the thin chip faster, and is quicker in a deep pocket', () => {
    const rings = analyze(pocket('rings'));
    const adaptive = analyze(pocket('adaptive'));
    const fmax = (a: typeof rings) => Math.max(...a.program.segments.flatMap((s) => s.moves.map((m) => (m.type === 'rapid' ? 0 : m.f))));
    expect(fmax(adaptive) / fmax(rings)).toBeCloseTo(1 / Math.sqrt(1 - 0.7 ** 2), 1);
    expect(adaptive.seconds).toBeLessThan(rings.seconds * 0.85);
  });

  it('every front is within a bite of what was cleared before it', () => {
    const region = offsetRegion([[[0, 0], [40, 0], [40, 20], [0, 20]]], -3);
    const [plan] = adaptivePlans(region, 0.9, 6);
    expect(plan!.entry.rh).toBeCloseTo(2.7, 1);
    // from the helix's circle outwards: each pass's points lie in the last front's open way grown by a bite
    let cleared = [Array.from({ length: 48 }, (_, k) => [plan!.entry.c[0] + plan!.entry.rh * Math.cos((2 * Math.PI * k) / 48), plan!.entry.c[1] + plan!.entry.rh * Math.sin((2 * Math.PI * k) / 48)] as [number, number])];
    for (const f of plan!.fronts) {
      const reach = offsetRegion(cleared, 0.9 + 0.06);
      for (const p of f.passes) for (const q of p.pts) expect(inRegion(q, reach)).toBe(true);
      cleared = f.open;
    }
    // and in the end the whole region is cleared
    const last = plan!.fronts.at(-1)!.open;
    for (const q of [[0.1, 0.1], [33.9, 13.9], [17, 7], [0.1, 13.9]] as [number, number][]) expect(inRegion([q[0] + 3, q[1] + 3], last)).toBe(true);
  });

  it('goes round islands, clears a circle and a drawing, and leaves the finishing pass to the end', () => {
    const shape = { id: 's1', name: 'plate', at: { x: 10, y: 8 }, paths: [
      { closed: true, pts: [[0, 0], [50, 0], [50, 30], [0, 30]] as [number, number][] },
      { closed: true, pts: [[20, 10], [30, 10], [30, 20], [20, 20]] as [number, number][] },
    ] };
    const job = withOps('mill', [{ type: 'mill_pocket', tool: 1, shape: 's1', zBottom: -6, zTop: 0, strategy: 'adaptive', finish: 0.2 }], { stock: { kind: 'block', x: 80, y: 50, z: 15, top: 0 }, shapes: [shape] });
    const a = analyze(job);
    expect(hasErrors(a.diagnostics)).toBe(false);
    const m = a.material as MillMaterial;
    const at = (x: number, y: number) => m.h[Math.floor(y / m.cell) * m.nx + Math.floor(x / m.cell)]!;
    // the island stands, the pocket around it is at depth, the wall is where the drawing has it
    expect(at(35, 23)).toBeCloseTo(0, 5);
    for (const [x, y] of [[14, 12], [56, 34], [35, 12], [35, 34], [14, 23]] as const) expect(at(x, y)).toBeCloseTo(-6, 5);
    expect(at(9.5, 23)).toBeCloseTo(0, 5);
    expect(at(10.7, 23)).toBeCloseTo(-6, 5);
    const circle = withOps('mill', [{ type: 'mill_pocket_circle', tool: 1, cx: 40, cy: 25, diameter: 30, zBottom: -5, zTop: 0, strategy: 'adaptive' }], { stock: { kind: 'block', x: 80, y: 50, z: 15, top: 0 } });
    const c = analyze(circle);
    expect(c.diagnostics).toEqual([]);
    const cm = c.material as MillMaterial;
    expect(cm.h[Math.floor(25 / cm.cell) * cm.nx + Math.floor(54 / cm.cell)]!).toBeCloseTo(-5, 5);
    expect(cm.h[Math.floor(25 / cm.cell) * cm.nx + Math.floor(56 / cm.cell)]!).toBeCloseTo(0, 5);
  }, 30000);

  it('refuses a pocket hardly wider than the tool, and says what to do', () => {
    const narrow = withOps('mill', [{ type: 'mill_pocket_rect', tool: 1, x: 20, y: 15, w: 40, h: 7, zBottom: -4, zTop: 0, strategy: 'adaptive' }]);
    const d = analyze(narrow).diagnostics;
    expect(hasErrors(d)).toBe(true);
    expect(d[0]!.message).toMatch(/too narrow to clear with a small bite/);
  });

  it('deeper than the flutes: in levels, each as deep as they cut', () => {
    const job = pocket('adaptive', { zBottom: -24 }, { stock: { kind: 'block', x: 80, y: 50, z: 30, top: 0 } });
    const a = analyze(job);
    const zs = new Set<number>();
    for (const { from, move } of walk(a.program)) if (move.type === 'feed' && Math.abs(move.to.z - from.z) < 1e-9 && move.to.z < -0.5) zs.add(Math.round(move.to.z * 100) / 100);
    // Ø6 with 15 mm of flutes: two diameters at a time
    expect([...zs].sort((p, q) => q - p)).toEqual([-12, -24]);
    expect(hasErrors(a.diagnostics)).toBe(false);
  });
});
