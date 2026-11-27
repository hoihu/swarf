import { describe, expect, it } from 'vitest';
import { analyze, emit, Job, MILL, MILL_TOOLS } from '@swarf/cam';
import { toolAtLine } from '../src/lib/inspindle.ts';

describe('toolAtLine', () => {
  const job = Job.parse({
    name: 't', machine: MILL, tools: MILL_TOOLS, workMaterial: 'aluminium',
    stock: { kind: 'block', x: 60, y: 40, z: 10, top: 0 },
    operations: [
      { id: 'a', type: 'mill_pocket_rect', tool: 1, x: 5, y: 5, w: 20, h: 10, zBottom: -1 },
      { id: 'b', type: 'mill_engrave', tool: 4, text: 'X', x: 40, y: 20, height: 6, depth: 0.2 },
    ],
  });
  const p = analyze(job).program;
  const { text, lineOfMove } = emit(job, p);
  const lines = text.split('\n');

  it('follows the program across a tool change', () => {
    const change = lines.findIndex((l) => l.startsWith('(Change to T4'));
    expect(change).toBeGreaterThan(0);
    expect(toolAtLine(p, lineOfMove, lineOfMove[0]!)).toBe(1);
    expect(toolAtLine(p, lineOfMove, change - 5)).toBe(1);
    expect(toolAtLine(p, lineOfMove, change + 4)).toBe(4);
  });
  it('knows nothing outside the program', () => {
    expect(toolAtLine(p, lineOfMove, -1)).toBeNull();
    expect(toolAtLine(p, lineOfMove, lines.length + 10)).toBeNull();
  });
});
