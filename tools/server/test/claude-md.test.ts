import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('CLAUDE.md', () => {
  it('exists at the repo root and names the commands CI runs', () => {
    const text = readFileSync(new URL('../../../CLAUDE.md', import.meta.url), 'utf8');
    for (const cmd of ['npm ci', 'npm run typecheck', 'npm test', 'npm run build']) expect(text).toContain(cmd);
  });
});
