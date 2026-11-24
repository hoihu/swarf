import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXAMPLES, analyze, emit, lintGcode, type Job } from '../src/index.ts';

const dir = new URL('parts/', import.meta.url);
const golden = [
  ...readdirSync(dir).filter((f) => f.endsWith('.nc')).map((f) => ({ file: f, kind: 'lathe' as const })),
  ...readdirSync(new URL('mill/', dir)).filter((f) => f.endsWith('.nc')).map((f) => ({ file: `mill/${f}`, kind: 'mill' as const })),
];
const gcode = (job: Job) => emit(job, analyze(job).program).text;
const codes = (text: string, kind: 'lathe' | 'mill' = 'lathe') => lintGcode(text, kind).map((d) => `${d.code}@${d.line}`);

const HEAD = 'G21 G90 G94 G54\nG18 G7 G97\n';
const END = 'M5\nM30\n';

describe('lintGcode', () => {
  it('passes every golden part', () => {
    expect(golden.length).toBe(8);
    for (const { file, kind } of golden) expect(lintGcode(readFileSync(new URL(file, dir), 'utf8'), kind), file).toEqual([]);
  });

  it('passes the examples (the lathe in diameter and radius mode)', () => {
    expect(lintGcode(gcode(EXAMPLES.mill()), 'mill')).toEqual([]);
    expect(lintGcode(gcode(EXAMPLES.lathe()), 'lathe')).toEqual([]);
    const radius = EXAMPLES.lathe();
    radius.machine.xMode = 'radius';
    expect(lintGcode(gcode(radius), 'lathe')).toEqual([]);
  });

  it('wants the modes before the first move', () => {
    expect(codes('G21 G90 G54\nG17\nG0 Z5\n' + END, 'mill')).toEqual(['MODE_NOT_SET@3']);
    expect(codes('G21 G90 G94 G54\nG18 G97\nG0 Z5\n' + END)).toEqual(['MODE_NOT_SET@3']);
  });

  it('wants a motion mode before the first move', () => {
    expect(codes(HEAD + 'X10 Z5\n' + END)).toEqual(['NO_MOTION_MODE@3']);
  });

  it('wants a feed before the first cut', () => {
    expect(codes(HEAD + 'S1000 M3\nG1 Z-1\n' + END)).toEqual(['NO_FEED@4']);
  });

  it('wants a pitch on every G33', () => {
    expect(codes(HEAD + 'S300 M3\nG0 X10 Z2\nG33 Z-10\n' + END)).toEqual(['NO_PITCH@5']);
  });

  it('wants the spindle on before a cut, and again after a tool change', () => {
    expect(codes(HEAD + 'G1 Z-1 F100\n' + END)).toEqual(['SPINDLE_OFF@3']);
    expect(codes(HEAD + 'M3\nG1 Z-1 F100\n' + END)).toEqual(['SPINDLE_OFF@4']);
    expect(codes(HEAD + 'S1000 M3\nG1 Z-1 F100\nM0\nG0 Z5\nG1 Z-2\n' + END)).toEqual(['SPINDLE_OFF@7']);
  });

  it('allows only the subset swarf writes', () => {
    expect(codes(HEAD + 'T1 M6\n' + END)).toEqual(['UNSUPPORTED@3', 'UNSUPPORTED@3']);
    expect(codes(HEAD + 'G96 S200\n' + END)).toEqual(['UNSUPPORTED@3']);
    expect(codes('G21 G90 G94 G54\nG17 G18\n' + END, 'mill')).toEqual(['UNSUPPORTED@2']);
    expect(codes(HEAD + 'G1 X1 oops\n' + END)).toEqual(['UNREADABLE@3']);
  });

  it('wants M5 and M30 at the end, and nothing moving after', () => {
    expect(codes(HEAD + 'G0 Z5\nM5\n')).toEqual(['NO_END@4']);
    expect(codes(HEAD + 'S1000 M3\nM30\n')).toEqual(['SPINDLE_ON_AT_END@4']);
    expect(codes(HEAD + 'M5\nM2\nG0 Z5\n')).toEqual(['MOTION_AFTER_END@5']);
  });
});
