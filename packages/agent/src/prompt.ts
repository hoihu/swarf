/**
 * System prompt (static, cacheable) and the per-turn job state that travels with each user message.
 */
import { MATERIALS, analyze, area, bbox, cuttingData, opLabel, profileFromDrawing, type Job } from '@swarf/cam';
import { formatDiagnostics } from './tools.ts';

/** How to build jobs: shared by the in-app agent and the MCP instructions for Claude Code. */
export const CAM_GUIDE = `Conventions:
- Units are millimetres. Lathe: sizes are diameters, Z0 is the finished front face, negative Z goes towards the chuck; the stock's raw face is a little in front of Z0 (stock.front). Mill: X0 Y0 is the stock's front-left corner, Z0 the top after facing, negative Z goes down.
- Use the tool table as it is. If an operation needs a tool that is not there, ask the user or describe what is missing; add a tool with set_tool only when the user has told you about it.
- Speeds, feeds and depth per pass come from the workpiece material (workMaterial: aluminium, free_cutting_steel, steel, stainless, brass, plastic) and the tool (HSS or carbide); a tool's own vc, feed or maxDoc override the table. When the user names the material, set it with set_stock (the closest class for workMaterial, the grade in material: e.g. steel + "C45", free_cutting_steel + "1.0718"). If the material is not given, the job assumes aluminium: say so when it matters (steel, stainless). Override rpm/feed on an operation only for a reason (the user asked, a thin part chatters).

How to build a job:
- Order operations as a machinist would: face first, then rough and finish the outside from the face towards the chuck, chamfers and grooves, threads, drilling on centre, parting off last. On the mill: face, then pockets and contours, then holes. A contour that cuts a part free (through the stock) needs tabs so the part does not come loose.
- For an outside shape with several diameters, tapers, chamfers or radii, prefer one lathe_profile: list the corners from the face towards the chuck (start at d 0, z 0 to face too), with c (chamfer) or r (radius) on the corners that have them. Diameters must not get smaller towards the chuck; necks and undercuts are grooves. lathe_turn is for a single plain diameter.
- Leave the part length plus the parting blade width before the chuck; keep everything clear of the chuck jaws.
- Threads: turn the major diameter first (slightly under nominal, e.g. Ø9.85 for M10), then lathe_thread with the pitch (metric coarse: M6 1, M8 1.25, M10 1.5, M12 1.75, M16 2), then chamfer and part off. There is no pull-out at the end of a pass: end the thread at a groove or leave room before a shoulder. Threading needs a controller with spindle sync; if the check says it is off, tell the user rather than working around it. Multi-start threads: starts n with the pitch between crests; the lead is pitch × n (a two-start thread with 3 mm lead is pitch 1.5, starts 2).
- Drawings on the lathe: lathe_profile with shape (and no points) turns a drawing of the part seen from the side, spindle axis horizontal, face on the right (face: left if it is drawn the other way round); a full outline or just the half above the axis. The back face is where it gets parted off.
- Drawings (mill): an imported DXF/SVG is a shape. mill_contour side outside cuts the part out along its outline and cuts its holes too (add tabs when it goes through the stock); side inside runs inside an outline; side on follows the lines (engraving, open paths). mill_pocket clears inside the closed outlines and leaves the outlines inside them standing as islands. Move a drawing on the stock with place_shape. You cannot see the drawing itself, only its summary: if what the user asks does not match it (sizes, number of holes), say so.
- Holes: lathe_drill on centre, then lathe_bore with the boring bar (it needs a hole at least as big as its minimum bore, and reaches only so deep). Internal thread: drill, bore to the minor diameter (D − 1.0825 × pitch, e.g. Ø8.38 for M10), then lathe_thread with side internal and the internal threading bar.
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
  const mat = MATERIALS[job.workMaterial];
  lines.push(`stock: ${stockText(job)}; material: ${job.workMaterial} (${mat.name}${job.material ? `, ${job.material}` : ''}), speeds and feeds from it`);
  lines.push('tools:');
  for (const t of job.tools) {
    const size = t.diameter ? ` Ø${t.diameter}` : t.width ? ` ${t.width} mm wide` : '';
    const c = cuttingData(t, job.workMaterial);
    const feed = t.type === 'endmill' ? `${c.feed} mm/tooth` : t.type === 'threading' ? '' : `${c.feed} mm/rev`;
    const data = [`vc ${c.vc} m/min`, feed, t.type === 'drill' || t.type === 'threading' ? '' : `${c.doc} mm/pass`].filter(Boolean).join(', ');
    lines.push(`  T${t.id} ${t.type}${size}: ${t.name}; ${data}${c.fromTool.vc || c.fromTool.feed || c.fromTool.doc ? ' (partly set on the tool)' : ''}${t.fluteLength ? `; flutes ${t.fluteLength} mm` : ''}`);
  }
  if (job.shapes.length) {
    lines.push(`drawings (imported; refer to them by id in ${job.machine.kind === 'lathe' ? 'lathe_profile shape' : 'mill_contour / mill_pocket'}):`);
    for (const sh of job.shapes) {
      if (job.machine.kind === 'lathe') {
        // what lathe_profile would read from it, which is what the user means by "the part"
        try {
          const { points, notes } = profileFromDrawing(sh);
          const ds = points.map((p) => p.d).filter((d) => d > 0);
          const len = -Math.min(...points.map((p) => p.z));
          lines.push(`  ${sh.id} ${sh.name}: as a turned part (face on the right): Ø${Math.min(...ds).toFixed(2)}–Ø${Math.max(...ds).toFixed(2)}, ${len.toFixed(2)} mm long from the face, ${points.length} profile points. ${notes.join(' ')}`);
        } catch (e) {
          lines.push(`  ${sh.id} ${sh.name}: cannot be read as a turned part (${e instanceof Error ? e.message : String(e)})`);
        }
        continue;
      }
      const b = bbox(sh.paths.map((p) => p.pts.map(([x, y]) => [x + sh.at.x, y + sh.at.y] as [number, number])))!;
      const closed = sh.paths.filter((p) => p.closed);
      const open = sh.paths.length - closed.length;
      const areas = closed.map((p) => Math.abs(area(p.pts))).sort((a, b) => b - a);
      lines.push(
        `  ${sh.id} ${sh.name}: ${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} mm, on the stock at X${b.minX.toFixed(1)}–${b.maxX.toFixed(1)} Y${b.minY.toFixed(1)}–${b.maxY.toFixed(1)}; ` +
          `${closed.length} closed outline(s)${areas.length ? ` (largest ${areas[0]!.toFixed(0)} mm²${areas.length > 1 ? `, others ${areas.slice(1, 6).map((a) => a.toFixed(0)).join(', ')} mm²` : ''})` : ''}` +
          (open ? `, ${open} open path(s)` : ''),
      );
    }
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
