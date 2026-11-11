/**
 * The part as the setups before left it, for the setup in hand to start from.
 *
 * Each setup cuts from above, so what it leaves is everything under its height map. Turned into
 * the next setup that is no longer a height map: a pocket in the old top is a hollow in a side
 * wall. So the part is kept per column of the new setup's grid as stretches of metal ("spans"):
 * a point is metal if it was metal when the setup before began, lies under what that setup cut,
 * and belongs to the piece that was carried over. The new setup's height map starts at the top
 * of each column's highest stretch; the stretches below go along for the picture.
 *
 * Working this out means running the setups before, so it is kept: for as long as those setups
 * (and the shared tools, machine, drawings) stay as they are, it is not done again.
 */
import { analyze } from './check.ts';
import type { Job } from './schema.ts';
import { setupJobs, unmapPoint } from './setups.ts';
import { MillMaterial, type Spans } from './sim.ts';

export interface Carried {
  h: Float32Array;
  spans: Spans;
}

const kept = new Map<string, { carried: Carried | null; after?: MillMaterial }>();
const KEEP = 24;

function remember<T extends { carried: Carried | null; after?: MillMaterial }>(key: string, v: T): T {
  kept.delete(key);
  kept.set(key, v);
  while (kept.size > KEEP) kept.delete(kept.keys().next().value!);
  return v;
}

/** What decides the part at the start of setup `i`: everything shared, the setups before in full, and how this one's block lies. */
function keyOf(jobs: Job[], i: number): string {
  const j = jobs[i]!;
  const before = jobs.slice(0, i).map((b) => [b.stock, b.operations, b.setups?.turn, b.setups?.from]);
  return JSON.stringify([j.machine, j.tools, j.workMaterial, j.shapes, before, j.stock, j.setups?.turn, j.setups?.from]);
}

/** Is `z` inside one of column k's stretches? */
function inSpans(s: Spans, k: number, z: number): boolean {
  for (let a = s.at[k]!; a < s.at[k + 1]!; a += 2) if (z >= s.z[a]! - 1e-6 && z <= s.z[a + 1]! + 1e-6) return true;
  return false;
}

function startOf(jobs: Job[], i: number): Carried | null {
  const job = jobs[i]!;
  const from = job.setups?.from;
  if (i === 0 || !from || job.stock.kind !== 'block') return null;
  const key = keyOf(jobs, i);
  const hit = kept.get(key);
  if (hit) return remember(key, hit).carried;

  // the setup before, run to its end (itself starting from what came before it)
  const prevJob = jobs[i - 1]!;
  if (prevJob.stock.kind !== 'block') return remember(key, { carried: null }).carried;
  const prevKey = `after:${keyOf(jobs, i - 1)}:${JSON.stringify(prevJob.operations)}`;
  let prev = kept.get(prevKey)?.after;
  if (!prev) {
    const m = analyze(prevJob).material;
    if (!(m instanceof MillMaterial)) return remember(key, { carried: null }).carried;
    prev = m;
    remember(prevKey, { carried: null, after: prev });
  }

  const st = job.stock;
  const turn = job.setups!.turn;
  const piece = { kind: 'block' as const, x: from.x, y: from.y, z: from.z, top: from.oz };
  const grid = new MillMaterial(st);
  const bottom = st.top - st.z;
  const dz = grid.cell;
  const nz = Math.max(1, Math.ceil(st.z / dz));
  const h = new Float32Array(grid.nx * grid.ny).fill(bottom);
  const at = new Uint32Array(grid.nx * grid.ny + 1);
  const zs: number[] = [];
  const eps = 1e-6;
  for (let j = 0; j < grid.ny; j++) {
    for (let ii = 0; ii < grid.nx; ii++) {
      const k = j * grid.nx + ii;
      at[k] = zs.length;
      // (the last cells may reach past the block: look just inside it)
      const x = Math.min((ii + 0.5) * grid.cell, st.x - 1e-3);
      const y = Math.min((j + 0.5) * grid.cell, st.y - 1e-3);
      let open = false;
      for (let n = 0; n < nz; n++) {
        const z0 = bottom + n * dz;
        const z1 = Math.min(st.top, z0 + dz);
        // where the middle of this bit of the column was in the setup before
        const q = unmapPoint(turn, piece, st, { x, y, z: (z0 + z1) / 2 });
        let metal = q.x >= -eps && q.y >= -eps && q.x <= from.x + eps && q.y <= from.y + eps && q.z <= from.oz + eps && q.z >= from.oz - from.z - eps;
        if (metal) {
          const px = q.x + from.ox;
          const py = q.y + from.oy;
          const pi = Math.min(prev.nx - 1, Math.max(0, Math.floor(px / prev.cell)));
          const pj = Math.min(prev.ny - 1, Math.max(0, Math.floor(py / prev.cell)));
          const pk = pj * prev.nx + pi;
          metal = q.z <= prev.h[pk]! + eps && (!prev.spans || inSpans(prev.spans, pk, q.z));
        }
        if (metal) {
          if (open) zs[zs.length - 1] = z1;
          else zs.push(z0, z1);
          open = true;
        } else open = false;
      }
      if (zs.length > at[k]!) h[k] = zs[zs.length - 1]!;
    }
  }
  at[grid.nx * grid.ny] = zs.length;
  return remember(key, { carried: { h, spans: { at, z: Float32Array.from(zs) } } }).carried;
}

/** What the setup in hand starts from, when its block is a piece of the setup before (null: a plain block). */
export function carried(job: Job): Carried | null {
  if (!job.setups?.from || job.setups.at === 0 || job.stock.kind !== 'block') return null;
  return startOf(setupJobs(job), job.setups.at);
}
