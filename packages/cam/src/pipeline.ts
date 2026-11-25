/**
 * The one gate between a job and G-code that may leave the program (download, save to a file, Run
 * on the machine, the agent's and the MCP client's `get_gcode`): the checks' errors and the lint's
 * findings on the emitted text both block. Nothing else hands out text to be run.
 */
import { errorsOf, resumeFrom, type Analysis } from './check.ts';
import { emit, type Emitted } from './emit.ts';
import type { Diagnostic } from './generate.ts';
import { lintGcode } from './lint-gcode.ts';
import type { Job, MachineKind } from './schema.ts';

declare const passed: unique symbol;
/** G-code that passed the checks and the lint; only `runnable` makes one. */
export interface Runnable extends Emitted {
  ok: true;
  readonly [passed]: true;
}
/** What holds a program up: a check error, or a lint finding with the (1-based) line it is on. */
export type Blocker = Diagnostic & { severity: 'error'; line?: number };
export interface Refused {
  ok: false;
  errors: Blocker[];
}

/**
 * The job's G-code, or why there is none. `fromSegment`: the rest of the program from that segment
 * on (see `resumeFrom`); errors of operations before it, taken as done, do not hold it up.
 */
export function runnable(job: Job, analysis: Analysis, o: { fromSegment?: number } = {}): Runnable | Refused {
  const seg = o.fromSegment ?? 0;
  if (seg <= 0) return judge(errorsOf(analysis.diagnostics), emit(job, analysis.program), job.machine.kind);
  const rest = resumeFrom(job, analysis.program, seg);
  // what the generator and the alignment say about operations still to run, and the simulation of the rest
  const done = new Set(analysis.program.segments.slice(0, seg).map((s) => s.opId));
  const found = [...analysis.diagnostics.filter((d) => d.move === undefined && !(d.opId && done.has(d.opId))), ...rest.diagnostics];
  const key = (d: Diagnostic) => `${d.code}|${d.opId ?? ''}|${d.move ?? ''}|${d.message}`;
  const unique = [...new Map(errorsOf(found).map((d) => [key(d), d])).values()];
  return judge(unique, emit(job, rest.program, { fromSegment: seg }), job.machine.kind);
}

/** The emitted text with the check errors found for it: refused if there are any, or if the lint finds something. */
export function judge(errors: Diagnostic[], emitted: Emitted, kind: MachineKind): Runnable | Refused {
  const lint: Blocker[] = lintGcode(emitted.text, kind).map((l) => ({ severity: 'error', code: l.code, line: l.line, message: `G-code line ${l.line}: ${l.message}` }));
  const all = [...(errors as Blocker[]), ...lint];
  if (all.length) return { ok: false, errors: all };
  return { ok: true, text: emitted.text, lineOfMove: emitted.lineOfMove } as Runnable;
}
