import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXAMPLES, analyze, emit, openJobFile, runnable, type Job } from '../src/index.ts';
import { judge } from '../src/pipeline.ts';

const dir = new URL('parts/', import.meta.url);
const GOLDEN = ['stepped-shaft', 'bushing', 'handle', 'grooved-pin', 'mill/bracket', 'mill/nameplate', 'mill/pocket-island', 'mill/tapped-block'];

/** The mill example with a hole far outside the machine's travel. */
function outOfRange(): Job {
  const job = EXAMPLES.mill();
  const drill = job.tools.find((t) => t.type === 'drill')!;
  job.operations.push({ id: 'far', type: 'mill_drill', tool: drill.id, points: [{ x: 500, y: 10 }], zBottom: -5 } as Job['operations'][number]);
  return job;
}

describe('runnable', () => {
  it('refuses a job with a check error and lists it', () => {
    const job = outOfRange();
    const r = runnable(job, analyze(job));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.code)).toContain('OUT_OF_RANGE');
    expect(r).not.toHaveProperty('text');
  });

  it('refuses text the lint finds fault with, saying on which line', () => {
    const r = judge([], { text: 'G21 G90 G94 G54\nG17\nG1 X10 F600\nM5\nM30', lineOfMove: [2] }, 'mill');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => `${e.code}@${e.line}`)).toContain('SPINDLE_OFF@3');
    expect(r.errors.every((e) => e.severity === 'error' && /line \d+/.test(e.message))).toBe(true);
  });

  it('passes clean text through unchanged', () => {
    const emitted = { text: 'G21 G90 G94 G54\nG17\nS1000 M3\nG1 X10 F600\nM5\nM30', lineOfMove: [3] };
    expect(judge([], emitted, 'mill')).toMatchObject({ ok: true, ...emitted });
  });

  it('gives the golden parts their pinned G-code', () => {
    for (const name of GOLDEN) {
      const job = openJobFile(readFileSync(new URL(`${name}.json`, dir), 'utf8'));
      const r = runnable(job, analyze(job));
      expect(r.ok, name).toBe(true);
      if (r.ok) expect(r.text, name).toBe(readFileSync(new URL(`${name}.nc`, dir), 'utf8'));
    }
  });

  it('gives the examples what emit writes', () => {
    for (const job of [EXAMPLES.lathe(), EXAMPLES.mill()]) {
      const a = analyze(job);
      expect(runnable(job, a)).toMatchObject({ ok: true, ...emit(job, a.program) });
    }
  });

  it('from a segment on: the rest, emitted from there', () => {
    const job = EXAMPLES.lathe();
    const a = analyze(job);
    const r = runnable(job, a, { fromSegment: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).not.toBe(emit(job, a.program).text);
  });

  it('from a segment on: errors of operations still to run hold it up', () => {
    const job = outOfRange();
    expect(runnable(job, analyze(job), { fromSegment: 1 }).ok).toBe(false);
  });
});
