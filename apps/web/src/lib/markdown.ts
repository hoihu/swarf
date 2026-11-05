/** The little markdown models use in chat replies: paragraphs, - lists, **bold**, `code`. Escapes everything else. */
export function miniMarkdown(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      list.push(...lines.map((l) => l.replace(/^\s*[-*] /, '')));
      continue;
    }
    flush();
    // a paragraph that ends in a list
    const first = lines.findIndex((l) => /^\s*[-*] /.test(l));
    if (first > 0 && lines.slice(first).every((l) => /^\s*[-*] /.test(l))) {
      out.push(`<p>${lines.slice(0, first).map(inline).join('<br>')}</p>`);
      list.push(...lines.slice(first).map((l) => l.replace(/^\s*[-*] /, '')));
      continue;
    }
    out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
  }
  flush();
  return out.join('');
}
