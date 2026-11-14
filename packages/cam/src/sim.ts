/**
 * A coarse material model, good enough to catch rapids into material and too-deep cuts, and to
 * show the part in the preview. Lathe: outer radius and bore radius per Z slice (1D). Mill: a
 * height map over the block (2.5D, flat tools). The tool is a simple footprint: turning tool =
 * the tip plus its cutting edge behind it (+Z), grooving blade = its width towards the chuck,
 * drill/endmill = a disc. Nose radius and drill point angle are ignored.
 */
import { arcPoints, type Move } from './program.ts';
import type { Stock, Tool, Vec3 } from './schema.ts';

const EPS = 0.02;

/** Points along a move, at most `step` apart (start excluded, end included). */
export function samplePath(from: Vec3, m: Move, step: number): Vec3[] {
  if (m.type === 'arc') {
    const pts = arcPoints(from, m, step);
    return pts;
  }
  const len = Math.hypot(m.to.x - from.x, m.to.y - from.y, m.to.z - from.z);
  const n = Math.max(1, Math.ceil(len / step));
  const out: Vec3[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push({ x: from.x + (m.to.x - from.x) * t, y: from.y + (m.to.y - from.y) * t, z: from.z + (m.to.z - from.z) * t });
  }
  return out;
}

export interface Hit {
  /** Where the tool touched material. */
  at: Vec3;
  /** How far into it (mm). */
  depth: number;
}

// ---------------------------------------------------------------- lathe

export class LatheMaterial {
  readonly dz: number;
  /** Z of slice 0 (the chuck face). */
  readonly z0: number;
  readonly n: number;
  /** Outer radius per slice. */
  readonly r: Float32Array;
  /** Bore radius per slice (0 = solid). */
  readonly b: Float32Array;

  constructor(stock: Extract<Stock, { kind: 'bar' }>, dz = 0.05) {
    this.dz = dz;
    this.z0 = stock.front - stock.stickout;
    this.n = Math.max(1, Math.round(stock.stickout / dz));
    this.r = new Float32Array(this.n).fill(stock.diameter / 2);
    this.b = new Float32Array(this.n);
  }

  /** Z of the chuck face. */
  get chuckZ(): number {
    return this.z0;
  }

  zAt(i: number): number {
    return this.z0 + (i + 0.5) * this.dz;
  }

  private range(zLo: number, zHi: number): [number, number] {
    // slices whose centre lies in [zLo, zHi]
    const a = Math.max(0, Math.ceil((zLo - this.z0) / this.dz - 0.5 - 1e-9));
    const b = Math.min(this.n - 1, Math.floor((zHi - this.z0) / this.dz - 0.5 + 1e-9));
    return [a, b];
  }

  /** Bore radius at Z (0 = solid, or outside the stock). */
  boreAt(z: number): number {
    const i = Math.floor((z - this.z0) / this.dz);
    return i >= 0 && i < this.n ? this.b[i]! : 0;
  }

  /** Outer radius at Z (0 outside the stock). */
  radiusAt(z: number): number {
    const i = Math.floor((z - this.z0) / this.dz);
    return i >= 0 && i < this.n ? this.r[i]! : 0;
  }

  /** The Z span the tool occupies behind its tip (relative to the tip Z). */
  static footprint(tool: Tool): [number, number] {
    if (tool.type === 'grooving') return [-(tool.width ?? 2), 0];
    if (tool.type === 'threading') return [-(tool.edgeLength ?? 1.5) / 2, (tool.edgeLength ?? 1.5) / 2];
    if (tool.type === 'drill') return [0, tool.fluteLength ?? 30];
    return [0, tool.edgeLength ?? 3];
  }

  /** Remove what a feed move cuts. */
  cut(from: Vec3, to: Vec3, tool: Tool): void {
    const [lo, hi] = LatheMaterial.footprint(tool);
    const zmin = Math.min(from.z, to.z);
    const zmax = Math.max(from.z, to.z);
    if (tool.type === 'drill') {
      const rad = (tool.diameter ?? 0) / 2;
      const [a, c] = this.range(zmin, zmax + hi);
      for (let i = a; i <= c; i++) if (this.b[i]! < rad) this.b[i] = rad;
      return;
    }
    if (tool.type === 'boring') {
      // the bar opens the bore up to its tip
      const xMax = (z: number) => (Math.abs(to.z - from.z) < 1e-9 ? Math.max(from.x, to.x) : from.x + ((to.x - from.x) * (z - from.z)) / (to.z - from.z));
      const [a, c] = this.range(zmin + lo, zmax + hi);
      for (let i = a; i <= c; i++) {
        const zs = this.zAt(i);
        const wLo = Math.max(zmin, zs - hi);
        const wHi = Math.min(zmax, zs - lo);
        if (wLo > wHi + 1e-9) continue;
        const x = Math.max(xMax(wLo), xMax(wHi));
        if (x > this.b[i]!) this.b[i] = Math.min(x, this.r[i]!);
      }
      return;
    }
    const xAt = (z: number) => (Math.abs(to.z - from.z) < 1e-9 ? Math.min(from.x, to.x) : from.x + ((to.x - from.x) * (z - from.z)) / (to.z - from.z));
    const [a, c] = this.range(zmin + lo, zmax + hi);
    for (let i = a; i <= c; i++) {
      const zs = this.zAt(i);
      // tip positions whose footprint covers this slice
      const wLo = Math.max(zmin, zs - hi);
      const wHi = Math.min(zmax, zs - lo);
      if (wLo > wHi + 1e-9) continue;
      const x = Math.max(0, Math.min(xAt(wLo), xAt(wHi)));
      if (x < this.r[i]!) this.r[i] = x;
    }
  }

  /** Would the tool at this tip position overlap material? */
  hit(p: Vec3, tool: Tool): Hit | null {
    const [lo, hi] = LatheMaterial.footprint(tool);
    if (tool.type === 'drill') {
      const rad = (tool.diameter ?? 0) / 2;
      const [a, c] = this.range(p.z, p.z + Math.min(hi, 2));
      for (let i = a; i <= c; i++) {
        if (this.b[i]! < this.r[i]! - EPS && this.b[i]! < rad - EPS && Math.abs(p.x) < this.r[i]!) return { at: p, depth: rad - this.b[i]! };
      }
      return null;
    }
    const [a, c] = this.range(p.z + lo, p.z + hi);
    let best: Hit | null = null;
    if (tool.internal) {
      // an internal tool is in material where its tip is past the bore wall
      for (let i = a; i <= c; i++) {
        const solid = this.b[i]! < this.r[i]! - EPS;
        const depth = Math.min(p.x, this.r[i]!) - this.b[i]!;
        if (solid && depth > EPS && (!best || depth > best.depth)) best = { at: p, depth };
      }
      return best;
    }
    for (let i = a; i <= c; i++) {
      const solid = this.b[i]! < this.r[i]! - EPS;
      const depth = this.r[i]! - p.x;
      if (solid && depth > EPS && (!best || depth > best.depth)) best = { at: p, depth };
    }
    return best;
  }
}

// ---------------------------------------------------------------- mill

/**
 * How far above its tip a cutter's cutting surface is at a distance from its axis (given
 * squared): nothing for a flat end mill; a pointed cutter rises as a cone from its tip flat.
 */
function lifter(tool: Tool): (d2: number) => number {
  if (tool.type !== 'chamfer') return () => 0;
  const tip = (tool.tipDiameter ?? 0) / 2;
  const slope = 1 / Math.tan((((tool.angle ?? 90) / 2) * Math.PI) / 180);
  return (d2) => Math.max(0, Math.sqrt(d2) - tip) * slope;
}

/** Stretches of metal per column of a height map's grid (see MillMaterial.spans). */
export interface Spans {
  at: Uint32Array;
  z: Float32Array;
}

export class MillMaterial {
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly top: number;
  readonly bottom: number;
  /** Top Z per cell, row-major (y * nx + x); cell centre at ((i + .5) * cell, (j + .5) * cell). */
  readonly h: Float32Array;
  readonly sx: number;
  readonly sy: number;
  /**
   * What earlier setups left of each column, when the part came over from one: the stretches of Z
   * that are metal, bottom up (`z[at[k] .. at[k + 1]]` in pairs for cell k). The height map is
   * the top of the highest one; below it there may be hollows a view from above cannot hold.
   */
  readonly spans: Spans | null;
  /**
   * Where a wall stands between two neighbouring cells, as the cutter's round edge left it: on
   * the line from cell k's centre to the next cell's in X (ex) or Y (ey), as a fraction of the
   * way (NaN: not known). For the picture: the heights alone only say which centres were cut, so
   * a round wall drawn from them steps along the grid. The checks do not use it.
   */
  readonly ex: Float32Array;
  readonly ey: Float32Array;
  /** Note the walls (ex, ey) while cutting: for the preview only, it costs time. */
  noteWalls = false;
  /** How many times a cell has been cut down by more than a hundredth (for the preview: is it taking metal off?). */
  lowered = 0;

  constructor(stock: Extract<Stock, { kind: 'block' }>, cell?: number, start?: { h: Float32Array; spans: Spans } | null) {
    this.cell = cell ?? Math.max(0.2, Math.min(1, Math.max(stock.x, stock.y) / 300));
    this.sx = stock.x;
    this.sy = stock.y;
    this.nx = Math.max(1, Math.ceil(stock.x / this.cell));
    this.ny = Math.max(1, Math.ceil(stock.y / this.cell));
    this.top = stock.top;
    this.bottom = stock.top - stock.z;
    this.h = new Float32Array(this.nx * this.ny).fill(stock.top);
    this.ex = new Float32Array(this.nx * this.ny).fill(NaN);
    this.ey = new Float32Array(this.nx * this.ny).fill(NaN);
    this.spans = null;
    if (start && start.h.length === this.h.length) {
      this.h.set(start.h);
      this.spans = start.spans;
    }
  }

  /** Calls fn for every cell whose centre lies within `radius` of p (with its distance from p, squared). */
  private each(p: Vec3, radius: number, fn: (k: number, d2: number) => void): void {
    if (radius <= 0) return;
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((p.x - radius) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((p.x + radius) / c));
    const j0 = Math.max(0, Math.floor((p.y - radius) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((p.y + radius) / c));
    const r2 = radius * radius;
    for (let j = j0; j <= j1; j++) {
      const dy = (j + 0.5) * c - p.y;
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5) * c - p.x;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) fn(j * this.nx + i, d2);
      }
    }
  }

  /** Deepest material above the tool bottom under its footprint at p. */
  engagement(p: Vec3, tool: Tool): number {
    let worst = 0;
    // shrunk by one cell: the wall the tool runs along is not material it cuts
    const lift = lifter(tool);
    this.each(p, (tool.diameter ?? 1) / 2 - this.cell, (k, d2) => {
      const above = this.h[k]! - Math.max(p.z + lift(d2), this.bottom);
      if (this.h[k]! > this.bottom + EPS && above > worst) worst = above;
    });
    return worst;
  }

  hit(p: Vec3, tool: Tool): Hit | null {
    const e = this.engagement(p, tool);
    return e > EPS ? { at: p, depth: e } : null;
  }

  /** Cut along a feed move; returns the deepest engagement seen. */
  cutPath(points: Vec3[], tool: Tool): number {
    const radius = (tool.diameter ?? 1) / 2;
    // depth is judged against the material before this move (a sample right behind the
    // previous one would otherwise only ever see the sliver it adds)
    let worst = 0;
    for (const p of points) worst = Math.max(worst, this.engagement(p, tool));
    const lift = lifter(tool);
    // a cutter with straight sides leaves a wall where its circle ends: noted between the cells
    const walls = this.noteWalls && tool.type !== 'chamfer';
    const c = this.cell;
    const r2 = radius * radius;
    const rim = Math.max(0, radius - c * 1.01) ** 2;
    for (const p of points) {
      this.each(p, radius, (k, d2) => {
        const z = Math.max(p.z + lift(d2), this.bottom);
        const lowered = this.h[k]! > z + 1e-6;
        if (lowered) {
          if (this.h[k]! > z + 0.01) this.lowered++;
          this.h[k] = z;
        }
        // only a cell near the circle's edge has a neighbour outside it, and only one at this
        // cut's level has its wall from this cut (one already deeper has it from another)
        if (!walls || d2 < rim || (!lowered && Math.abs(this.h[k]! - z) > 1e-6)) return;
        const i = k % this.nx;
        const j = (k - i) / this.nx;
        const fx = (i + 0.5) * c - p.x;
        const fy = (j + 0.5) * c - p.y;
        for (let q = 0; q < 4; q++) {
          const di = q < 2 ? 1 - 2 * q : 0;
          const dj = q < 2 ? 0 : 5 - 2 * q;
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.ny) continue;
          const n = nj * this.nx + ni;
          // the neighbour is not higher, or inside this circle too: no wall of this cut there
          if (this.h[n]! <= z + EPS) continue;
          const gx = fx + di * c;
          const gy = fy + dj * c;
          if (gx * gx + gy * gy <= r2) continue;
          // where the circle leaves the line from this centre to the neighbour's: |f + t·d| = r
          const b = (fx * di + fy * dj) * c;
          const cc = fx * fx + fy * fy - r2;
          const t = Math.min(1, Math.max(0, (-b + Math.sqrt(Math.max(0, b * b - c * c * cc))) / (c * c)));
          // kept per edge from the lower-numbered cell; the furthest any circle at this level reached
          const e = di ? this.ex : this.ey;
          const at = di > 0 || dj > 0 ? k : n;
          const v = di > 0 || dj > 0 ? t : 1 - t;
          const old = e[at]!;
          if (lowered || Number.isNaN(old)) e[at] = v;
          else e[at] = di > 0 || dj > 0 ? Math.max(old, v) : Math.min(old, v);
        }
      });
    }
    return worst;
  }
}
