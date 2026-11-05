/**
 * Verifies a generated program: travel limits, the chuck, rapids into material and cuts
 * deeper than the tool can take. Runs the material model move by move, so it also yields the
 * finished part for the preview.
 */
import { generate, type Diagnostic } from './generate.ts';
import { estimateSeconds, walk, type Program } from './program.ts';
import type { Job, Tool, Vec3 } from './schema.ts';
import { LatheMaterial, MillMaterial, samplePath } from './sim.ts';

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

  for (const { seg, index, from, move } of walk(program)) {
    if (index >= upTo) break;
    const segment = program.segments[seg]!;
    const opId = segment.opId;
    const tool = job.tools.find((t) => t.id === segment.tool) as Tool;
    const pts = samplePath(from, move, step);

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

    if (move.type === 'rapid') {
      for (const p of pts) {
        const h = material.hit(p, tool);
        if (h) {
          once({ severity: 'error', code: 'RAPID_IN_MATERIAL', message: `Rapid move runs ${h.depth.toFixed(2)} mm into material near ${fmt(p, lathe)}.`, opId, move: index });
          break;
        }
      }
      continue;
    }

    if (material instanceof LatheMaterial) {
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
      else if (!plunge && tool.maxDoc && depth > tool.maxDoc * 1.5 + 0.05)
        once({ severity: 'warning', code: 'DOC_HIGH', message: `Side cut is ${depth.toFixed(2)} mm deep (T${tool.id} max ${tool.maxDoc} mm per pass).`, opId, move: index });
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
    seconds: estimateSeconds(gen.program, job.machine.rapidRate),
    moves,
  };
}

export const hasErrors = (d: Diagnostic[]) => d.some((x) => x.severity === 'error');
