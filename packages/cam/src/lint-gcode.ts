/**
 * An independent look at emitted G-code: reads only the text (no Program, no Job), so it catches
 * emitter bugs that share assumptions with check.ts. Program-level and modal-state rules: the
 * modes said before the first move, a feed before the first cut, the spindle on before any cut
 * (and off again after the M0 of a tool change), nothing outside the boring subset emit.ts
 * writes, and an end with M5 and M30 (or M2) and no motion after it.
 */
import type { MachineKind } from './schema.ts';

export interface LintDiagnostic {
  severity: 'error';
  code: string;
  /** 1-based line of the G-code text. */
  line: number;
  message: string;
}

const COMMON_G = ['0', '1', '2', '3', '4', '21', '54', '90', '94'];
const SUBSET_G: Record<MachineKind, Set<string>> = {
  lathe: new Set([...COMMON_G, '7', '8', '18', '33', '97']),
  mill: new Set([...COMMON_G, '17']),
};
const SUBSET_M = new Set(['0', '2', '3', '4', '5', '30']);
const LETTERS: Record<MachineKind, string> = { lathe: 'GMXZIKFSP', mill: 'GMXYZIJFSP' };
/** The modes that must be in force before the first move: [needed one of, what to say]. */
const MODES: Record<MachineKind, [string[], string][]> = {
  lathe: [[['21'], 'G21 (mm)'], [['90'], 'G90 (absolute)'], [['94'], 'G94 (feed per minute)'], [['18'], 'G18 (ZX plane)'], [['7', '8'], 'G7 or G8 (diameter or radius X)'], [['97'], 'G97 (S is rpm)']],
  mill: [[['21'], 'G21 (mm)'], [['90'], 'G90 (absolute)'], [['94'], 'G94 (feed per minute)'], [['17'], 'G17 (XY plane)']],
};
const MOTION = new Set(['0', '1', '2', '3', '33']);

export function lintGcode(text: string, kind: MachineKind): LintDiagnostic[] {
  const out: LintDiagnostic[] = [];
  const err = (line: number, code: string, message: string) => out.push({ severity: 'error', code, line, message });
  const seen = new Set<string>();
  let modesChecked = false;
  let motion = '';
  let feed = 0;
  let rpm = 0;
  let spindle = false;
  let ended = 0; // line of M30/M2
  let last = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const code = lines[i]!.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').replace(/\s+/g, '').toUpperCase();
    if (!code) continue;
    last = ln;
    if (!/^([A-Z][-+]?(\d+\.?\d*|\.\d+))+$/.test(code)) {
      err(ln, 'UNREADABLE', `"${lines[i]!.trim()}" is not a list of words`);
      continue;
    }
    const words = [...code.matchAll(/([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/g)].map((m) => ({ l: m[1]!, v: m[2]! }));
    const val: Partial<Record<string, number>> = {};
    const g: string[] = [];
    const m: string[] = [];
    for (const w of words) {
      if (!LETTERS[kind].includes(w.l)) err(ln, 'UNSUPPORTED', `${w.l}${w.v} is outside the subset swarf writes for the ${kind}`);
      else if (w.l === 'G') {
        const c = String(Number(w.v));
        if (SUBSET_G[kind].has(c)) g.push(c);
        else err(ln, 'UNSUPPORTED', `G${c} is outside the subset swarf writes for the ${kind}`);
      } else if (w.l === 'M') {
        const c = String(Number(w.v));
        if (SUBSET_M.has(c)) m.push(c);
        else err(ln, 'UNSUPPORTED', `M${c} is outside the subset swarf writes`);
      } else val[w.l] = Number(w.v);
    }
    for (const c of g) seen.add(c);
    if (val.F !== undefined) feed = val.F;
    if (val.S !== undefined) rpm = val.S;
    // the motion mode of this line (modal: axis words alone repeat the last one)
    const mg = g.filter((c) => MOTION.has(c)).at(-1);
    if (mg !== undefined) motion = mg;
    const moves = mg !== undefined || 'X' in val || 'Y' in val || 'Z' in val;

    if (ended && moves) err(ln, 'MOTION_AFTER_END', `motion after the program end on line ${ended}`);
    if (moves && !modesChecked) {
      modesChecked = true;
      for (const [need, say] of MODES[kind]) if (!need.some((c) => seen.has(c))) err(ln, 'MODE_NOT_SET', `first move before ${say} is set`);
    }
    // M3/M4 with the S in force (on this line or before) turns it on; M5 and the M0 of a tool change off
    if (m.includes('5') || m.includes('0')) spindle = false;
    if (m.includes('3') || m.includes('4')) spindle = rpm > 0;
    if (moves && !motion) err(ln, 'NO_MOTION_MODE', 'a move before any G0/G1/G2/G3 is said');
    else if (moves && motion !== '0') {
      const what = `G${motion}`;
      if (!spindle) err(ln, 'SPINDLE_OFF', `${what} cuts with the spindle not known to be on (M3/M4 with S > 0)`);
      if (motion === '33') {
        if (!(Number(val.K) > 0)) err(ln, 'NO_PITCH', 'G33 without a pitch K > 0 on the line');
      } else if (!(feed > 0)) err(ln, 'NO_FEED', `${what} with no feed F > 0 set`);
    }
    if (!ended && (m.includes('30') || m.includes('2'))) {
      ended = ln;
      if (spindle) err(ln, 'SPINDLE_ON_AT_END', 'program ends with the spindle on (no M5 before it)');
    }
  }
  if (!ended) err(last, 'NO_END', 'program does not end with M30 or M2');
  return out;
}
