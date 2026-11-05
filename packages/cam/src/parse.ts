/**
 * Reads G-code back into moves, for previewing files from elsewhere and for round-trip tests.
 * Understands the same boring subset the emitter writes (plus G20 inches and G91 incremental);
 * anything else is reported, not guessed at.
 */
import type { Move } from './program.ts';
import type { MachineKind, Vec3 } from './schema.ts';

export interface ParsedMove {
  move: Move;
  /** 0-based source line. */
  line: number;
  /** Tool number active (last T word), 0 if none. */
  tool: number;
}

export interface Parsed {
  start: Vec3;
  moves: ParsedMove[];
  warnings: { line: number; message: string }[];
}

const SUPPORTED_G = new Set(['0', '1', '2', '3', '4', '7', '8', '33', '17', '18', '20', '21', '54', '90', '91', '94', '90.1', '91.1']);
const SUPPORTED_M = new Set(['0', '1', '2', '3', '4', '5', '6', '8', '9', '30']);

/**
 * @param kind lathe programs are read in the XZ plane with X as a diameter (G7) unless G8 appears.
 */
export function parseGcode(text: string, kind: MachineKind): Parsed {
  const warnings: Parsed['warnings'] = [];
  const moves: ParsedMove[] = [];
  const lathe = kind === 'lathe';
  let diameter = lathe; // G7 default for lathe programs
  let scale = 1;
  let absolute = true;
  let motion = 0;
  let feed = 0;
  let tool = 0;
  let plane = lathe ? 18 : 17;
  const pos: Vec3 = { x: 0, y: 0, z: 0 };
  let start: Vec3 | null = null;

  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const code = lines[ln]!.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
    if (!code || code === '%') continue;
    const words = [...code.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)].map((m) => ({ l: m[1]!, v: m[2]! }));
    const val: Partial<Record<string, number>> = {};
    let motionHere: number | null = null;
    let dwell = false;
    for (const w of words) {
      if (w.l === 'G') {
        const g = String(Number(w.v));
        if (!SUPPORTED_G.has(g)) warnings.push({ line: ln, message: `G${g} is not supported` });
        switch (g) {
          case '0':
          case '1':
          case '2':
          case '3':
          case '33':
            motionHere = Number(g);
            break;
          case '4':
            dwell = true;
            break;
          case '7':
            diameter = true;
            break;
          case '8':
            diameter = false;
            break;
          case '17':
          case '18':
            plane = Number(g);
            break;
          case '20':
            scale = 25.4;
            break;
          case '21':
            scale = 1;
            break;
          case '90':
            absolute = true;
            break;
          case '91':
            absolute = false;
            break;
        }
      } else if (w.l === 'M') {
        const m = String(Number(w.v));
        if (!SUPPORTED_M.has(m)) warnings.push({ line: ln, message: `M${m} is not supported` });
      } else if (w.l === 'T') tool = Number(w.v);
      else val[w.l] = Number(w.v);
    }
    if (val.F !== undefined) feed = val.F * scale;
    if (dwell) continue;
    if (motionHere !== null) motion = motionHere;
    const has = val.X !== undefined || val.Y !== undefined || val.Z !== undefined;
    if (!has) continue;

    const xIn = (x: number) => ((lathe && diameter ? x / 2 : x) * scale);
    const to: Vec3 = { ...pos };
    if (val.X !== undefined) to.x = absolute ? xIn(val.X) : pos.x + xIn(val.X);
    if (val.Y !== undefined) to.y = absolute ? val.Y * scale : pos.y + val.Y * scale;
    if (val.Z !== undefined) to.z = absolute ? val.Z * scale : pos.z + val.Z * scale;
    if (lathe) to.y = 0;

    if (!start) {
      // the first positioning move only sets where we are
      start = { ...to };
      Object.assign(pos, to);
      continue;
    }
    let move: Move;
    if (motion === 33) {
      const pitch = (val.K ?? 0) * scale;
      if (!pitch) warnings.push({ line: ln, message: 'G33 without K (pitch)' });
      moves.push({ move: { type: 'thread', to, pitch, f: 0 }, line: ln, tool });
      Object.assign(pos, to);
      continue;
    }
    if (motion === 0) move = { type: 'rapid', to };
    else if (motion === 1) move = { type: 'feed', to, f: feed };
    else {
      if (plane !== 17 && plane !== 18) {
        warnings.push({ line: ln, message: 'arcs are only read in the XY (G17) and ZX (G18) planes; drawn as a line' });
        move = { type: 'feed', to, f: feed };
      } else if (val.R !== undefined) {
        warnings.push({ line: ln, message: 'R-format arcs are not supported; drawn as a line' });
        move = { type: 'feed', to, f: feed };
      } else if (plane === 18) {
        // I stays a radius in diameter mode
        const center: Vec3 = { x: pos.x + (val.I ?? 0) * scale, y: to.y, z: pos.z + (val.K ?? 0) * scale };
        move = { type: 'arc', to, center, cw: motion === 2, f: feed, plane: 'zx' };
      } else {
        const center: Vec3 = { x: pos.x + (val.I ?? 0) * scale, y: pos.y + (val.J ?? 0) * scale, z: to.z };
        move = { type: 'arc', to, center, cw: motion === 2, f: feed };
      }
    }
    if (move.type !== 'rapid' && !feed) warnings.push({ line: ln, message: 'feed move without a feed rate' });
    moves.push({ move, line: ln, tool });
    Object.assign(pos, to);
  }
  return { start: start ?? { x: 0, y: 0, z: 0 }, moves, warnings };
}
