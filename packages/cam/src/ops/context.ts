import type { Cutting } from '../feeds.ts';
import type { Job, Tool, Vec3 } from '../schema.ts';

/** What an operation's generator gets: the job, its tool, speeds and where the tool is now. */
export interface OpContext {
  job: Job;
  tool: Tool;
  cut: Cutting;
  /** Current tool position (end of the previous segment). */
  from: Vec3;
  /** Clearance for rapids, mm. */
  c: number;
}

/** Lathe: the radius and Z where rapids are always in the air (above the bar, in front of its face). */
export function latheSafe(job: Job): { x: number; z: number; r: number; front: number } {
  if (job.stock.kind !== 'bar') throw new Error('lathe operation on block stock');
  const r = job.stock.diameter / 2;
  const c = job.machine.clearance;
  return { x: r + c, z: job.stock.front + c, r, front: job.stock.front };
}

/** Mill: Z where rapids are always in the air. */
export function millSafeZ(job: Job): number {
  if (job.stock.kind !== 'block') throw new Error('mill operation on bar stock');
  return job.stock.top + job.machine.clearance;
}
