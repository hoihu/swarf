import type { Program } from '@swarf/cam';

/**
 * The tool the program has in the spindle at a G-code line (0-based, as the machine reports the
 * line it runs): the tool of the segment that line's move belongs to. Null before the first move
 * or past the last.
 */
export function toolAtLine(program: Program, lineOfMove: number[], line: number): number | null {
  if (line < 0) return null;
  const move = lineOfMove.findIndex((l) => l >= line);
  if (move < 0) return null;
  let n = 0;
  for (const seg of program.segments) {
    n += seg.moves.length;
    if (move < n) return seg.tool;
  }
  return null;
}
