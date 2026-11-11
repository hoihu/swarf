/**
 * A single-line font for engraving: every glyph a few strokes the cutter follows, drawn on a grid
 * 4 wide and 6 high (capitals), the baseline at 0. Capitals, digits and the signs a part number or
 * a label needs; small letters are drawn as smaller capitals; Ä Ö Ü get their dots.
 */
import type { Pt } from './geom2d.ts';

const O = '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0';
const P = '0,0 0,6 3,6 4,5 4,4 3,3 0,3';
const DOT = '1.8,0 2.2,0 2.2,0.4 1.8,0.4 1.8,0';
const GLYPHS: Record<string, string> = {
  A: '0,0 2,6 4,0; 0.7,2 3.3,2',
  B: '0,0 0,6 2.5,6 3.5,5.5 4,4.5 3.5,3.5 2.5,3 0,3; 2.5,3 3.5,2.5 4,1.5 3.5,0.5 2.5,0 0,0',
  C: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1',
  D: '0,0 0,6 2.5,6 4,4.5 4,1.5 2.5,0 0,0',
  E: '4,6 0,6 0,0 4,0; 0,3 3,3',
  F: '4,6 0,6 0,0; 0,3 3,3',
  G: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,3 2,3',
  H: '0,0 0,6; 4,0 4,6; 0,3 4,3',
  I: '1,0 3,0; 2,0 2,6; 1,6 3,6',
  J: '0,1 1,0 2.5,0 3.5,1 3.5,6',
  K: '0,0 0,6; 4,6 0,2.5; 1.5,3.6 4,0',
  L: '0,6 0,0 4,0',
  M: '0,0 0,6 2,2.5 4,6 4,0',
  N: '0,0 0,6 4,0 4,6',
  O,
  P,
  Q: `${O}; 2.5,1.5 4,0`,
  R: `${P}; 2,3 4,0`,
  S: '4,5 3,6 1,6 0,5 0,4 1,3 3,3 4,2 4,1 3,0 1,0 0,1',
  T: '0,6 4,6; 2,6 2,0',
  U: '0,6 0,1 1,0 3,0 4,1 4,6',
  V: '0,6 2,0 4,6',
  W: '0,6 1,0 2,4 3,0 4,6',
  X: '0,0 4,6; 0,6 4,0',
  Y: '0,6 2,3 4,6; 2,3 2,0',
  Z: '0,6 4,6 0,0 4,0',
  '0': `${O}; 1,1.5 3,4.5`,
  '1': '1,4.5 2,6 2,0; 1,0 3,0',
  '2': '0,5 1,6 3,6 4,5 4,4 0,0 4,0',
  '3': '0,5 1,6 3,6 4,5 4,4 3,3 1.5,3; 3,3 4,2 4,1 3,0 1,0 0,1',
  '4': '3,0 3,6 0,2 4,2',
  '5': '4,6 0,6 0,3.5 3,3.5 4,2.5 4,1 3,0 1,0 0,1',
  '6': '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2.5 3,3.5 1,3.5 0,2.5',
  '7': '0,6 4,6 1.5,0',
  '8': '1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3',
  '9': '0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,3.5 1,2.5 3,2.5 4,3.5',
  '-': '0.5,3 3.5,3',
  '+': '0.5,3 3.5,3; 2,1.5 2,4.5',
  '=': '0.5,2 3.5,2; 0.5,4 3.5,4',
  _: '0,0 4,0',
  '.': DOT,
  ',': '2,0.4 2,0 1.5,-0.8',
  ':': `${DOT}; 1.8,3 2.2,3 2.2,3.4 1.8,3.4 1.8,3`,
  '!': `2,6 2,1.8; ${DOT}`,
  '?': `0,5 1,6 3,6 4,5 4,4 2,2.5 2,1.8; ${DOT}`,
  '/': '0,0 4,6',
  '\\': '0,6 4,0',
  '(': '3,6.5 2,5 2,1 3,-0.5',
  ')': '1,6.5 2,5 2,1 1,-0.5',
  '#': '1.2,0 1.8,6; 2.6,0 3.2,6; 0.3,2 3.9,2; 0.5,4 4.1,4',
  '*': '2,1.5 2,4.5; 0.7,2.2 3.3,3.8; 0.7,3.8 3.3,2.2',
  '%': '0,0 4,6; 0.5,6 0,5.5 0,4.8 0.5,4.3 1.2,4.3 1.7,4.8 1.7,5.5 1.2,6 0.5,6; 2.8,1.7 2.3,1.2 2.3,0.5 2.8,0 3.5,0 4,0.5 4,1.2 3.5,1.7 2.8,1.7',
  '°': '1.5,6 1,5.5 1,5 1.5,4.5 2,4.5 2.5,5 2.5,5.5 2,6 1.5,6',
  'Ø': `${O}; 0,-0.3 4,6.3`,
  "'": '2,6 2,4.8',
  '"': '1.5,6 1.5,4.8; 2.5,6 2.5,4.8',
  '<': '3.5,5 0.5,3 3.5,1',
  '>': '0.5,5 3.5,3 0.5,1',
  '×': '0.7,1 3.3,5; 0.7,5 3.3,1',
};
const DOTS = '0.9,6.9 1.1,6.9 1.1,7.2 0.9,7.2 0.9,6.9; 2.9,6.9 3.1,6.9 3.1,7.2 2.9,7.2 2.9,6.9';
const UMLAUT: Record<string, string> = { Ä: 'A', Ö: 'O', Ü: 'U' };

const parse = (s: string): Pt[][] => s.split(';').map((stroke) => stroke.trim().split(/\s+/).map((p) => p.split(',').map(Number) as Pt));

/** The strokes of one character on the 4 × 6 grid (null: not in the font), and how small it is drawn. */
function glyph(ch: string): { strokes: Pt[][]; scale: number } | null {
  if (ch === 'ß') return null;
  let up = ch.toUpperCase();
  // a small letter: the capital, smaller
  const small = ch !== up && up.length === 1;
  let dots = false;
  if (UMLAUT[up]) {
    dots = true;
    up = UMLAUT[up]!;
  } else if (!GLYPHS[up]) {
    // other accents: the plain letter
    const plain = up.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (GLYPHS[plain]) up = plain;
  }
  const g = GLYPHS[up];
  if (!g) return null;
  return { strokes: [...parse(g), ...(dots ? parse(DOTS) : [])], scale: small ? 0.72 : 1 };
}

export interface TextStrokes {
  /** Polylines, in mm, the baseline along X from the origin. */
  paths: Pt[][];
  width: number;
  /** Characters the font does not have (left out, with their width of space). */
  missing: string[];
}

/**
 * A line of text as strokes. `height`: of the capitals, mm. `spacing`: 1 is normal, more spreads
 * the letters.
 */
export function textStrokes(text: string, height: number, spacing = 1): TextStrokes {
  const u = height / 6;
  const paths: Pt[][] = [];
  const missing: string[] = [];
  let x = 0;
  for (const ch of text.replace(/ß/g, 'ss')) {
    if (ch === ' ') {
      x += 4 * u * spacing;
      continue;
    }
    const g = glyph(ch);
    if (!g) {
      missing.push(ch);
      x += 4 * u * spacing;
      continue;
    }
    const k = u * g.scale;
    for (const s of g.strokes) paths.push(s.map(([px, py]) => [x + px * k, py * k]));
    x += (4 * g.scale + 1.6 * spacing) * u;
  }
  return { paths, width: Math.max(0, x - 1.6 * spacing * u), missing };
}
