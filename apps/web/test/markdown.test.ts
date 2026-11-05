import { describe, expect, it } from 'vitest';
import { miniMarkdown } from '../src/lib/markdown.ts';

describe('chat markdown', () => {
  it('renders paragraphs, lists, bold and code, and escapes HTML', () => {
    expect(miniMarkdown('Hi **there** <b>x</b>\n\n- one\n- `G33`')).toBe('<p>Hi <strong>there</strong> &lt;b&gt;x&lt;/b&gt;</p><ul><li>one</li><li><code>G33</code></li></ul>');
    expect(miniMarkdown('Two warnings:\n- a\n- b')).toBe('<p>Two warnings:</p><ul><li>a</li><li>b</li></ul>');
  });
});
