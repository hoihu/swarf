/**
 * The setup sheet: what to have ready at the machine before pressing start, on one page. Stock,
 * where the zero is, how the work is held, the tools in the order they are called for with how
 * far each must reach, the operations with speeds and times. All from the job and its analysis.
 */
import { alignmentLines } from './align.ts';
import type { Analysis } from './check.ts';
import { MATERIALS } from './materials.ts';
import { plannedSeconds } from './planner.ts';
import { arcPoints, walk, type Program } from './program.ts';
import type { Job, Tool, Vec3 } from './schema.ts';

export interface SheetTool {
  id: number;
  name: string;
  /** What kind of tool, in a few words. */
  what: string;
  /** How far it must reach, in words ('' when it does not matter). */
  reach: string;
  /** Stored offset against the reference tool, as text ('' when none). */
  offset: string;
  /** Operations it does (their numbers). */
  ops: number[];
  seconds: number;
}

export interface SheetOp {
  n: number;
  label: string;
  tool: number;
  rpm: number;
  /** Fastest cutting feed, mm/min (0: no cut). */
  feed: number;
  /** Where it goes deepest, as text. */
  deepest: string;
  seconds: number;
}

export interface Sheet {
  name: string;
  kind: 'lathe' | 'mill';
  machine: string;
  material: string;
  stock: string[];
  zero: string[];
  holding: string[];
  notes: string;
  /** In the order the program calls for them. */
  tools: SheetTool[];
  ops: SheetOp[];
  /** Cutting and moving, seconds (pauses not counted). */
  seconds: number;
  /** Times the program stops for a tool (the first one included). */
  stops: number;
  /** The corners of everything the program does, work coordinates (lathe x: radius). */
  travel: { min: Vec3; max: Vec3 } | null;
  problems: { severity: string; message: string }[];
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();
const z = (v: number) => `Z${v > 0 ? '+' : ''}${n2(v)}`;

/** A tool in a few words: "endmill Ø6, 2 flutes". */
export function toolSummary(t: Tool): string {
  const parts: string[] = [t.internal && t.type === 'threading' ? 'internal threading' : t.type === 'chamfer' ? `pointed cutter ${t.angle ?? 90}°` : t.type === 'threadmill' ? 'thread mill' : t.type];
  if (t.diameter) parts[0] += ` Ø${n2(t.diameter)}`;
  if (t.width) parts.push(`${n2(t.width)} mm wide`);
  if (t.flutes && (t.type === 'endmill' || t.type === 'threadmill')) parts.push(`${t.flutes} flute${t.flutes === 1 ? '' : 's'}`);
  if (t.noseRadius) parts.push(`nose R${n2(t.noseRadius)}`);
  if (t.fluteLength) parts.push(t.type === 'boring' || (t.type === 'threading' && t.internal) ? `reach ${n1(t.fluteLength)}` : `flutes ${n1(t.fluteLength)} long`);
  if (t.toolMaterial) parts.push(t.toolMaterial === 'hss' ? 'HSS' : 'carbide');
  return parts.join(', ');
}

/** The cutting moves as polylines (arcs as short lines), for a drawing of the job. */
export function cutLines(p: Program): Vec3[][] {
  const out: Vec3[][] = [];
  let line: Vec3[] | null = null;
  for (const { from, move } of walk(p)) {
    if (move.type === 'rapid') {
      line = null;
      continue;
    }
    if (!line) out.push((line = [from]));
    if (move.type === 'arc') line.push(...arcPoints(from, move, 0.5));
    else line.push(move.to);
  }
  return out;
}

export function setupSheet(job: Job, analysis: Analysis): Sheet {
  const lathe = job.machine.kind === 'lathe';
  const p = analysis.program;
  const st = job.stock;

  // per segment: time, the fastest feed, how deep
  interface Seg { seconds: number; feed: number; zMin: number; xMin: number; cuts: boolean }
  const segs: Seg[] = [];
  let at = p.home;
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  const grow = (q: Vec3) => {
    min = min ? { x: Math.min(min.x, q.x), y: Math.min(min.y, q.y), z: Math.min(min.z, q.z) } : { ...q };
    max = max ? { x: Math.max(max.x, q.x), y: Math.max(max.y, q.y), z: Math.max(max.z, q.z) } : { ...q };
  };
  for (const s of p.segments) {
    const g: Seg = { seconds: plannedSeconds({ ...p, home: at, segments: [s] }, job.machine), feed: 0, zMin: Infinity, xMin: Infinity, cuts: false };
    for (const m of s.moves) {
      const pts = m.type === 'arc' ? arcPoints(at, m, 0.5) : [m.to];
      for (const q of pts) grow(q);
      if (m.type !== 'rapid') {
        g.cuts = true;
        g.feed = Math.max(g.feed, m.f);
        for (const q of pts) {
          g.zMin = Math.min(g.zMin, q.z);
          g.xMin = Math.min(g.xMin, q.x);
        }
      }
      at = m.to;
    }
    segs.push(g);
  }
  if (p.segments.length) grow(p.home);

  // operations (an operation may be more than one segment)
  const ops: SheetOp[] = [];
  const opN = new Map<string, number>();
  job.operations.forEach((o, i) => opN.set(o.id ?? '', i + 1));
  p.segments.forEach((s, i) => {
    const g = segs[i]!;
    let op = ops.find((o) => o.n === (opN.get(s.opId) ?? -1) && o.tool === s.tool);
    if (!op) ops.push((op = { n: opN.get(s.opId) ?? ops.length + 1, label: s.label, tool: s.tool, rpm: s.rpm, feed: 0, deepest: '', seconds: 0 }));
    op.seconds += g.seconds;
    op.feed = Math.max(op.feed, g.feed);
    op.rpm = Math.max(op.rpm, s.rpm);
  });
  // deepest, per operation
  for (const op of ops) {
    let zMin = Infinity;
    let xMin = Infinity;
    p.segments.forEach((s, i) => {
      if ((opN.get(s.opId) ?? -1) !== op.n || s.tool !== op.tool) return;
      zMin = Math.min(zMin, segs[i]!.zMin);
      xMin = Math.min(xMin, segs[i]!.xMin);
    });
    op.deepest = !Number.isFinite(zMin) ? '' : lathe ? `to ${z(zMin)}, Ø${n2(Math.max(0, xMin) * 2)}` : `to ${z(zMin)}`;
  }

  // tools in the order they are called for
  const tools: SheetTool[] = [];
  const highest = lathe ? 0 : Math.max(st.kind === 'block' ? st.top : 0, ...job.obstacles.map((o) => o.top));
  let stops = 0;
  let last: number | null = null;
  p.segments.forEach((s, i) => {
    if (s.tool !== last) stops++;
    last = s.tool;
    const t = job.tools.find((x) => x.id === s.tool);
    let e = tools.find((x) => x.id === s.tool);
    if (!e) tools.push((e = { id: s.tool, name: t?.name ?? 'missing', what: t ? toolSummary(t) : '', reach: '', offset: '', ops: [], seconds: 0 }));
    const n = opN.get(s.opId);
    if (n && !e.ops.includes(n)) e.ops.push(n);
    e.seconds += segs[i]!.seconds;
  });
  for (const e of tools) {
    const t = job.tools.find((x) => x.id === e.id);
    let zMin = Infinity;
    p.segments.forEach((s, i) => {
      if (s.tool === e.id) zMin = Math.min(zMin, segs[i]!.zMin);
    });
    if (Number.isFinite(zMin)) {
      if (!lathe) {
        const out = highest - zMin;
        e.reach = `goes to ${z(zMin)}: at least ${n1(Math.ceil(out * 2) / 2 + 2)} mm out of the holder` + (t?.fluteLength && st.kind === 'block' && st.top - zMin > t.fluteLength + 1e-6 ? ` (deeper than its ${n1(t.fluteLength)} mm of flutes)` : '');
      } else if (t && (t.type === 'drill' || t.type === 'boring' || (t.type === 'threading' && t.internal)) && st.kind === 'bar') {
        e.reach = `goes ${n1(st.front - zMin)} mm into the bar (to ${z(zMin)})`;
      }
    }
    if (t?.offset) e.offset = lathe ? `X${n2(t.offset.x * 2)} (on the diameter) Z${n2(t.offset.z)}` : `Z${n2(t.offset.z)}`;
  }

  const stock: string[] = [];
  const zero: string[] = [];
  const holding: string[] = [];
  const mat = MATERIALS[job.workMaterial].name + (job.material ? ` (${job.material})` : '');
  if (st.kind === 'bar') {
    stock.push(`Bar Ø${n2(st.diameter)} mm, ${n1(st.stickout)} mm out of the chuck`);
    zero.push(`Z0: the finished front face${st.front > 0 ? `; the raw face is at ${z(st.front)} (${n2(st.front)} mm to face off)` : ''}`);
    zero.push('X0: the spindle axis (touch off on a known diameter)');
    const jaws = st.front - st.stickout;
    holding.push(`Chuck jaws at ${z(jaws)}`);
    const tr = min as Vec3 | null;
    if (tr) holding.push(`The tools come to ${z(tr.z)}: ${n1(tr.z - jaws)} mm from the jaws`);
  } else {
    stock.push(`Block ${n1(st.x)} × ${n1(st.y)} × ${n1(st.z)} mm (X × Y × Z)`);
    zero.push('X0 Y0: the front-left corner of the block');
    zero.push(`Z0: the finished top${st.top > 0 ? `; the raw top is at ${z(st.top)} (${n2(st.top)} mm to face off)` : ''}`);
    zero.push(`The underside is at ${z(st.top - st.z)}`);
    for (const l of alignmentLines(job)) zero.push(`Measured: ${l}`);
    for (const o of job.obstacles) holding.push(`${o.name}: X${n1(Math.min(o.x0, o.x1))} to ${n1(Math.max(o.x0, o.x1))}, Y${n1(Math.min(o.y0, o.y1))} to ${n1(Math.max(o.y0, o.y1))}, top at ${z(o.top)}`);
    if (!job.obstacles.length) holding.push('No clamps or jaws entered: the checks do not know what holds the block');
    holding.push(`The tool waits at ${z(p.home.z)} before the program, at tool changes and after it`);
  }

  return {
    name: job.name,
    kind: job.machine.kind,
    machine: job.machine.name,
    material: mat,
    stock,
    zero,
    holding,
    notes: job.notes ?? '',
    tools,
    ops: ops.sort((a, b) => a.n - b.n),
    seconds: analysis.seconds,
    stops,
    travel: min && max ? { min, max } : null,
    problems: analysis.diagnostics.map((d) => ({ severity: d.severity, message: d.message })),
  };
}
