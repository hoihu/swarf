/**
 * Program → G-code in a deliberately "boring" subset that grblHAL, LinuxCNC and most other
 * controllers run the same way: G0/G1/G2/G3 (arcs only on the mill, XY plane), G17/G18, G21,
 * G90, G94, G54, G4, G7/G8 (lathe diameter/radius mode), S/M3/M5, M0 for manual tool changes,
 * M30. No cutter compensation, canned cycles, macros or tool length offsets: the generator does
 * all of that, so the preview shows exactly what the machine will do.
 */
import { walk, type Program } from './program.ts';
import type { Job } from './schema.ts';

export interface Emitted {
  text: string;
  /** For each move (in program.walk order), the 0-based line it was written on. */
  lineOfMove: number[];
}

/** 3 decimals, no trailing zeros, never "-0". */
export function num(n: number): string {
  let s = n.toFixed(3).replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}

function stockLine(job: Job): string {
  const s = job.stock;
  return s.kind === 'bar'
    ? `stock: bar Ø${num(s.diameter)}, ${num(s.stickout)} out of the chuck, raw face at Z${num(s.front)}`
    : `stock: block ${num(s.x)} x ${num(s.y)} x ${num(s.z)}, raw top at Z${num(s.top)}, X0 Y0 = front left corner`;
}

const comment = (s: string) => `(${s.replace(/[()]/g, '')})`;

export function emit(job: Job, program: Program): Emitted {
  const lathe = program.kind === 'lathe';
  const dia = lathe && job.machine.xMode === 'diameter';
  const X = (x: number) => (dia ? x * 2 : x);
  const lines: string[] = [];
  const lineOfMove: number[] = [];

  lines.push(comment(`swarf: ${job.name}`));
  lines.push(comment(`${job.machine.name}, ${lathe ? 'lathe' : 'mill'}, mm`));
  lines.push(comment(stockLine(job)));
  if (lathe) lines.push(comment(`X is a ${dia ? 'diameter' : 'radius'}; Z0 = finished front face`));
  lines.push('G21 G90 G94 G54');
  lines.push(lathe ? `G18 ${dia ? 'G7' : 'G8'}` : 'G17');

  // modal state of what has been written
  let motion = '';
  let px: number | null = null;
  let py: number | null = null;
  let pz: number | null = null;
  let pf: number | null = null;

  const axes = (x: number, y: number, z: number, force = false) => {
    const w: string[] = [];
    const ox = num(X(x));
    const oy = num(y);
    const oz = num(z);
    if (force || ox !== (px === null ? null : num(X(px)))) w.push(`X${ox}`);
    if (!lathe && (force || oy !== (py === null ? null : num(py)))) w.push(`Y${oy}`);
    if (force || oz !== (pz === null ? null : num(pz))) w.push(`Z${oz}`);
    px = x;
    py = y;
    pz = z;
    return w;
  };

  const home = program.home;
  lines.push(`G0 ${axes(home.x, home.y, home.z, true).join(' ')}`);
  motion = 'G0';

  let tool: number | null = null;
  let rpm: number | null = null;
  let segIndex = -1;
  for (const { seg, move } of walk(program)) {
    if (seg !== segIndex) {
      segIndex = seg;
      const s = program.segments[seg]!;
      const t = job.tools.find((x) => x.id === s.tool);
      lines.push('');
      lines.push(comment(`${s.opId}: ${s.label}, T${s.tool} ${t?.name ?? ''}`.trim()));
      if (s.tool !== tool) {
        if (tool !== null) {
          lines.push('M5');
          lines.push(`G0 ${axes(home.x, home.y, home.z).join(' ')}`.trim());
          motion = 'G0';
        }
        lines.push(comment(`${tool === null ? 'Load' : 'Change to'} T${s.tool}: ${t?.name ?? '?'}, touch off and press cycle start`));
        lines.push(`M0`);
        tool = s.tool;
        rpm = null;
      }
      if (s.rpm !== rpm) {
        lines.push(`S${s.rpm} M3`);
        if (rpm === null) lines.push('G4 P2');
        rpm = s.rpm;
      }
    }
    const w: string[] = [];
    const code = move.type === 'rapid' ? 'G0' : move.type === 'feed' ? 'G1' : move.cw ? 'G2' : 'G3';
    if (move.type === 'arc') {
      const sx = px ?? 0;
      const sy = py ?? 0;
      w.push(code);
      w.push(...axes(move.to.x, move.to.y, move.to.z, true));
      w.push(`I${num(move.center.x - sx)}`, `J${num(move.center.y - sy)}`);
    } else {
      const a = axes(move.to.x, move.to.y, move.to.z);
      if (!a.length) {
        lineOfMove.push(lines.length - 1);
        continue;
      }
      if (code !== motion) w.push(code);
      w.push(...a);
    }
    if (move.type !== 'rapid' && move.f !== pf) {
      w.push(`F${num(move.f)}`);
      pf = move.f;
    }
    motion = code;
    lineOfMove.push(lines.length);
    lines.push(w.join(' '));
  }

  lines.push('');
  lines.push('M5');
  lines.push(`G0 ${axes(home.x, home.y, home.z).join(' ')}`.trim().replace(/^G0$/, comment('at home')));
  lines.push('M30');
  return { text: lines.join('\n') + '\n', lineOfMove };
}
