/**
 * A part made in several clampings. On a three-axis mill the tool only comes from above, so a
 * feature on another face means taking the block out, turning it, and clamping it again: a new
 * setup, with its own zero.
 *
 * The job always IS one setup (its stock, operations, clamps, notes): everything that plans,
 * checks, previews and runs a job works on that one. The other setups wait in `job.setups`;
 * switching swaps them. Machine, tools, material and drawings are shared.
 *
 * Each setup's zero is as always: X0 Y0 at the front-left corner of the block as it now lies,
 * Z0 at its finished top. `mapPoint` says where a point of one setup is in the next, which is how
 * a hole's position is carried over a turn without mirroring it by mistake.
 */
import { CamError } from './program.ts';
import type { Analysis } from './check.ts';
import type { Job, SetupPart, Stock, Turn, Vec3 } from './schema.ts';
import { MillMaterial } from './sim.ts';

type Block = Extract<Stock, { kind: 'block' }>;

export const TURNS: { turn: Turn; label: string; how: string }[] = [
  { turn: 'over-y', label: 'Flipped over, left to right', how: 'Flip the block over sideways, like turning a page: the face that was on top lies on the table, the front stays at the front, left and right change places.' },
  { turn: 'over-x', label: 'Flipped over, front to back', how: 'Flip the block over towards you: the face that was on top lies on the table, the left stays on the left, front and back change places.' },
  { turn: 'front-up', label: 'Front face up', how: 'Tip the block back onto its rear face: the face that was at the front is now on top, and the face that was on top is at the back.' },
  { turn: 'back-up', label: 'Back face up', how: 'Tip the block forward onto its front face: the face that was at the back is now on top, and the face that was on top is at the front.' },
  { turn: 'left-up', label: 'Left face up', how: 'Tip the block over to the right: the face that was on the left is now on top, and the face that was on top is on the right.' },
  { turn: 'right-up', label: 'Right face up', how: 'Tip the block over to the left: the face that was on the right is now on top, and the face that was on top is on the left.' },
  { turn: 'quarter', label: 'A quarter turn on the table', how: 'Turn the block a quarter counter-clockwise (seen from above) without tipping it: the face that was at the front is now on the right.' },
  { turn: 'none', label: 'As it lay', how: 'The block lies as before (clamped again, or held differently).' },
];

export const turnLabel = (t: Turn): string => TURNS.find((x) => x.turn === t)?.label ?? t;

/** The turn as a rotation: where a direction of the block as it lay points afterwards. */
function rotate(turn: Turn, v: Vec3): Vec3 {
  switch (turn) {
    case 'over-y':
      return { x: -v.x, y: v.y, z: -v.z };
    case 'over-x':
      return { x: v.x, y: -v.y, z: -v.z };
    case 'front-up':
      return { x: v.x, y: v.z, z: -v.y };
    case 'back-up':
      return { x: v.x, y: -v.z, z: v.y };
    case 'left-up':
      return { x: v.z, y: v.y, z: -v.x };
    case 'right-up':
      return { x: -v.z, y: v.y, z: v.x };
    case 'quarter':
      return { x: -v.y, y: v.x, z: v.z };
    case 'none':
      return { ...v };
  }
}

/** The block's size as it lies after the turn (its top allowance is the caller's to set). */
export function turnedSize(turn: Turn, s: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const r = rotate(turn, { x: s.x, y: s.y, z: s.z });
  return { x: Math.abs(r.x), y: Math.abs(r.y), z: Math.abs(r.z) };
}

/**
 * Where a point of the block in one setup is after the turn, in the next setup's coordinates
 * (both: X0 Y0 at the front-left corner as the block lies, Z measured from that setup's zero).
 * `from` and `to` are the two setups' stocks; `to` is taken to be the same solid, turned (the
 * same size; where the second setup's block is entered smaller, the faces that stay put are the
 * table and the front-left corner).
 */
export function mapPoint(turn: Turn, from: Block, to: Block, p: Vec3): Vec3 {
  // from the middle of the old block, turned, to the middle of the new one
  const c0 = { x: from.x / 2, y: from.y / 2, z: from.top - from.z / 2 };
  const r = rotate(turn, { x: p.x - c0.x, y: p.y - c0.y, z: p.z - c0.z });
  const size = turnedSize(turn, from);
  // the new block stands on the table at its front-left corner: its top is at to.top
  return { x: r.x + size.x / 2, y: r.y + size.y / 2, z: r.z + (to.top - to.z) + size.z / 2 };
}

/** Which way a face of the block as it lay points after the turn, in words. */
export function faceAfter(turn: Turn, face: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'): string {
  const n: Record<string, Vec3> = { top: { x: 0, y: 0, z: 1 }, bottom: { x: 0, y: 0, z: -1 }, front: { x: 0, y: -1, z: 0 }, back: { x: 0, y: 1, z: 0 }, left: { x: -1, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 } };
  const r = rotate(turn, n[face]!);
  if (r.z > 0.5) return 'top';
  if (r.z < -0.5) return 'bottom';
  if (r.y < -0.5) return 'front';
  if (r.y > 0.5) return 'back';
  return r.x < -0.5 ? 'left' : 'right';
}

// ---- the setups of a job

const own = (job: Job, name: string, turn: Turn): SetupPart => ({
  name,
  turn,
  stock: job.stock,
  operations: job.operations,
  obstacles: job.obstacles,
  ...(job.notes !== undefined ? { notes: job.notes } : {}),
  ...(job.measured ? { measured: job.measured } : {}),
});

/** All the setups in order, the one in hand among them. A job without setups is one setup. */
export function setupList(job: Job): { setups: SetupPart[]; at: number } {
  const s = job.setups;
  if (!s) return { setups: [own(job, 'Setup 1', 'none')], at: 0 };
  const at = Math.min(s.at, s.others.length);
  return { setups: [...s.others.slice(0, at), own(job, s.name, s.turn), ...s.others.slice(at)], at };
}

/** The job with setup `i` in hand. */
function withSetup(job: Job, setups: SetupPart[], i: number): Job {
  const cur = setups[i]!;
  const { notes: _n, measured: _m, setups: _s, ...shared } = job;
  return {
    ...shared,
    stock: cur.stock,
    operations: cur.operations,
    obstacles: cur.obstacles,
    ...(cur.notes !== undefined ? { notes: cur.notes } : {}),
    ...(cur.measured ? { measured: cur.measured } : {}),
    ...(setups.length > 1 || cur.name !== 'Setup 1' ? { setups: { at: i, name: cur.name, turn: cur.turn, others: setups.filter((_, k) => k !== i) } } : {}),
  };
}

/** The job as each of its setups in turn (for the setup sheet, for saving every program). */
export function setupJobs(job: Job): Job[] {
  const { setups } = setupList(job);
  return setups.map((_, i) => withSetup(job, setups, i));
}

export function switchSetup(job: Job, i: number): Job {
  const { setups, at } = setupList(job);
  if (i < 0 || i >= setups.length) throw new CamError(`there is no setup ${i + 1} (the job has ${setups.length})`);
  return i === at ? job : withSetup(job, setups, i);
}

/**
 * The size of what the setup in hand leaves, as a plain block: the stock, less what was faced
 * off the top, and cut down to the outline where a contour went round the outside to full depth
 * (then `ox`, `oy` say where that part's front-left corner is in this setup's coordinates).
 */
export function leftBy(job: Job, analysis: Analysis): { x: number; y: number; z: number; ox: number; oy: number } {
  const st = job.stock;
  if (st.kind !== 'block') throw new CamError('setups are for the mill');
  const m = analysis.material;
  if (!(m instanceof MillMaterial)) return { x: st.x, y: st.y, z: st.z, ox: 0, oy: 0 };
  const floor = st.top - st.z;
  // the pieces of material that hang together; the part is the largest one that the cut has
  // freed from the edge of the stock (the frame left around it stays behind), else everything
  const solid = (k: number) => m.h[k]! > floor + 0.05;
  const seen = new Uint8Array(m.nx * m.ny);
  type Piece = { x0: number; x1: number; y0: number; y1: number; top: number; n: number; edge: boolean };
  const pieces: Piece[] = [];
  const stack: number[] = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || !solid(start)) continue;
    const pc: Piece = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, top: -Infinity, n: 0, edge: false };
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % m.nx;
      const j = (k - i) / m.nx;
      pc.n++;
      pc.x0 = Math.min(pc.x0, i); pc.x1 = Math.max(pc.x1, i + 1);
      pc.y0 = Math.min(pc.y0, j); pc.y1 = Math.max(pc.y1, j + 1);
      pc.top = Math.max(pc.top, m.h[k]!);
      if (i === 0 || j === 0 || i === m.nx - 1 || j === m.ny - 1) pc.edge = true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= m.nx || nj >= m.ny) continue;
        const nk = nj * m.nx + ni;
        if (!seen[nk] && solid(nk)) {
          seen[nk] = 1;
          stack.push(nk);
        }
      }
    }
    pieces.push(pc);
  }
  const freed = pieces.filter((q) => !q.edge).sort((p, q) => q.n - p.n)[0];
  const all = pieces.reduce<Piece | null>((u, q) => (u ? { x0: Math.min(u.x0, q.x0), x1: Math.max(u.x1, q.x1), y0: Math.min(u.y0, q.y0), y1: Math.max(u.y1, q.y1), top: Math.max(u.top, q.top), n: u.n + q.n, edge: true } : q), null);
  const part = freed ?? all;
  const { x0, x1, y0, y1, top } = part ?? { x0: 0, x1: 0, y0: 0, y1: 0, top: -Infinity };
  if (!Number.isFinite(top)) return { x: st.x, y: st.y, z: st.z, ox: 0, oy: 0 };
  const round = (v: number) => Math.round(v * 10) / 10;
  // (ox, oy: where the part's front-left corner is in this setup's coordinates)
  return { x: round(Math.min(st.x, (x1 - x0) * m.cell)), y: round(Math.min(st.y, (y1 - y0) * m.cell)), z: round(top - floor), ox: freed ? round(x0 * m.cell) : 0, oy: freed ? round(y0 * m.cell) : 0 };
}

/**
 * Add a setup after the one in hand and take it in hand: the block turned as said, as large as
 * `size` (what the setup before leaves; see `leftBy`) lying the new way, nothing cut yet.
 */
export function addSetup(job: Job, turn: Turn, name: string | undefined, size: { x: number; y: number; z: number }): Job {
  if (job.machine.kind !== 'mill' || job.stock.kind !== 'block') throw new CamError('setups are for the mill: the lathe has one clamping per job for now');
  const { setups, at } = setupList(job);
  if (setups.length >= 12) throw new CamError('twelve setups are the most a job takes');
  const t = turnedSize(turn, size);
  const fresh: SetupPart = { name: name?.trim() || `${turnLabel(turn)}`, turn, stock: { kind: 'block', x: t.x, y: t.y, z: t.z, top: 0 }, operations: [], obstacles: [] };
  // names tell setups apart
  let n = fresh.name;
  for (let k = 2; setups.some((s) => s.name === n); k++) n = `${fresh.name} ${k}`;
  fresh.name = n;
  const next = [...setups.slice(0, at + 1), fresh, ...setups.slice(at + 1)];
  return withSetup(job, next, at + 1);
}

/** Take the setup in hand out of the job (the one before it comes in hand). The last one stays. */
export function removeSetup(job: Job): Job {
  const { setups, at } = setupList(job);
  if (setups.length < 2) throw new CamError('a job needs one setup');
  const next = setups.filter((_, k) => k !== at);
  const j = withSetup(job, next, Math.max(0, at - 1));
  if (next.length === 1 && next[0]!.name === 'Setup 1') {
    const { setups: _s, ...rest } = j;
    return rest;
  }
  return j;
}

export function renameSetup(job: Job, name: string): Job {
  const { setups, at } = setupList(job);
  const n = name.trim();
  if (!n) return job;
  return withSetup(job, setups.map((s, k) => (k === at ? { ...s, name: n } : s)), at);
}
