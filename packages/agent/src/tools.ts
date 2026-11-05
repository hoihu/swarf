/**
 * The agent's tools: read the job, edit stock / tools / operations, look at the G-code, ask the
 * user. Every edit is validated with the job schema and answered with the fresh check results,
 * so the model sees the consequences of each step.
 */
import { z } from 'zod';
import {
  Job,
  Operation,
  Stock,
  Tool,
  analyze,
  bbox,
  emit,
  opLabel,
  withIds,
  type Diagnostic,
} from '@swarf/cam';
import type { ToolDefinition } from './types.ts';

/** Where the job lives (the app's store, or a plain variable in tests). */
export interface JobPort {
  get(): Job;
  set(job: Job): void;
}

export interface ToolOutcome {
  /** What the model reads. */
  content: string;
  isError: boolean;
  /** For the chat's activity list. */
  label: string;
  detail: string;
}

export const TOOL_NAMES = {
  getJob: 'get_job',
  setStock: 'set_stock',
  addOp: 'add_operation',
  updateOp: 'update_operation',
  removeOp: 'remove_operation',
  moveOp: 'move_operation',
  setTool: 'set_tool',
  gcode: 'get_gcode',
  placeShape: 'place_shape',
  ask: 'ask_user',
} as const;

export const AskUser = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).min(2).max(5),
});

const SetStockInput = z.object({ stock: Stock, material: z.string().optional().describe('Workpiece material, if the user said') });
const AddOpInput = z.object({
  operation: Operation,
  before: z.string().optional().describe('Insert before this operation id (default: at the end)'),
});
const UpdateOpInput = z.object({
  id: z.string(),
  changes: z.record(z.string(), z.unknown()).describe('Fields to change; null removes an optional field. The type cannot change.'),
});
const RemoveOpInput = z.object({ id: z.string() });
const MoveOpInput = z.object({ id: z.string(), before: z.string().optional().describe('Move before this id (default: to the end)') });
const PlaceShapeInput = z.object({
  id: z.string(),
  x: z.number().describe('X of the drawing\'s left edge on the stock'),
  y: z.number().describe('Y of the drawing\'s bottom edge on the stock'),
});
const SetToolInput = z.object({ tool: Tool.describe('Adds the tool, or replaces the one with the same number') });
const GcodeInput = z.object({ opId: z.string().optional().describe('Only this operation'), maxLines: z.number().int().positive().max(400).default(120) });

function schemaOf(t: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(t, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

export const CAM_TOOLS: ToolDefinition[] = [
  {
    name: TOOL_NAMES.getJob,
    description: 'The whole job as JSON (machine, tools, stock, operations) plus the current check results. The per-turn job state already has a summary; call this for exact values.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: TOOL_NAMES.setStock,
    description: 'Set the raw stock: a bar (lathe) or a block (mill), and optionally the material.',
    input_schema: schemaOf(SetStockInput),
  },
  {
    name: TOOL_NAMES.addOp,
    description:
      'Add an operation. Lathe: lathe_face, lathe_turn, lathe_profile (a whole outline with chamfers and radii, roughed and finished with nose radius compensation), lathe_chamfer, lathe_groove, lathe_bore (boring bar, in a drilled hole), lathe_thread (G33 passes, external or internal), lathe_partoff, lathe_drill (all sizes are diameters, Z0 = finished face, negative Z towards the chuck). ' +
      'Mill: mill_face, mill_pocket_rect, mill_pocket_circle, mill_contour_rect, mill_contour and mill_pocket (an imported drawing, by shape id), mill_drill (X0 Y0 = stock front-left corner, Z0 = top after facing). ' +
      'Speeds and feeds come from the tool table unless you override rpm/feed. Answers with the check results.',
    input_schema: schemaOf(AddOpInput),
  },
  {
    name: TOOL_NAMES.updateOp,
    description: 'Change fields of an operation (e.g. {"diameter": 19.8} or {"stepDown": 1.5}).',
    input_schema: schemaOf(UpdateOpInput),
  },
  { name: TOOL_NAMES.removeOp, description: 'Remove an operation.', input_schema: schemaOf(RemoveOpInput) },
  { name: TOOL_NAMES.moveOp, description: 'Reorder: move an operation before another one, or to the end.', input_schema: schemaOf(MoveOpInput) },
  {
    name: TOOL_NAMES.setTool,
    description: 'Add a tool to the tool table or replace one. Only when the user describes a tool they have; never invent tools silently.',
    input_schema: schemaOf(SetToolInput),
  },
  {
    name: TOOL_NAMES.placeShape,
    description: 'Move an imported drawing on the stock: its extents\' lower-left corner goes to (x, y).',
    input_schema: schemaOf(PlaceShapeInput),
  },
  { name: TOOL_NAMES.gcode, description: 'The generated G-code (one operation, or the start of the program).', input_schema: schemaOf(GcodeInput) },
  {
    name: TOOL_NAMES.ask,
    description: 'Ask the user one question with 2–5 concrete options when a decision has a real trade-off you cannot settle yourself (e.g. which tool, material unknown and it matters). Ends your turn.',
    input_schema: schemaOf(AskUser),
  },
];

export function formatDiagnostics(d: Diagnostic[], limit = 12): string {
  if (!d.length) return 'checks: clean';
  const lines = d.slice(0, limit).map((x) => `  ${x.severity.toUpperCase()} ${x.code}${x.opId ? ` [${x.opId}]` : ''}: ${x.message}`);
  if (d.length > limit) lines.push(`  … ${d.length - limit} more`);
  return `checks: ${d.filter((x) => x.severity === 'error').length} error(s), ${d.filter((x) => x.severity === 'warning').length} warning(s)\n${lines.join('\n')}`;
}

function after(job: Job, what: string): string {
  const a = analyze(job);
  return `${what}\n${formatDiagnostics(a.diagnostics)}\nestimated time: ${Math.round(a.seconds / 6) / 10} min`;
}

const zodMessage = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');

/** Run one CAM tool against the job. Unknown tools return null (the loop handles ask_user itself). */
export function runCamTool(port: JobPort, name: string, input: unknown): ToolOutcome | null {
  const fail = (label: string, msg: string): ToolOutcome => ({ content: msg, isError: true, label, detail: msg });
  const commit = (label: string, next: unknown, what: string): ToolOutcome => {
    const parsed = Job.safeParse(next);
    if (!parsed.success) return fail(label, `Rejected: ${zodMessage(parsed.error)}`);
    const job = { ...parsed.data, operations: withIds(parsed.data.operations) };
    port.set(job);
    return { content: after(job, what), isError: false, label, detail: what };
  };
  const job = port.get();

  switch (name) {
    case TOOL_NAMES.getJob: {
      const a = analyze(job);
      return {
        // drawings as a summary: their points would swamp the answer
        content: JSON.stringify({
          job: { ...job, shapes: job.shapes.map((sh) => ({ id: sh.id, name: sh.name, at: sh.at, paths: sh.paths.map((p) => ({ closed: p.closed, points: p.pts.length })) })) },
          checks: a.diagnostics,
          seconds: Math.round(a.seconds),
        }),
        isError: false,
        label: 'read job',
        detail: `${job.operations.length} operation(s)`,
      };
    }
    case TOOL_NAMES.setStock: {
      const p = SetStockInput.safeParse(input);
      if (!p.success) return fail('stock', `Invalid input: ${zodMessage(p.error)}`);
      const s = p.data.stock;
      const what = s.kind === 'bar' ? `stock: bar Ø${s.diameter}, ${s.stickout} mm out` : `stock: block ${s.x}×${s.y}×${s.z}`;
      return commit('stock', { ...job, stock: s, ...(p.data.material ? { material: p.data.material } : {}) }, what);
    }
    case TOOL_NAMES.addOp: {
      const p = AddOpInput.safeParse(input);
      if (!p.success) return fail('add operation', `Invalid input: ${zodMessage(p.error)}`);
      const ops = withIds([...job.operations, p.data.operation]);
      const added = ops.at(-1)!;
      if (job.operations.some((o) => o.id === added.id)) return fail('add operation', `Id ${added.id} is taken.`);
      const rest = ops.slice(0, -1);
      const at = p.data.before ? rest.findIndex((o) => o.id === p.data.before) : -1;
      if (p.data.before && at < 0) return fail('add operation', `No operation ${p.data.before}.`);
      if (at >= 0) rest.splice(at, 0, added);
      else rest.push(added);
      return commit(`add · ${added.id}`, { ...job, operations: rest }, `added ${added.id}: ${opLabel(added)}`);
    }
    case TOOL_NAMES.updateOp: {
      const p = UpdateOpInput.safeParse(input);
      if (!p.success) return fail('update operation', `Invalid input: ${zodMessage(p.error)}`);
      const i = job.operations.findIndex((o) => o.id === p.data.id);
      if (i < 0) return fail('update operation', `No operation ${p.data.id}.`);
      const old = job.operations[i]!;
      const merged: Record<string, unknown> = { ...old };
      for (const [k, val] of Object.entries(p.data.changes)) {
        if (k === 'type' || k === 'id') continue;
        if (val === null) delete merged[k];
        else merged[k] = val;
      }
      const op = Operation.safeParse(merged);
      if (!op.success) return fail('update operation', `Rejected: ${zodMessage(op.error)}`);
      const ops = [...job.operations];
      ops[i] = op.data;
      return commit(`update · ${old.id}`, { ...job, operations: ops }, `updated ${old.id}: ${opLabel(op.data)}`);
    }
    case TOOL_NAMES.removeOp: {
      const p = RemoveOpInput.safeParse(input);
      if (!p.success) return fail('remove operation', `Invalid input: ${zodMessage(p.error)}`);
      if (!job.operations.some((o) => o.id === p.data.id)) return fail('remove operation', `No operation ${p.data.id}.`);
      return commit(`remove · ${p.data.id}`, { ...job, operations: job.operations.filter((o) => o.id !== p.data.id) }, `removed ${p.data.id}`);
    }
    case TOOL_NAMES.moveOp: {
      const p = MoveOpInput.safeParse(input);
      if (!p.success) return fail('move operation', `Invalid input: ${zodMessage(p.error)}`);
      const op = job.operations.find((o) => o.id === p.data.id);
      if (!op) return fail('move operation', `No operation ${p.data.id}.`);
      const rest = job.operations.filter((o) => o !== op);
      const at = p.data.before ? rest.findIndex((o) => o.id === p.data.before) : -1;
      if (p.data.before && at < 0) return fail('move operation', `No operation ${p.data.before}.`);
      if (at >= 0) rest.splice(at, 0, op);
      else rest.push(op);
      return commit(`move · ${op.id}`, { ...job, operations: rest }, `order: ${rest.map((o) => o.id).join(', ')}`);
    }
    case TOOL_NAMES.setTool: {
      const p = SetToolInput.safeParse(input);
      if (!p.success) return fail('tool', `Invalid input: ${zodMessage(p.error)}`);
      const t = p.data.tool;
      const tools = [...job.tools.filter((x) => x.id !== t.id), t].sort((a, b) => a.id - b.id);
      return commit(`tool · T${t.id}`, { ...job, tools }, `T${t.id}: ${t.name}`);
    }
    case TOOL_NAMES.placeShape: {
      const p = PlaceShapeInput.safeParse(input);
      if (!p.success) return fail('place drawing', `Invalid input: ${zodMessage(p.error)}`);
      const sh = job.shapes.find((x) => x.id === p.data.id);
      if (!sh) return fail('place drawing', `No drawing ${p.data.id}.`);
      const b = bbox(sh.paths.map((q) => q.pts))!;
      const at = { x: p.data.x - b.minX, y: p.data.y - b.minY };
      return commit(`place · ${sh.id}`, { ...job, shapes: job.shapes.map((x) => (x.id === sh.id ? { ...x, at } : x)) }, `${sh.id} now at X${p.data.x} Y${p.data.y}`);
    }
    case TOOL_NAMES.gcode: {
      const p = GcodeInput.safeParse(input ?? {});
      if (!p.success) return fail('G-code', `Invalid input: ${zodMessage(p.error)}`);
      const a = analyze(job);
      const program = p.data.opId ? { ...a.program, segments: a.program.segments.filter((s) => s.opId === p.data.opId) } : a.program;
      if (p.data.opId && !program.segments.length) return fail('G-code', `No generated operation ${p.data.opId}.`);
      const lines = emit(job, program).text.split('\n');
      const shown = lines.slice(0, p.data.maxLines);
      const more = lines.length - shown.length;
      return { content: shown.join('\n') + (more > 0 ? `\n… ${more} more lines` : ''), isError: false, label: `G-code${p.data.opId ? ` · ${p.data.opId}` : ''}`, detail: `${lines.length} lines` };
    }
    default:
      return null;
  }
}
