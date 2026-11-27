// check.ts on its own, before anything else and without the barrel: if an import cycle ran
// through generate.ts, something would be used before its module had finished loading.
import { analyze } from '../src/check.ts';
import { EXAMPLES } from '../src/presets.ts';
import { describe, expect, it } from 'vitest';

describe('check.ts without the barrel', () => {
  it('analyzes an example job', () => {
    const a = analyze(EXAMPLES.lathe());
    expect(a.program.segments.length).toBeGreaterThan(0);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
