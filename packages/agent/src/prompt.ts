/**
 * System prompt (static, cacheable) and the per-turn job state that travels with each user message.
 */
import { analyze, opLabel, type Job } from '@swarf/cam';
import { formatDiagnostics } from './tools.ts';

/** How to build jobs: shared by the in-app agent and the MCP instructions for Claude Code. */
export const CAM_GUIDE = `Conventions:
- Units are millimetres. Lathe: sizes are diameters, Z0 is the finished front face, negative Z goes towards the chuck; the stock's raw face is a little in front of Z0 (stock.front). Mill: X0 Y0 is the stock's front-left corner, Z0 the top after facing, negative Z goes down.
- Use the tool table as it is. If an operation needs a tool that is not there, ask the user or describe what is missing; add a tool with set_tool only when the user has told you about it.
- Speeds and feeds come from the tool's cutting data; override rpm/feed only for a reason (the user asked, or the material calls for it).

How to build a job:
- Order operations as a machinist would: face first, then rough and finish the outside from the face towards the chuck, chamfers and grooves, threads, drilling on centre, parting off last. On the mill: face, then pockets and contours, then holes.
- For a stepped shaft, one lathe_turn per diameter: the step nearest the face is the smallest; each later turn starts where the previous one ended (zStart) and says what diameter is there now (fromDiameter).
- Leave the part length plus the parting blade width before the chuck; keep everything clear of the chuck jaws.
- Threads: turn the major diameter first (slightly under nominal, e.g. Ø9.85 for M10), then lathe_thread with the pitch (metric coarse: M6 1, M8 1.25, M10 1.5, M12 1.75, M16 2), then chamfer and part off. There is no pull-out at the end of a pass: end the thread at a groove or leave room before a shoulder. Threading needs a controller with spindle sync; if the check says it is off, tell the user rather than working around it.
- Every edit answers with the checks. Errors must be fixed before you finish; warnings you can leave if they are intended (say so).
- If the request is ambiguous in a way that changes the part (a missing dimension, inside or outside, which end), ask one question rather than guess. Do not ask about things you can decide sensibly (number of passes, clearances).`;

export const SYSTEM_PROMPT = `You are the CAM agent inside swarf, a browser app that turns a machinist's description of a part into G-code for a hobby CNC lathe or mill running grblHAL. You never write G-code yourself: you build the job from parametric operations with tools, and a deterministic generator turns them into toolpaths, checks them (machine travel, chuck, rapids into material, depth of cut) and writes a deliberately simple G-code subset. The user sees a 3D preview and the G-code and runs it themselves.

${CAM_GUIDE}
- To ask, call ask_user with 2–5 concrete options; it ends your turn.

Finish with a short reply (2–4 sentences): what the job does now, anything the user should know before running it (assumptions, warnings left, tool changes). The user sees the operation list and the G-code, so do not repeat every value.`;

function stockText(job: Job): string {
  const s = job.stock;
  return s.kind === 'bar' ? `bar Ø${s.diameter}, ${s.stickout} mm out of the chuck, raw face at Z${s.front}` : `block ${s.x}×${s.y}×${s.z}, raw top at Z${s.top}`;
}

export function formatJobContext(job: Job): string {
  const m = job.machine;
  const a = analyze(job);
  const lines = ['<job_state>'];
  lines.push(`job: ${job.name}`);
  lines.push(
    `machine: ${m.name} (${m.kind}), spindle ${m.minRpm}–${m.maxRpm} rpm, feed ≤ ${m.maxFeed} mm/min, travel X${m.envelope.min.x}..${m.envelope.max.x}` +
      (m.kind === 'mill' ? ` Y${m.envelope.min.y}..${m.envelope.max.y}` : '') +
      ` Z${m.envelope.min.z}..${m.envelope.max.z}${m.kind === 'lathe' ? ' (X as radius)' : ''}` +
      (m.chuckDiameter ? `, chuck Ø${m.chuckDiameter}` : ''),
  );
  lines.push(`stock: ${stockText(job)}${job.material ? `; material: ${job.material}` : '; material: not given'}`);
  lines.push('tools:');
  for (const t of job.tools) {
    const size = t.diameter ? ` Ø${t.diameter}` : t.width ? ` ${t.width} mm wide` : '';
    lines.push(`  T${t.id} ${t.type}${size}: ${t.name}${t.maxDoc ? `, max ${t.maxDoc} mm/pass` : ''}${t.fluteLength ? `, flutes ${t.fluteLength} mm` : ''}`);
  }
  if (job.operations.length) {
    lines.push('operations:');
    for (const o of job.operations) {
      const { id, type, label, ...rest } = o;
      void label;
      lines.push(`  ${id} ${type}: ${opLabel(o)} ${JSON.stringify(rest)}`);
    }
  } else lines.push('operations: none yet');
  lines.push(formatDiagnostics(a.diagnostics));
  if (a.moves) lines.push(`estimated time: ${Math.round(a.seconds / 6) / 10} min`);
  lines.push('</job_state>');
  return lines.join('\n');
}

export function formatVerification(errors: string): string {
  return `[job verification] The job still has errors. Fix them (or remove the operation and tell the user why), then finish:\n${errors}`;
}
