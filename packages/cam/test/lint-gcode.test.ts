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

  it('wants every arc to end on its circle, from a known start', () => {
    const MILL = 'G21 G90 G94 G54\nG17\nS6000 M3\n';
    // centre X10 Y0 radius 10: ends on it, then 0.1 mm inside it
    expect(codes(MILL + 'G0 X0 Y0 Z1\nG1 Z-1 F300\nG2 X10 Y10 I10 J0\nG2 X19.9 Y0 I0 J-10\n' + END, 'mill')).toEqual(['ARC_RADIUS@7']);
    // the lathe: I is a radius in G7 (X20 is a radius of 10), K along Z
    expect(codes(HEAD + 'S1000 M3\nG0 X0 Z1\nG1 Z0 F100\nG3 X20 Z-10 I0 K-10\nG3 X40.2 Z-20 I0 K-10\n' + END)).toEqual(['ARC_RADIUS@7']);
    expect(codes(MILL + 'G0 Z1\nG2 X10 Y10 I10 J0 F300\n' + END, 'mill')).toEqual(['ARC_NO_START@5']);
  });

  it('wants a G33 pass to move along Z only', () => {
    const T = HEAD + 'S300 M3\nG0 X10 Z2\n';
    expect(codes(T + 'G33 Z2 K1.5\n' + END)).toEqual(['G33_NO_Z@5']);
    expect(codes(T + 'G33 X9 Z-10 K1.5\n' + END)).toEqual(['G33_MOVES_X@5']);
  });

  it('wants sideways rapids on the mill below Z0 no lower than the last retract', () => {
    const MILL = 'G21 G90 G94 G54\nG17\nS6000 M3\nG0 X5 Y5 Z2\nG1 Z-3 F300\nG0 Z2\n';
    expect(codes(MILL + 'X20 Z-1\n' + END, 'mill')).toEqual(['RAPID_LOW@7']);
    expect(codes(MILL + 'Z-1\nY20\n' + END, 'mill')).toEqual(['RAPID_LOW@8']);
    // straight down into the cut, or sideways above Z0, is fine
    expect(codes(MILL + 'X20 Z0.5\nZ-1\n' + END, 'mill')).toEqual([]);
  });

  it('wants M5 and M30 at the end, and nothing moving after', () => {
    expect(codes(HEAD + 'G0 Z5\nM5\n')).toEqual(['NO_END@4']);
    expect(codes(HEAD + 'S1000 M3\nM30\n')).toEqual(['SPINDLE_ON_AT_END@4']);
    expect(codes(HEAD + 'M5\nM2\nG0 Z5\n')).toEqual(['MOTION_AFTER_END@5']);
  });
});
