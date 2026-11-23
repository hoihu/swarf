/**
 * A corpus of real mill parts, each a job file in parts/mill/ that opens in the app (its notes
 * say what the part is). For every part: the checks pass, the G-code is pinned in
 * parts/mill/<name>.nc (a change to the generator or the emitter shows up in review as a diff of
 * real programs), the G-code reads back as the program's own moves, and the material model ends
 * up at the drawing's heights and depths.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze, emit, openJobFile, parseGcode, walk, type MillMaterial, type Move } from '../src/index.ts';

const TOL = 0.005; // 5 µm

interface Part {
  name: string;
  /** Warning codes the checks are expected to give (errors are never expected). */
  warnings: string[];
  /** Finished top of the material at X Y, through the material model. */
  heights: { x: number; y: number; z: number; what: string }[];
}

const PARTS: Part[] = [
  {
    name: 'bracket',
    // drilled and cut through into the sacrificial board under the plate, as the notes say
    warnings: ['BELOW_STOCK', 'BELOW_STOCK'],
    heights: [
      { x: 10, y: 10, z: -5.5, what: 'hole drilled through' },
      { x: 40, y: 2, z: -5.5, what: 'outline cut through' },
      { x: 25, y: 2, z: -4.8, what: 'holding tab, 1 mm above the cut' },
    ],
  },
  {
    name: 'pocket-island',
    warnings: [],
    heights: [
      { x: 25, y: 20, z: 0, what: 'top of the boss' },
      { x: 14, y: 14, z: -3, what: 'pocket floor' },
      { x: 5, y: 5, z: 0, what: 'outside the pocket' },
    ],
  },
  {
    name: 'nameplate',
    warnings: [],
    heights: [
      { x: 30, y: 3, z: 0, what: 'skimmed top' },
      // 0.1 in from the edge of a 0.5 chamfer (the engraving's 0.2 is pinned by the G-code read-back:
      // the material model's cell centres do not fall on the strokes' centre lines)
      { x: 0.1, y: 10, z: -0.4, what: 'top edge chamfered' },
    ],
  },
  {
    name: 'tapped-block',
    warnings: [],
    heights: [
      { x: 5, y: 5, z: 0, what: 'faced top' },
      { x: 15, y: 15, z: -13, what: 'core hole depth' },
    ],
  },
];

const read = (name: string) => openJobFile(readFileSync(new URL(`parts/mill/${name}.json`, import.meta.url), 'utf8'));
const near = (a: number, b: number) => Math.abs(a - b) < TOL;

describe.each(PARTS)('mill part: $name', (part) => {
  const job = read(part.name);
  const a = analyze(job);
  const { text, lineOfMove } = emit(job, a.program);

  it('passes the checks, with only the expected warnings', () => {
    expect(job.machine.kind).toBe('mill');
    expect(job.notes).toBeTruthy();
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(a.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code)).toEqual(part.warnings);
  });

  it('writes the pinned G-code', async () => {
    await expect(text).toMatchFileSnapshot(`parts/mill/${part.name}.nc`);
  });

  it('reads back as the program, within 5 µm', () => {
    const parsed = parseGcode(text, 'mill');
    expect(parsed.warnings).toEqual([]);
    const byLine = new Map(parsed.moves.map((p) => [p.line, p.move]));
    // where the tool is after a line: the last move read at or before it
    const at = (line: number) => parsed.moves.findLast((p) => p.line <= line)?.move.to ?? parsed.start;
    const used = new Set<number>();
    let i = 0;
    for (const { move } of walk(a.program)) {
      const line = lineOfMove[i++]!;
      const back = byLine.get(line);
      const where = `move ${i - 1}, line ${line + 1}: ${text.split('\n')[line]}`;
      if (back && !used.has(line)) {
        used.add(line);
        expect(same(back, move), where).toBe(true);
      } else {
        // a move to where the tool already is is not written: it shares the line before
        const p = at(line);
        expect(near(p.x, move.to.x) && near(p.y, move.to.y) && near(p.z, move.to.z), where).toBe(true);
      }
    }
    // the rest are the tool changes' way out to the home position
    const home = a.program.home;
    for (const p of parsed.moves.filter((m) => !used.has(m.line))) {
      expect(p.move.type).toBe('rapid');
      expect(near(p.move.to.z, home.z) || (near(p.move.to.x, home.x) && near(p.move.to.y, home.y)), `line ${p.line + 1}`).toBe(true);
    }
  });

  it('cuts to the finished heights', () => {
    const m = a.material as MillMaterial;
    const top = (x: number, y: number) => m.h[Math.floor(y / m.cell) * m.nx + Math.floor(x / m.cell)]!;
    for (const h of part.heights) expect(top(h.x, h.y), `${h.what} at X${h.x} Y${h.y}`).toBeCloseTo(h.z, 2);
  });
});

function same(p: Move, q: Move): boolean {
  if (p.type !== q.type || !near(p.to.x, q.to.x) || !near(p.to.y, q.to.y) || !near(p.to.z, q.to.z)) return false;
  if (p.type === 'arc' && q.type === 'arc') return p.cw === q.cw && near(p.center.x, q.center.x) && near(p.center.y, q.center.y);
  return true;
}
