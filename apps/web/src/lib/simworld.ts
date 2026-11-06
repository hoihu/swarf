/**
 * What is really on the simulated machine, shared by the simulated controller (what the probe
 * touches) and the simulated camera (what it sees): the block, a little off from the job and not
 * quite at the height the work zero says, slightly tilted; what holds it (a choice of setups,
 * sim/setups.ts); and the touch plate when one is used. Positions are physical: work coordinates of the
 * work zero the simulator started with (`origin`, machine coordinates), so setting a new work
 * zero does not move the block.
 */
import type { Job } from '@swarf/cam';
import { touches, type Solid } from './sim/solids.ts';
import { blockTopAt, buildSetup, type SetupName, type StockError } from './sim/setups.ts';

type V3 = [number, number, number];

export const simWorld = {
  /** Machine coordinates of the simulator's original work zero. */
  origin: null as V3 | null,
  /** The real block against the job's: corner offset, size difference, turn (°), top too high/low, tilt (mm per mm along X and Y). */
  stockError: { dx: 0.8, dy: -0.6, dsx: 0.4, dsy: -0.3, angle: 0.25, dz: -0.37, tiltX: 0.0004, tiltY: -0.0006 } as StockError,
  /** How the block is held (sim/setups.ts). */
  setup: 'side' as SetupName,
  /** The simulated controller's real state (machine position, laser output), while connected. */
  truth: null as null | { pos: () => V3; laser: () => boolean },
  plate: null as null | { x: number; y: number; size: number; thickness: number },
  /** Diameter of the tool in the spindle (for contact). */
  toolDiameter: 6,
  /** Length of the tool below the spindle (contact with its side). */
  toolLength: 40,

  /** Everything on the table: the block, what holds it, the touch plate; and the table's top. */
  world(job: Job): { solids: Solid[]; floor: number } {
    if (job.stock.kind !== 'block') return { solids: [], floor: 0 };
    const w = buildSetup(job.stock, this.stockError, this.setup);
    const p = this.plate;
    if (p) {
      const z = this.topAt(job, p.x, p.y);
      w.solids.push({ kind: 'box', name: 'touch plate', cx: p.x, cy: p.y, w: p.size, d: p.size, z0: z, z1: z + p.thickness, angle: 0, conductive: true, look: 'copper' });
    }
    return w;
  },

  /** What holds the block (its obstacles). */
  obstacles(job: Job): Solid[] {
    return this.world(job).solids.filter((s) => !s.stock && s.name !== 'touch plate');
  },

  /** The block's top at a point (work coordinates at the start), with its error and tilt. */
  topAt(job: Job, x: number, y: number): number {
    if (job.stock.kind !== 'block') return 0;
    return blockTopAt(job.stock, this.stockError, x, y);
  },

  /** Is (x, y) on the real block (work coordinates at the start)? */
  onBlock(job: Job, x: number, y: number, grow = 0): boolean {
    if (job.stock.kind !== 'block') return false;
    const e = this.stockError;
    const a = (e.angle * Math.PI) / 180;
    // into the block's frame: its front-left corner at the origin, turned back
    const px = x - e.dx;
    const py = y - e.dy;
    const u = px * Math.cos(a) + py * Math.sin(a);
    const v = -px * Math.sin(a) + py * Math.cos(a);
    return u >= -grow && v >= -grow && u <= job.stock.x + e.dsx + grow && v <= job.stock.y + e.dsy + grow;
  },

  /**
   * Does the tool (a cylinder of the tool's diameter, from the tip up) touch anything conductive at
   * this machine position: the block (with a clip on it), the steel holding it, or the touch plate?
   */
  contact(job: Job, mpos: V3): boolean {
    return this.touching(job, mpos) !== null;
  },

  /** What the tool touches at this machine position, if anything. */
  touching(job: Job, mpos: V3): Solid | null {
    if (!this.origin || job.stock.kind !== 'block') return null;
    const o = this.origin;
    return touches(this.world(job).solids, this.toolDiameter / 2, this.toolLength, mpos[0] - o[0], mpos[1] - o[1], mpos[2] - o[2]);
  },
};

// for tests and the curious: what the simulator holds as the truth
if (typeof window !== 'undefined') (window as unknown as { __swarfSimWorld?: typeof simWorld }).__swarfSimWorld = simWorld;
