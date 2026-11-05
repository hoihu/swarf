import { describe, expect, it } from 'vitest';
import { EXAMPLES, Job, analyze, area, importDrawing, profileFromDrawing, importDxf, importSvg, parsePathData, parseTransform, type MillMaterial } from '../src/index.ts';

/** A minimal DXF: header units and entities, as group code / value pairs. */
function dxf(units: number, entities: (string | number)[][]): string {
  const lines: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, units, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES'];
  for (const e of entities) lines.push(...e);
  lines.push(0, 'ENDSEC', 0, 'EOF');
  return lines.join('\n') + '\n';
}
const LINE = (x1: number, y1: number, x2: number, y2: number) => [0, 'LINE', 8, '0', 10, x1, 20, y1, 30, 0, 11, x2, 21, y2, 31, 0];
const CIRCLE = (x: number, y: number, r: number) => [0, 'CIRCLE', 8, '0', 10, x, 20, y, 30, 0, 40, r];
const ARC = (x: number, y: number, r: number, a0: number, a1: number) => [0, 'ARC', 8, '0', 10, x, 20, y, 30, 0, 40, r, 50, a0, 51, a1];
const LWPOLY = (closed: boolean, pts: [number, number, number?][]) => [0, 'LWPOLYLINE', 8, '0', 90, pts.length, 70, closed ? 1 : 0, ...pts.flatMap(([x, y, b]) => [10, x, 20, y, ...(b ? [42, b] : [])])];
const TEXT = () => [0, 'TEXT', 8, '0', 10, 0, 20, 0, 30, 0, 40, 2, 1, 'hello'];

describe('DXF import', () => {
  it('joins loose lines and arcs into closed outlines and keeps circles', () => {
    const r = importDxf(
      dxf(4, [
        LINE(0, 0, 50, 0), LINE(50, 30, 50, 0), LINE(50, 30, 0, 30), LINE(0, 0, 0, 30), // a rectangle, lines in any order and direction
        CIRCLE(25, 15, 5),
        // a slot: two lines and two half circles
        LINE(10, 5, 20, 5), ARC(20, 8, 3, 270, 90), LINE(20, 11, 10, 11), ARC(10, 8, 3, 90, 270),
        TEXT(),
      ]),
    );
    expect(r.units).toBe('mm');
    expect(r.paths.filter((p) => p.closed)).toHaveLength(3);
    const areas = r.paths.map((p) => Math.abs(area(p.pts))).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(Math.PI * 25, 0); // circle
    expect(areas[1]).toBeCloseTo(10 * 6 + Math.PI * 9, 0); // slot
    expect(areas[2]).toBeCloseTo(1500, 3); // rectangle
    expect(r.notes.join()).toMatch(/1 TEXT entity skipped/);
  });

  it('reads polyline bulges and converts inches', () => {
    // a D shape: 1 in straight edge, half circle back (bulge 1 = 180°)
    const r = importDxf(dxf(1, [LWPOLY(true, [[0, 0, 1], [1, 0, 0]])]));
    expect(r.units).toBe('inches');
    expect(Math.abs(area(r.paths[0]!.pts))).toBeCloseTo((Math.PI * 12.7 ** 2) / 2, 0);
    const ys = r.paths[0]!.pts.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-12.7, 2); // bulge > 0: counter-clockwise from (0,0) to (1,0) goes below
  });
});

describe('SVG import', () => {
  it('reads sizes in mm via the viewBox and turns y up', () => {
    const r = importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 200 100"><rect x="20" y="20" width="40" height="20"/></svg>');
    const xs = r.paths[0]!.pts.map((p) => p[0]);
    const ys = r.paths[0]!.pts.map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([10, 30]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([30, 40]); // y 20–40 px from the top of 100 → 30–40 mm from the bottom
  });

  it('flattens paths with curves and arcs, and applies group transforms', () => {
    const sub = parsePathData('M0 0 L10 0 A5 5 0 0 1 10 10 L0 10 Z');
    expect(sub).toHaveLength(1);
    expect(sub[0]!.closed).toBe(true);
    expect(Math.abs(area(sub[0]!.pts))).toBeCloseTo(100 + (Math.PI * 25) / 2, 0);
    expect(parseTransform('translate(5,2) scale(2)')).toEqual([2, 0, 0, 2, 5, 2]);
    const r = importSvg('<svg width="10mm" height="10mm" viewBox="0 0 10 10"><g transform="translate(2,0)"><circle cx="3" cy="5" r="1"/></g><defs><rect width="9" height="9"/></defs></svg>');
    expect(r.paths).toHaveLength(1);
    const xs = r.paths[0]!.pts.map((p) => p[0]);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(5, 3);
  });
});

describe('lathe profiles from drawings', () => {
  const full = { id: 's1', name: 'shaft', at: { x: 0, y: 0 }, paths: [{ closed: true, pts: [[30, -5], [30, 5], [18, 5], [18, 8], [0, 8], [0, -8], [18, -8], [18, -5]] as [number, number][] }] };
  const expected = [{ d: 0, z: 0 }, { d: 10, z: 0 }, { d: 10, z: -12 }, { d: 16, z: -12 }, { d: 16, z: -30 }];
  const near = (got: { d: number; z: number }[]) => expect(got.map((p) => [Number(p.d.toFixed(6)), Number(p.z.toFixed(6))])).toEqual(expected.map((p) => [p.d, p.z]));

  it('reads a full side view (axis through the middle)', () => {
    const r = profileFromDrawing(full);
    near(r.points);
    expect(r.notes.join()).toMatch(/full side view/);
  });

  it('reads a half profile drawn on the axis, and a face on the left', () => {
    near(profileFromDrawing({ ...full, paths: [{ closed: true, pts: [[30, 0], [30, 5], [18, 5], [18, 8], [0, 8], [0, 0]] }] }).points);
    const mirrored = { ...full, paths: [{ closed: true, pts: full.paths[0]!.pts.map(([x, y]) => [100 - x, y] as [number, number]) }] };
    near(profileFromDrawing(mirrored, 'left').points);
  });

  it('turns a drawn part on the lathe', () => {
    const base = EXAMPLES.lathe();
    const j = Job.parse({ ...base, shapes: [full], operations: [{ type: 'lathe_profile', tool: 1, shape: 's1' }] });
    const a = analyze(j);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const m = a.material as unknown as { r: Float32Array; z0: number; dz: number };
    const r = (z: number) => m.r[Math.floor((z - m.z0) / m.dz)]!;
    expect(r(-6)).toBeCloseTo(5, 1);
    expect(r(-20)).toBeCloseTo(8, 1);
  });
});

describe('importing into a job', () => {
  it('places a drawing that does not fit at a margin, and pockets it', () => {
    const job = EXAMPLES.mill();
    const { shape, notes } = importDrawing('part.dxf', dxf(4, [CIRCLE(-100, -100, 10)]), job);
    expect(shape.at.x).toBeCloseTo(115, 2);
    expect(shape.at.y).toBeCloseTo(115, 2);
    expect(notes.join()).toMatch(/5 mm in from the stock corner/);
    const j = Job.parse({ ...job, shapes: [shape], operations: [{ type: 'mill_pocket', tool: 1, shape: shape.id, zBottom: -2, zTop: 0.5 }] });
    const a = analyze(j);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const m = a.material as MillMaterial;
    expect(m.h[Math.floor(15 / m.cell) * m.nx + Math.floor(15 / m.cell)]).toBeCloseTo(-2, 3);
  });
});
