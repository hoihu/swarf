/**
 * A coarse material model, good enough to catch rapids into material and too-deep cuts, and to
 * show the part in the preview. Lathe: outer radius and bore radius per Z slice (1D). Mill: a
 * height map over the block (2.5D, flat tools). The tool is a simple footprint: turning tool =
 * the tip plus its cutting edge behind it (+Z), grooving blade = its width towards the chuck,
 * drill/endmill = a disc. Nose radius and drill point angle are ignored.
 */
import { arcPoints, type Move } from './program.ts';
import { cone, type Stock, type Tool, type Vec3 } from './schema.ts';

const EPS = 0.02;

/** Points along a move, at most `step` apart (start excluded, end included). */
export function samplePath(from: Vec3, m: Move, step: number): Vec3[] {
  if (m.type === 'arc') return arcPoints(from, m, step);
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
 * squared): null for a flat end mill (nothing); a pointed cutter rises as a cone from its tip flat.
 */
function lifter(tool: Tool): ((d2: number) => number) | null {
  if (tool.type !== 'chamfer') return null;
  const { tan, tipR } = cone(tool);
  const slope = 1 / tan;
  return (d2) => Math.max(0, Math.sqrt(d2) - tipR) * slope;
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

  /**
   * The cells whose centre lies within `radius` of p, a row at a time: fn(j, a, b, dy) for each
   * row j with any (columns a..b, dy from the centres to p). The span comes from the circle's
   * half-width at the row, nudged to the very cells the distance test picks (rounding at the rim).
   */
  private rows(p: Vec3, radius: number, fn: (j: number, a: number, b: number, dy: number) => void): void {
    if (radius <= 0) return;
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((p.x - radius) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((p.x + radius) / c));
    const j0 = Math.max(0, Math.floor((p.y - radius) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((p.y + radius) / c));
    const r2 = radius * radius;
    const inside = (i: number, dy: number) => {
      const dx = (i + 0.5) * c - p.x;
      return dx * dx + dy * dy <= r2;
    };
    for (let j = j0; j <= j1; j++) {
      const dy = (j + 0.5) * c - p.y;
      const w = Math.sqrt(Math.max(0, r2 - dy * dy));
      let a = Math.max(i0, Math.ceil((p.x - w) / c - 0.5));
      let b = Math.min(i1, Math.floor((p.x + w) / c - 0.5));
      while (b < i1 && inside(b + 1, dy)) b++;
      while (a > i0 && inside(a - 1, dy)) a--;
      while (a <= b && !inside(a, dy)) a++;
      while (b >= a && !inside(b, dy)) b--;
      if (a <= b) fn(j, a, b, dy);
    }
  }

  /** Deepest material above the tool bottom under its footprint at p. */
  engagement(p: Vec3, tool: Tool): number {
    let worst = 0;
    const c = this.cell;
    const lift = lifter(tool);
    const { h: hs, nx, bottom } = this;
    const floor = Math.max(p.z + 0, bottom); // (+ 0: never a -0 in the map)
    // shrunk by one cell: the wall the tool runs along is not material it cuts
    this.rows(p, (tool.diameter ?? 1) / 2 - c, (j, a, b, dy) => {
      for (let i = a, k = j * nx + a; i <= b; i++, k++) {
        const h = hs[k]!;
        if (h <= bottom + EPS) continue;
        // a flat cutter: the highest cell is the deepest (h - floor rounds the same way for all)
        if (!lift) {
          if (h - floor > worst) worst = h - floor;
          continue;
        }
        const dx = (i + 0.5) * c - p.x;
        const above = h - Math.max(p.z + lift(dx * dx + dy * dy), bottom);
        if (above > worst) worst = above;
      }
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
    const { h, nx, bottom } = this;
    for (const p of points) {
      const floor = Math.max(p.z + 0, bottom); // (+ 0: never a -0 in the map)
      this.rows(p, radius, (j, a, b, dy) => {
        // a flat cutter without walls to note needs no distance: one level over the whole span
        if (!lift && !walls) {
          for (let k = j * nx + a, e = j * nx + b; k <= e; k++) {
            if (h[k]! > floor + 1e-6) {
              if (h[k]! > floor + 0.01) this.lowered++;
              h[k] = floor;
            }
          }
          return;
        }
        for (let i = a, k = j * nx + a; i <= b; i++, k++) {
          const fx = (i + 0.5) * c - p.x;
          const d2 = fx * fx + dy * dy;
          const z = lift ? Math.max(p.z + lift(d2), bottom) : floor;
          const lowered = h[k]! > z + 1e-6;
          if (lowered) {
            if (h[k]! > z + 0.01) this.lowered++;
            h[k] = z;
          }
          // only a cell near the circle's edge has a neighbour outside it, and only one at this
          // cut's level has its wall from this cut (one already deeper has it from another)
          if (walls && d2 >= rim && (lowered || Math.abs(h[k]! - z) <= 1e-6)) this.wall(k, fx, dy, z, r2, lowered);
        }
      });
    }
    return worst;
  }

  /** Notes where a cut at level z, centre (fx, fy) from cell k's, leaves walls to k's neighbours. */
  private wall(k: number, fx: number, fy: number, z: number, r2: number, lowered: boolean): void {
    const c = this.cell;
    const i = k % this.nx;
    const j = (k - i) / this.nx;
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
  }
}
