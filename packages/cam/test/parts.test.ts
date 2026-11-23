/**
 * A corpus of real lathe parts, each a job file in parts/ that opens in the app (its notes say
 * what the part is). For every part: the checks pass, the G-code is pinned in parts/<name>.nc
 * (a change to the generator or the emitter shows up in review as a diff of real programs), the
 * G-code reads back as the program's own moves, and the material model ends up at the drawing's
 * sizes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze, emit, openJobFile, parseGcode, walk, type LatheMaterial, type Move } from '../src/index.ts';

const TOL = 0.005; // 5 µm

interface Part {
  name: string;
  /** Warning codes the checks are expected to give (errors are never expected). */
  warnings: string[];
  /** Finished diameters at a Z, through the material model. */
  sizes: { z: number; d?: number; bore?: number }[];
}

const PARTS: Part[] = [
  {
    name: 'stepped-shaft',
    // threading at full speed would outrun Z on the 1.25 mm lead: the rpm is lowered, and said
    warnings: ['SPEED_LIMIT'],
    sizes: [
      { z: -5, d: 7.85 }, // M8 major Ø, turned before threading
      { z: -13.5, d: 6.4 }, // the groove the thread runs out in
      { z: -20, d: 12 },
      { z: -35, d: 16 },
    ],
  },
  { name: 'bushing', warnings: [], sizes: [{ z: -10, d: 25, bore: 14 }] },
  { name: 'handle', warnings: [], sizes: [{ z: -10, d: 16 }, { z: -54, d: 18 }] },
  { name: 'grooved-pin', warnings: [], sizes: [{ z: -10, d: 12 }, { z: -25, d: 10 }] },
];

const read = (name: string) => openJobFile(readFileSync(new URL(`parts/${name}.json`, import.meta.url), 'utf8'));
const near = (a: number, b: number) => Math.abs(a - b) < TOL;

describe.each(PARTS)('lathe part: $name', (part) => {
  const job = read(part.name);
  const a = analyze(job);
  const { text, lineOfMove } = emit(job, a.program);

  it('passes the checks, with only the expected warnings', () => {
    expect(job.machine.kind).toBe('lathe');
    expect(job.notes).toBeTruthy();
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(a.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code)).toEqual(part.warnings);
  });

  it('writes the pinned G-code', async () => {
    await expect(text).toMatchFileSnapshot(`parts/${part.name}.nc`);
  });

  it('reads back as the program, within 5 µm', () => {
    const parsed = parseGcode(text, 'lathe');
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
        expect(near(p.x, move.to.x) && near(p.z, move.to.z), where).toBe(true);
      }
    }
    // the rest are the tool changes' way out to the home position
    const home = a.program.home;
    for (const p of parsed.moves.filter((m) => !used.has(m.line))) {
      expect(p.move.type).toBe('rapid');
      expect(near(p.move.to.x, home.x) || near(p.move.to.z, home.z), `line ${p.line + 1}`).toBe(true);
    }
  });

  it('turns to the finished sizes', () => {
    const m = a.material as LatheMaterial;
    for (const s of part.sizes) {
      if (s.d !== undefined) expect(2 * m.radiusAt(s.z), `Ø at Z${s.z}`).toBeCloseTo(s.d, 2);
      if (s.bore !== undefined) expect(2 * m.boreAt(s.z), `bore at Z${s.z}`).toBeCloseTo(s.bore, 2);
    }
  });
});

function same(p: Move, q: Move): boolean {
  if (p.type !== q.type || !near(p.to.x, q.to.x) || !near(p.to.z, q.to.z)) return false;
  if (p.type === 'arc' && q.type === 'arc') return p.cw === q.cw && near(p.center.x, q.center.x) && near(p.center.z, q.center.z);
  if (p.type === 'thread' && q.type === 'thread') return near(p.pitch, q.pitch);
  return true;
}
