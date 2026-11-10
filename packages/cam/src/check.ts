/**
 * Verifies a generated program: travel limits, the chuck, rapids into material and cuts
 * deeper than the tool can take. Runs the material model move by move, so it also yields the
 * finished part for the preview.
 */
import { generate, retract, type Diagnostic } from './generate.ts';
import { walk, type Program } from './program.ts';
import { plannedSeconds } from './planner.ts';
import type { Job, Tool, Vec3 } from './schema.ts';
import { LatheMaterial, MillMaterial, samplePath } from './sim.ts';
import { cuttingData } from './feeds.ts';
import { MATERIALS } from './materials.ts';

export interface Analysis {
  program: Program;
  diagnostics: Diagnostic[];
  /** Material after the whole program (or after `upTo` moves). */
  material: LatheMaterial | MillMaterial | null;
  seconds: number;
  moves: number;
}

const fmt = (p: Vec3, lathe: boolean) => (lathe ? `X${(p.x * 2).toFixed(2)} Z${p.z.toFixed(2)}` : `X${p.x.toFixed(2)} Y${p.y.toFixed(2)} Z${p.z.toFixed(2)}`);

/** Run the material model over the first `upTo` moves (all by default) and report problems. */
export function simulate(job: Job, program: Program, upTo = Infinity): { material: LatheMaterial | MillMaterial | null; diagnostics: Diagnostic[] } {
  const docOf = (tool: Tool) => cuttingData(tool, job.workMaterial).doc;
  const diagnostics: Diagnostic[] = [];
  const lathe = program.kind === 'lathe';
  const material = job.stock.kind === 'bar' ? new LatheMaterial(job.stock) : new MillMaterial(job.stock);
  if ((lathe && !(material instanceof LatheMaterial)) || (!lathe && !(material instanceof MillMaterial))) return { material: null, diagnostics };

  const env = job.machine.envelope;
  const chuckR = job.stock.kind === 'bar' ? (job.machine.chuckDiameter ?? job.stock.diameter * 2.5) / 2 : 0;
  const flagged = new Set<string>();
  const once = (d: Diagnostic) => {
    const key = `${d.code}:${d.opId ?? ''}`;
    if (flagged.has(key)) return;
    flagged.add(key);
    diagnostics.push(d);
  };
  const step = lathe ? 0.1 : Math.max(0.1, (material as MillMaterial).cell * 0.5);
  let prevType: string | null = null;

  for (const { seg, index, from, move } of walk(program)) {
    if (index >= upTo) break;
    const segment = program.segments[seg]!;
    const opId = segment.opId;
    const tool = job.tools.find((t) => t.id === segment.tool) as Tool;
    const pts = samplePath(from, move, step);
    // obstacles (mill): the tool is a cylinder from its tip up; any move, rapids too, must keep it clear
    if (!lathe && job.obstacles.length && tool) {
      const r = (tool.diameter ?? 0) / 2;
      for (const o of job.obstacles) {
        const p = [from, ...pts].find((q) => q.z < o.top - 1e-6 && Math.hypot(Math.max(o.x0 - q.x, 0, q.x - o.x1), Math.max(o.y0 - q.y, 0, q.y - o.y1)) < r - 1e-6);
        if (p) {
          once({
            severity: 'error',
            code: 'OBSTACLE',
            message: `T${tool.id} runs into ${o.name} (X${o.x0.toFixed(0)}…${o.x1.toFixed(0)} Y${o.y0.toFixed(0)}…${o.y1.toFixed(0)}, up to Z${o.top.toFixed(1)}) near ${fmt(p, false)}${move.type === 'rapid' ? ' on a rapid: raise the clearance in the machine settings above it' : ': keep this operation clear of it'}.`,
            opId,
            move: index,
          });
          break;
        }
      }
    }

    for (const p of pts) {
      const out = p.x < env.min.x - 1e-6 || p.x > env.max.x + 1e-6 || p.z < env.min.z - 1e-6 || p.z > env.max.z + 1e-6 || (!lathe && (p.y < env.min.y - 1e-6 || p.y > env.max.y + 1e-6));
      if (out) {
        once({ severity: 'error', code: 'OUT_OF_RANGE', message: `Move to ${fmt(move.to, lathe)} leaves the machine's travel.`, opId, move: index });
        break;
      }
    }
    if (lathe) {
      const lm = material as LatheMaterial;
      const [lo] = LatheMaterial.footprint(tool);
      const nearChuck = pts.find((p) => p.z + lo < lm.chuckZ + 0.5 && p.x < chuckR + 1);
      if (nearChuck) once({ severity: 'error', code: 'CHUCK', message: `Tool reaches the chuck at ${fmt(nearChuck, true)} (jaws at Z${lm.chuckZ.toFixed(1)}).`, opId, move: index });
    }

    // below the block is what it sits on: the table, a vise bed, parallels
    if (!lathe && job.stock.kind === 'block' && move.to.z < job.stock.top - job.stock.z - 1e-6) {
      const bottom = job.stock.top - job.stock.z;
      once({
        severity: 'warning',
        code: 'BELOW_STOCK',
        message: `T${tool.id} goes to Z${move.to.z.toFixed(2)}, ${(bottom - move.to.z).toFixed(2)} mm below the block's bottom (Z${bottom.toFixed(2)}): into whatever it sits on. Put a sacrificial plate under it, or parallels clear of this spot.`,
        opId,
        move: index,
      });
    }

    if (move.type === 'rapid') {
      // pulling out of the thread groove just cut: the model has no helix to know it is clear
      const fromThread = prevType === 'thread';
      prevType = move.type;
      if (fromThread) continue;
      for (const p of pts) {
        const h = material.hit(p, tool);
        if (h) {
          once({ severity: 'error', code: 'RAPID_IN_MATERIAL', message: `Rapid move runs ${h.depth.toFixed(2)} mm into material near ${fmt(p, lathe)}.`, opId, move: index });
          break;
        }
      }
      continue;
    }

    prevType = move.type;
    // a thread is a groove too shallow to change the stock outline the model keeps
    if (move.type === 'thread') continue;

    if (material instanceof LatheMaterial) {
      // an internal tool cuts outwards from the bore: more than a pass deep means there was no hole
      // (a mostly radial move faces a bottom shoulder: its depth is axial, not judged here)
      if (tool.internal && Math.abs(move.to.z - from.z) >= Math.abs(move.to.x - from.x)) {
        const limit = docOf(tool) * 2 + 0.1;
        // judged 0.5 mm behind the tip, where the previous pass has certainly been
        const bore = (z: number) => material.boreAt(z + 0.5);
        const deep = pts.find((p) => p.x - bore(p.z) > limit && material.radiusAt(p.z + 0.5) > bore(p.z) + 0.02);
        if (deep) once({ severity: 'error', code: 'BORE_SOLID', message: `T${tool.id} cuts ${(deep.x - bore(deep.z)).toFixed(2)} mm into solid material near ${fmt(deep, true)}: drill or bore the hole first (or check its diameter).`, opId, move: index });
      }
      let prev = from;
      for (const p of pts) {
        material.cut(prev, p, tool);
        prev = p;
      }
    } else {
      // plunging straight down into material needs a centre-cutting tool
      const plunge = move.type === 'feed' && Math.abs(move.to.x - from.x) < 1e-6 && Math.abs(move.to.y - from.y) < 1e-6 && move.to.z < from.z;
      if (plunge && tool.type === 'endmill' && tool.centerCutting === false && material.hit(move.to, tool)) {
        once({ severity: 'error', code: 'PLUNGE', message: `T${tool.id} is not centre-cutting but plunges into material at ${fmt(move.to, false)}.`, opId, move: index });
      }
      const depth = material.cutPath(pts, tool);
      const limit = tool.fluteLength ?? Infinity;
      if (depth > limit + 0.05) once({ severity: 'error', code: 'TOO_DEEP', message: `Cut is ${depth.toFixed(2)} mm deep; T${tool.id}'s flutes are ${limit} mm.`, opId, move: index });
      else if (!plunge && depth > docOf(tool) * 1.5 + 0.05)
        once({ severity: 'warning', code: 'DOC_HIGH', message: `Side cut is ${depth.toFixed(2)} mm deep; T${tool.id} in ${MATERIALS[job.workMaterial].name.toLowerCase()} should take about ${docOf(tool)} mm per pass.`, opId, move: index });
    }
  }
  return { material, diagnostics };
}

/** Generate + simulate: everything the UI and the agent need to judge a job. */
export function analyze(job: Job): Analysis {
  const gen = generate(job);
  const sim = simulate(job, gen.program);
  let moves = 0;
  for (const s of gen.program.segments) moves += s.moves.length;
  return {
    program: gen.program,
    diagnostics: [...gen.diagnostics, ...sim.diagnostics],
    material: sim.material,
    seconds: plannedSeconds(gen.program, job.machine),
    moves,
  };
}

export const hasErrors = (d: Diagnostic[]) => d.some((x) => x.severity === 'error');

/**
 * Starting again at segment `seg` (after a stop, a broken tool): the program as it will then run,
 * and what the checks say about it. Everything before `seg` is taken as done (its material gone);
 * the tool comes to `seg` from the home position, not from where the segment before ended, so
 * that way is put into the program (the segment before now ends at home) and checked like any
 * other. Emit the result with `fromSegment: seg`. `firstMove`: the index of `seg`'s first move.
 */
export function resumeFrom(job: Job, program: Program, seg: number): { program: Program; diagnostics: Diagnostic[]; firstMove: number; added: number } {
  if (seg <= 0 || seg >= program.segments.length) return { program, diagnostics: simulate(job, program).diagnostics, firstMove: 0, added: 0 };
  const before = program.segments[seg - 1]!;
  let end = program.home;
  for (let i = seg - 1; i >= 0; i--) {
    const last = program.segments[i]!.moves.at(-1);
    if (last) {
      end = last.to;
      break;
    }
  }
  const way = retract(end, program.home);
  const segments = program.segments.map((s, i) => (i === seg - 1 ? { ...before, moves: [...before.moves, ...way] } : s));
  const joined: Program = { ...program, segments };
  let firstMove = 0;
  for (let i = 0; i < seg; i++) firstMove += segments[i]!.moves.length;
  // what matters is what will be run: the way from home into the segment, and everything after
  const diagnostics = simulate(job, joined).diagnostics.filter((d) => d.move === undefined || d.move >= firstMove - way.length);
  return { program: joined, diagnostics, firstMove, added: way.length };
}
