/**
 * What is really on the simulated machine, shared by the simulated controller (what the probe
 * touches) and the simulated camera (what it sees): the block, a little off from the job and not
 * quite at the height the work zero says, slightly tilted; two clamps beside it, taller than the
 * block; and the touch plate when one is used. Positions are physical: work coordinates of the
 * work zero the simulator started with (`origin`, machine coordinates), so setting a new work
 * zero does not move the block.
 */
import type { Job } from '@swarf/cam';

type V3 = [number, number, number];

export interface Box {
  /** Corner and size in the block's frame of reference: work X/Y at the start, Z from the stock top. */
  x: number;
  y: number;
  w: number;
  d: number;
  /** Bottom and top, work Z at the start. */
  z0: number;
  z1: number;
}

export const simWorld = {
  /** Machine coordinates of the simulator's original work zero. */
  origin: null as V3 | null,
  /** The real block against the job's: corner offset, size difference, turn (°), top too high/low, tilt (mm per mm along X and Y). */
  stockError: { dx: 0.8, dy: -0.6, dsx: 0.4, dsy: -0.3, angle: 0.25, dz: -0.37, tiltX: 0.0004, tiltY: -0.0006 },
  /** Two clamps holding the block down, taller than it (relative to the job's stock: filled in by `clamps()`). */
  clampsOn: true,
  plate: null as null | { x: number; y: number; size: number; thickness: number },
  /** Diameter of the tool in the spindle (for contact). */
  toolDiameter: 6,
  /** Length of the tool below the spindle (contact with its side). */
  toolLength: 40,

  /** The clamps, from the job's block: one either side, in the middle of Y, 8 mm above the top. */
  clamps(job: Job): Box[] {
    if (!this.clampsOn || job.stock.kind !== 'block') return [];
    const s = job.stock;
    const bottom = s.top - s.z;
    return [
      { x: -22, y: s.y / 2 - 9, w: 18, d: 18, z0: bottom, z1: s.top + 8 },
      { x: s.x + 4, y: s.y / 2 - 9, w: 18, d: 18, z0: bottom, z1: s.top + 8 },
    ];
  },

  /** The block's top at a point (work coordinates at the start), with its error and tilt. */
  topAt(job: Job, x: number, y: number): number {
    if (job.stock.kind !== 'block') return 0;
    const e = this.stockError;
    return job.stock.top + e.dz + e.tiltX * x + e.tiltY * y;
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
   * this machine position: the block (with a clip on it), the clamps on it, or the touch plate?
   */
  contact(job: Job, mpos: V3): boolean {
    if (!this.origin || job.stock.kind !== 'block') return false;
    const r = this.toolDiameter / 2;
    const x = mpos[0] - this.origin[0];
    const y = mpos[1] - this.origin[1];
    const z = mpos[2] - this.origin[2];
    const s = job.stock;
    // the block: the cutter's circle reaches its outline (exact distance in the block's frame) below its top
    const bottom = s.top - s.z;
    if (z + this.toolLength >= bottom) {
      const e = this.stockError;
      const a = (e.angle * Math.PI) / 180;
      const px = x - e.dx;
      const py = y - e.dy;
      const u = px * Math.cos(a) + py * Math.sin(a);
      const v = -px * Math.sin(a) + py * Math.cos(a);
      const W = s.x + e.dsx;
      const D = s.y + e.dsy;
      const cu = Math.min(Math.max(u, 0), W);
      const cv = Math.min(Math.max(v, 0), D);
      if (Math.hypot(u - cu, v - cv) <= r) {
        // the nearest point of the block under the cutter, back in work coordinates, for its height
        const nx = e.dx + cu * Math.cos(a) - cv * Math.sin(a);
        const ny = e.dy + cu * Math.sin(a) + cv * Math.cos(a);
        // inside the footprint the highest point under the cutter's end counts (tilt: a corner of it)
        const inside = u >= 0 && v >= 0 && u <= W && v <= D;
        const top = inside ? Math.max(...[[r, 0], [-r, 0], [0, r], [0, -r], [0, 0]].map(([ox, oy]) => this.topAt(job, x + ox!, y + oy!))) : this.topAt(job, nx, ny);
        if (z <= top) return true;
      }
    }
    for (const c of this.clamps(job)) {
      const dx = Math.max(c.x - x, 0, x - (c.x + c.w));
      const dy = Math.max(c.y - y, 0, y - (c.y + c.d));
      if (Math.hypot(dx, dy) <= r && z <= c.z1 && z + this.toolLength >= c.z0) return true;
    }
    const p = this.plate;
    if (p) {
      const top = this.topAt(job, p.x, p.y) + p.thickness;
      const dx = Math.max(p.x - p.size / 2 - x, 0, x - (p.x + p.size / 2));
      const dy = Math.max(p.y - p.size / 2 - y, 0, y - (p.y + p.size / 2));
      if (Math.hypot(dx, dy) <= r && z <= top) return true;
    }
    return false;
  },
};

// for tests and the curious: what the simulator holds as the truth
if (typeof window !== 'undefined') (window as unknown as { __swarfSimWorld?: typeof simWorld }).__swarfSimWorld = simWorld;
