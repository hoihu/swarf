import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '@swarf/cam';
import { withWorkMaterial } from '../src/lib/ops.ts';

describe('changing the workpiece material', () => {
  it('drops the grade written for the material before', () => {
    const job = { ...EXAMPLES.mill(), workMaterial: 'plastic' as const, material: 'POM / Acryl' };
    const next = withWorkMaterial(job, 'aluminium');
    expect(next.workMaterial).toBe('aluminium');
    expect(next.material).toBeUndefined();
  });
  it('keeps the grade when the material stays', () => {
    const job = { ...EXAMPLES.mill(), material: '6082' };
    expect(withWorkMaterial(job, job.workMaterial).material).toBe('6082');
  });
});
