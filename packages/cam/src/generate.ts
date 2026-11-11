/**
 * Job → Program: one segment per operation, in order. Problems that make an operation
 * impossible become error diagnostics (that operation is then left out); the rest of the job
 * still generates, so the user and the agent see all issues at once.
 */
import { cutting } from './feeds.ts';
import { fitArcs } from './arcfit.ts';
import { generateLathe, latheSpeedDiameter } from './ops/lathe.ts';
import { generateMill } from './ops/mill.ts';
import { latheSafe, millSafeZ } from './ops/context.ts';
import { CamError, v, type Move, type Program, type Segment } from './program.ts';
import { OP_MACHINE, OP_TOOLS, type Job, type Operation, type Tool, type Vec3 } from './schema.ts';

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  opId?: string;
  /** Index into the flattened move list (see program.walk). */
  move?: number;
}

export interface Generated {
  program: Program;
  diagnostics: Diagnostic[];
}

/** Ids for operations that have none ("op1", "op2", …, never reusing one). */
export function withIds(ops: Operation[]): Operation[] {
  const used = new Set(ops.map((o) => o.id).filter(Boolean));
  let n = 1;
  return ops.map((o) => {
    if (o.id) return o;
    while (used.has(`op${n}`)) n++;
    used.add(`op${n}`);
    return { ...o, id: `op${n}` };
  });
}

export function homeOf(job: Job): Vec3 {
  if (job.machine.kind === 'lathe') {
    const s = latheSafe(job);
    return v(s.x + 5, 0, s.z + 20);
  }
  // above the rapids' height, and above everything known to stand on the table
  const over = Math.max(-Infinity, ...job.obstacles.map((o) => o.top)) + job.machine.clearance;
  return v(0, 0, Math.max(millSafeZ(job) + 10, over));
}

/**
 * From where an operation ends to the home position, as moves like any other (so the checks and
 * the preview see them): along Z first (the mill straight up; the lathe away from the chuck, which
 * also draws a boring bar out of its bore), then across.
 */
export function retract(from: Vec3, home: Vec3): Move[] {
  const out: Move[] = [];
  if (Math.abs(from.z - home.z) > 1e-9) out.push({ type: 'rapid', to: v(from.x, from.y, home.z) });
  if (Math.abs(from.x - home.x) > 1e-9 || Math.abs(from.y - home.y) > 1e-9) out.push({ type: 'rapid', to: home });
  return out;
}

export function opLabel(op: Operation): string {
  if (op.label) return op.label;
  switch (op.type) {
    case 'lathe_face':
      return `Face to Z${op.z}`;
    case 'lathe_turn':
      return `Turn Ø${op.diameter} to Z${op.zEnd}`;
    case 'lathe_profile': {
      if (!op.points) return `Profile from ${op.shape ?? 'a drawing'}`;
      const ds = op.points.map((p) => p.d).filter((d) => d > 0);
      return `Profile Ø${Math.min(...ds)}–Ø${Math.max(...ds)} to Z${op.points.at(-1)!.z}`;
    }
    case 'lathe_chamfer':
      return `Chamfer ${op.size}×45° at Ø${op.diameter}`;
    case 'lathe_groove':
      return `Groove Ø${op.diameter} × ${op.width} at Z${op.z}`;
    case 'lathe_partoff':
      return `Part off at Z${op.z}`;
    case 'lathe_thread':
      return `${op.side === 'internal' ? 'Internal thread' : 'Thread'} M${op.diameter}×${op.starts > 1 ? `Ph${op.pitch * op.starts}P${op.pitch}, ${op.starts} starts` : op.pitch} to Z${op.zEnd}`;
    case 'lathe_bore':
      return `Bore Ø${op.diameter} to Z${op.zEnd}`;
    case 'lathe_drill':
      return `Drill ${op.depth} deep on centre`;
    case 'mill_face':
      return `Face to Z${op.z}`;
    case 'mill_pocket_rect':
      return `Pocket ${op.w}×${op.h} to Z${op.zBottom}`;
    case 'mill_pocket_circle':
      return `Circular pocket Ø${op.diameter} to Z${op.zBottom}`;
    case 'mill_contour_rect':
      return `Contour ${op.side} ${op.w}×${op.h} to Z${op.zBottom}`;
    case 'mill_contour':
      return `Contour ${op.side} ${op.shape} to Z${op.zBottom}`;
    case 'mill_pocket':
      return `Pocket ${op.shape} to Z${op.zBottom}`;
    case 'mill_drill':
      return `Drill ${op.points.length} hole(s) to Z${op.zBottom}`;
    case 'mill_slot':
      return `Slot ${op.width ?? 'tool'} wide, X${op.x0} Y${op.y0} to X${op.x1} Y${op.y1}, to Z${op.zBottom}`;
    case 'mill_spot':
      return `Spot ${op.points.length} hole(s) Ø${op.diameter}`;
    case 'mill_chamfer':
      return `Chamfer ${op.size} mm, ${op.side === 'inside' ? 'inside ' : ''}${op.shape ?? (op.diameter !== undefined ? `Ø${op.diameter}` : `${op.w}×${op.h}`)}`;
    case 'mill_engrave':
      return `Engrave "${op.text.length > 24 ? `${op.text.slice(0, 23)}…` : op.text}"`;
    case 'mill_thread':
      return `Thread mill ${op.side === 'external' ? 'external ' : ''}M${op.diameter}×${op.pitch}${op.hand === 'left' ? ' LH' : ''} to Z${op.zBottom}`;
  }
}

/**
 * What sets the surface speed on the mill: the cutter's diameter; for a pointed cutter the
 * diameter it cuts at (a V-bit engraving 0.2 mm deep cuts at well under a millimetre).
 */
function millSpeedDiameter(op: Operation, tool: Tool): number {
  const d = tool.diameter ?? 6;
  if (tool.type !== 'chamfer') return d;
  const tan = Math.tan((((tool.angle ?? 90) / 2) * Math.PI) / 180);
  const tip = tool.tipDiameter ?? 0;
  const at = (depth: number) => Math.min(d, Math.max(1, tip + 2 * depth * tan));
  if (op.type === 'mill_engrave') return at(op.depth);
  if (op.type === 'mill_spot') return Math.min(d, Math.max(1, op.diameter));
  if (op.type === 'mill_chamfer') return at(op.size / tan + op.tipClear);
  return d;
}

export function generate(job: Job): Generated {
  const diagnostics: Diagnostic[] = [];
  const kind = job.machine.kind;
  const stockOk = kind === 'lathe' ? job.stock.kind === 'bar' : job.stock.kind === 'block';
  const program: Program = { kind, home: stockOk ? homeOf(job) : v(0, 0, 0), segments: [] };
  if (!stockOk) {
    diagnostics.push({ severity: 'error', code: 'STOCK_KIND', message: `A ${kind} needs ${kind === 'lathe' ? 'bar' : 'block'} stock.` });
    return { program, diagnostics };
  }

  let at = program.home;
  for (const op of withIds(job.operations)) {
    const opId = op.id!;
    const err = (code: string, message: string) => diagnostics.push({ severity: 'error', code, message, opId });
    if (OP_MACHINE[op.type] !== kind) {
      err('OP_MACHINE', `${op.type} is a ${OP_MACHINE[op.type]} operation; this job is for a ${kind}.`);
      continue;
    }
    const tool = job.tools.find((t) => t.id === op.tool);
    if (!tool) {
      err('TOOL_MISSING', `T${op.tool} is not in the tool table.`);
      continue;
    }
    if (!OP_TOOLS[op.type].includes(tool.type)) {
      err('TOOL_TYPE', `T${tool.id} is a ${tool.type} tool; ${op.type} needs ${OP_TOOLS[op.type].join(' or ')}.`);
      continue;
    }
    const speedD = kind === 'lathe' ? latheSpeedDiameter(op as never, job, tool.diameter) : millSpeedDiameter(op, tool);
    const cut = cutting(tool, job.machine, speedD, { rpm: op.rpm, feed: op.feed }, job.workMaterial);
    if (op.type === 'lathe_thread') {
      if (!job.machine.spindleSync) {
        err('THREAD_SYNC', 'Threading needs spindle-synchronised moves (G33): grblHAL in lathe mode with an index + pulse encoder. If your controller has that, turn on "spindle sync" in the machine settings.');
        continue;
      }
      // the carriage must keep up: lead × rpm within the machine's feed, with margin
      const lead = op.pitch * op.starts;
      const most = Math.floor((job.machine.maxFeed * 0.8) / lead);
      if (cut.rpm > most) {
        cut.notes.push(`spindle ${cut.rpm} rpm lowered to ${most} rpm so Z can follow the ${lead} mm lead`);
        cut.rpm = Math.max(job.machine.minRpm, most);
      }
    }
    for (const n of cut.notes) diagnostics.push({ severity: 'warning', code: 'SPEED_LIMIT', message: n, opId });
    // a tool change happens at home: the tool before goes there first
    const before = program.segments.at(-1);
    if (before && before.tool !== tool.id) {
      before.moves.push(...retract(at, program.home));
      at = program.home;
    }
    try {
      const ctx = { job, tool, cut, from: at, c: job.machine.clearance };
      let moves = kind === 'lathe' ? generateLathe(op as never, ctx) : generateMill(op as never, ctx);
      if (job.machine.arcTolerance > 0) moves = fitArcs(moves, at, job.machine.arcTolerance, 2000, kind === 'lathe' ? 'zx' : 'xy');
      const seg: Segment = { opId, label: opLabel(op), tool: tool.id, rpm: cut.rpm, moves };
      program.segments.push(seg);
      if (moves.length) at = moves.at(-1)!.to;
    } catch (e) {
      if (e instanceof CamError) err('OP_INVALID', e.message);
      else throw e;
    }
  }
  // and home at the end
  program.segments.at(-1)?.moves.push(...retract(at, program.home));
  return { program, diagnostics };
}
