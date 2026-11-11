/**
 * What a machinist looking over the job would stop at before running it: not errors (the checks
 * find those) but things worth a second look. The order of operations, tools that reach far for
 * their thickness, a part that gets thin where it hangs out, speeds the spindle cannot give,
 * what nothing is known about. Computed from the job and its analysis, as facts with numbers: the
 * assistant's review starts from them, and so can the user's.
 */
import type { Analysis } from './check.ts';
import { cuttingData, rpmFor } from './feeds.ts';
import { opLabel, withIds } from './generate.ts';
import { MATERIALS } from './materials.ts';
import { plannedSeconds } from './planner.ts';
import type { Job } from './schema.ts';
import { LatheMaterial } from './sim.ts';

export interface Finding {
  code: string;
  opId?: string;
  text: string;
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();
const zf = (v: number) => `Z${n1(v)}`;

export function reviewJob(job: Job, analysis: Analysis): Finding[] {
  const out: Finding[] = [];
  const ops = withIds(job.operations);
  const p = analysis.program;
  if (!ops.length || !p.segments.length) return out;
  const add = (code: string, text: string, opId?: string) => out.push({ code, text, ...(opId ? { opId } : {}) });
  const label = (id: string) => {
    const o = ops.find((x) => x.id === id);
    return o ? `${id} (${opLabel(o)})` : id;
  };
  const toolOf = (id: number) => job.tools.find((t) => t.id === id);

  // per operation: deepest cut and time
  const deep = new Map<string, number>();
  const secs = new Map<string, number>();
  let at = p.home;
  for (const s of p.segments) {
    secs.set(s.opId, (secs.get(s.opId) ?? 0) + plannedSeconds({ ...p, home: at, segments: [s] }, job.machine));
    for (const m of s.moves) {
      if (m.type !== 'rapid') deep.set(s.opId, Math.min(deep.get(s.opId) ?? Infinity, m.to.z));
      at = m.to;
    }
  }

  // one operation that takes most of the time
  if (analysis.seconds > 300) {
    for (const [id, t] of secs) {
      if (t > analysis.seconds * 0.6 && ops.length > 1) add('LONG_OP', `${label(id)} takes ${Math.round(t / 60)} of the job's ${Math.round(analysis.seconds / 60)} minutes: a larger cutter for the roughing, or a deeper cut if the tool allows it, is where time is to be had.`, id);
    }
  }

  // a small cutter the spindle cannot turn fast enough
  for (const o of ops) {
    const t = toolOf(o.tool);
    if (!t?.diameter || (t.type !== 'endmill' && t.type !== 'drill' && t.type !== 'chamfer')) continue;
    if (o.rpm !== undefined) continue;
    const want = rpmFor(cuttingData(t, job.workMaterial).vc, t.diameter);
    if (want > job.machine.maxRpm * 2 && t.diameter <= 4 && !out.some((f) => f.code === 'RPM_SHORT' && f.text.startsWith(`T${t.id} `)))
      add('RPM_SHORT', `T${t.id} (Ø${t.diameter}) would like ${Math.round(want / 100) * 100} rpm in ${MATERIALS[job.workMaterial].name.toLowerCase()}; the spindle gives ${job.machine.maxRpm}. The feed is scaled down with it, so it is safe but slow; small cutters break when pushed, so do not raise the feed to make up for it.`, o.id);
  }

  if (job.machine.kind === 'mill' && job.stock.kind === 'block') {
    const st = job.stock;
    const bottom = st.top - st.z;
    // facing after something else has cut
    const face = ops.findIndex((o) => o.type === 'mill_face');
    if (face > 0) add('ORDER_FACE', `${label(ops[face]!.id!)} comes after ${face} other operation${face === 1 ? '' : 's'}: their depths were measured from a top that is not yet there. Face first.`, ops[face]!.id);
    // spotting after the hole is drilled
    ops.forEach((o, i) => {
      if (o.type !== 'mill_spot') return;
      const before = ops.slice(0, i).find((d) => d.type === 'mill_drill' && d.points.some((q) => o.points.some((s) => Math.hypot(s.x - q.x, s.y - q.y) < 0.5)));
      if (before) add('ORDER_SPOT', `${label(o.id!)} spots holes that ${before.id} has already drilled: the spot is there to start the drill, so it goes first.`, o.id);
    });
    // a chamfer before the wall beside it is cut
    ops.forEach((o, i) => {
      if (o.type !== 'mill_chamfer' || o.side !== 'outside') return;
      const later = ops.slice(i + 1).find((c) => (c.type === 'mill_contour_rect' || c.type === 'mill_contour') && c.side === 'outside');
      if (later) add('ORDER_CHAMFER', `${label(o.id!)} chamfers an outside edge before ${later.id} cuts the outside: the edge is made by that cut. Chamfer after it.`, o.id);
    });
    // tools that reach far for their thickness
    const seen = new Set<number>();
    for (const s of p.segments) {
      const t = toolOf(s.tool);
      if (!t?.diameter || seen.has(t.id)) continue;
      let zMin = Infinity;
      for (const x of p.segments) if (x.tool === t.id) zMin = Math.min(zMin, deep.get(x.opId) ?? Infinity);
      const reach = st.top - zMin;
      const limit = t.type === 'drill' ? 8 : 4;
      if (Number.isFinite(reach) && reach / t.diameter > limit) {
        seen.add(t.id);
        add('SLENDER_TOOL', `T${t.id} (Ø${t.diameter}) goes ${n1(reach)} mm deep, ${n1(reach / t.diameter)} times its diameter: ${t.type === 'drill' ? 'peck often and clear the chips, the drill wanders and packs up at that depth' : 'it bends away from the cut and chatters. Lighter cuts at depth, a finishing pass, or a thicker cutter where the shape allows'}.`, s.opId);
      }
    }
    // a thin floor left under a pocket
    for (const o of ops) {
      if (o.type !== 'mill_pocket_rect' && o.type !== 'mill_pocket_circle' && o.type !== 'mill_pocket') continue;
      const floor = o.zBottom - bottom;
      if (floor > 0.01 && floor < 1) add('THIN_FLOOR', `${label(o.id!)} leaves a floor ${n1(floor)} mm thick: it drums and lifts under the cutter. Support it from below, or take the last level lightly.`, o.id);
    }
    // nothing known about the holding
    if (!job.obstacles.length) {
      const through = ops.find((o) => (o.type === 'mill_contour' || o.type === 'mill_contour_rect') && o.side === 'outside');
      add('HOLDING_UNKNOWN', through
        ? `Nothing is entered about how the block is held, and ${label(through.id!)} runs round the outside of the part, where vise jaws or clamps usually are. Enter them (or scan them with the camera) so the checks can keep the tool off them.`
        : 'Nothing is entered about how the block is held: the checks cannot keep the tool off clamps or jaws they do not know of.');
    }
    // a part cut free
    for (const o of ops) {
      if ((o.type !== 'mill_contour' && o.type !== 'mill_contour_rect') || o.side !== 'outside') continue;
      if (o.zBottom <= bottom + 0.05 && o.tabs === 0) add('CUT_FREE', `${label(o.id!)} cuts the part free with no holding tabs: it comes loose under the cutter on the last level, unless it is held some other way (screwed or stuck down).`, o.id);
    }
  }

  if (job.machine.kind === 'lathe' && job.stock.kind === 'bar') {
    const st = job.stock;
    const jaws = st.front - st.stickout;
    const first = ops[0]!;
    const face = ops.findIndex((o) => o.type === 'lathe_face' || (o.type === 'lathe_profile' && o.points?.[0]?.d === 0));
    if (face > 0 && first.type !== 'lathe_drill') add('ORDER_FACE', `The face is cut by ${ops[face]!.id}, after ${face} other operation${face === 1 ? '' : 's'}: lengths before it are measured from a face that is not there yet. Face first.`, ops[face]!.id);
    const part = ops.findIndex((o) => o.type === 'lathe_partoff');
    if (part >= 0 && part < ops.length - 1) add('ORDER_PARTOFF', `${label(ops[part]!.id!)} is not the last operation: what comes after it has nothing left to cut.`, ops[part]!.id);
    // parting off far from the jaws
    for (const o of ops) {
      if (o.type !== 'lathe_partoff') continue;
      const out = o.z - jaws;
      if (out > 3 * st.diameter) add('PARTOFF_FAR', `${label(o.id!)} parts off ${n1(out)} mm from the jaws on a Ø${st.diameter} bar (${n1(out / st.diameter)} diameters out): parting wants to be close to the chuck. Less stick-out, or expect chatter and a blade that digs in.`, o.id);
    }
    // an external thread that ends at no groove
    for (const o of ops) {
      if (o.type !== 'lathe_thread' || o.side !== 'external') continue;
      const relief = ops.some((g) => g.type === 'lathe_groove' && g.z >= o.zEnd - 0.01 - g.width && g.z - g.width <= o.zEnd + 0.5 && g.diameter <= o.diameter - 1.2 * o.pitch);
      const shoulder = ops.some((t) => (t.type === 'lathe_turn' && Math.abs(t.zEnd - o.zEnd) < o.pitch * 2 && t.diameter <= o.diameter + 0.01) || t.type === 'lathe_profile');
      if (!relief) add('THREAD_NO_RELIEF', `${label(o.id!)} ends at ${zf(o.zEnd)} without a relief groove: there is no pull-out, so the tool stops in the thread and leaves a ring there${shoulder ? '; against a shoulder a nut will not run up to it' : ''}. A groove as deep as the thread, 1.5 pitches wide, is the usual answer.`, o.id);
    }
    // a boring bar that reaches far
    const seen = new Set<number>();
    for (const s of p.segments) {
      const t = toolOf(s.tool);
      if (!t?.diameter || !t.internal || seen.has(t.id)) continue;
      const reach = st.front - (deep.get(s.opId) ?? st.front);
      if (reach / t.diameter > 4) {
        seen.add(t.id);
        add('SLENDER_TOOL', `T${t.id} (a Ø${t.diameter} bar) reaches ${n1(reach)} mm into the bore, ${n1(reach / t.diameter)} times its thickness: steel bars chatter beyond about four. Light cuts, a sharp positive insert, lower speed.`, s.opId);
      }
    }
    // the part where it gets thin, with length hanging beyond
    if (analysis.material instanceof LatheMaterial) {
      const m = analysis.material;
      // (where the parting blade goes in, thin is the point)
      const parted = ops.filter((o) => o.type === 'lathe_partoff').map((o) => [o.z - (toolOf(o.tool)?.width ?? 3) - 0.1, o.z + 0.1] as const);
      let worst: { ratio: number; z: number; d: number; len: number } | null = null;
      // the free end: the first slice from the front that still has material
      let end = -1;
      for (let i = m.n - 1; i >= 0; i--) if (m.r[i]! > 0.05) { end = i; break; }
      for (let i = 0; i < end; i++) {
        const z = m.zAt(i);
        if (z < jaws + 1 || m.r[i]! <= 0.05 || parted.some(([lo, hi]) => z >= lo && z <= hi)) continue;
        const wall = m.r[i]! - m.b[i]!;
        // (a tube is as stiff as its outside, nearly; a thin wall is another matter)
        const d = 2 * m.r[i]!;
        const len = m.zAt(end) - z;
        const ratio = len / d;
        if (wall > 0.05 && (!worst || ratio > worst.ratio)) worst = { ratio, z, d, len };
      }
      const tailstock = ops.some((o) => o.type === 'lathe_drill');
      if (worst && worst.ratio > 4) add('SLENDER_PART', `At ${zf(worst.z)} the part is down to Ø${n1(worst.d)} with ${n1(worst.len)} mm hanging beyond it (${n1(worst.ratio)} to 1): it springs away from the tool, turns a taper and chatters. Support the end with a centre${tailstock ? ' (the job drills on centre, so the tailstock is in use: plan when)' : ''}, or turn the thin part last, in short lengths from the end.`);
    }
  }
  return out;
}
