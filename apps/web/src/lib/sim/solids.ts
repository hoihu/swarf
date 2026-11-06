/**
 * The simulated world as solids: boxes (turned about Z, the block's top may slope) and upright
 * cylinders (bolts, nuts, screw heads), in work coordinates of the simulator's original work zero.
 * One description serves the simulated controller (what the probe touches), the simulated camera
 * (meshes) and the tests (heights, rays: a laser scan without a browser).
 */

export type V3 = [number, number, number];

interface Common {
  name: string;
  /** Touching it closes the probe circuit (steel clamped to the stock with a clip on it). */
  conductive: boolean;
  /** What it looks like in the simulated camera. */
  look: 'stock' | 'steel' | 'dark' | 'copper';
  /** The stock itself (not an obstacle). */
  stock?: boolean;
}

export type Solid =
  | (Common & {
      kind: 'box';
      /** Centre in X/Y, size along its own X/Y, bottom and top. */
      cx: number;
      cy: number;
      w: number;
      d: number;
      z0: number;
      z1: number;
      /** Turned about Z (degrees, counter-clockwise). */
      angle: number;
      /** The top slopes: z1 + sx·(x − cx) + sy·(y − cy) (mm per mm, machine X/Y). */
      slope?: [number, number];
    })
  | (Common & { kind: 'cyl'; cx: number; cy: number; r: number; z0: number; z1: number });

/** Into a box's own frame (centred, turned back). */
function local(b: Extract<Solid, { kind: 'box' }>, x: number, y: number): [number, number] {
  const a = (b.angle * Math.PI) / 180;
  const px = x - b.cx;
  const py = y - b.cy;
  return [px * Math.cos(a) + py * Math.sin(a), -px * Math.sin(a) + py * Math.cos(a)];
}

/** The top of a solid above (x, y) (its slope included). */
export function topOf(s: Solid, x: number, y: number): number {
  if (s.kind === 'box' && s.slope) return s.z1 + s.slope[0] * (x - s.cx) + s.slope[1] * (y - s.cy);
  return s.z1;
}

/** Horizontal distance from (x, y) to the solid's outline (0 inside), and the nearest point of it. */
export function footprintDistance(s: Solid, x: number, y: number): { dist: number; at: [number, number] } {
  if (s.kind === 'cyl') {
    const d = Math.hypot(x - s.cx, y - s.cy);
    if (d <= s.r) return { dist: 0, at: [x, y] };
    return { dist: d - s.r, at: [s.cx + ((x - s.cx) * s.r) / d, s.cy + ((y - s.cy) * s.r) / d] };
  }
  const [u, v] = local(s, x, y);
  const cu = Math.min(Math.max(u, -s.w / 2), s.w / 2);
  const cv = Math.min(Math.max(v, -s.d / 2), s.d / 2);
  const a = (s.angle * Math.PI) / 180;
  return { dist: Math.hypot(u - cu, v - cv), at: [s.cx + cu * Math.cos(a) - cv * Math.sin(a), s.cy + cu * Math.sin(a) + cv * Math.cos(a)] };
}

/** The highest surface above (x, y), or `floor` (the table) where there is none. */
export function heightAt(solids: Solid[], x: number, y: number, floor: number): number {
  let h = floor;
  for (const s of solids) if (footprintDistance(s, x, y).dist === 0) h = Math.max(h, topOf(s, x, y));
  return h;
}

/**
 * Does a cutter (radius r, from its tip at (x, y, z) up `length`) touch a conductive solid? It
 * touches when its circle reaches the outline below the solid's top there (the highest point
 * under the cutter's end when it is above the solid).
 */
export function touches(solids: Solid[], r: number, length: number, x: number, y: number, z: number): Solid | null {
  for (const s of solids) {
    if (!s.conductive) continue;
    if (z + length < s.z0) continue;
    const f = footprintDistance(s, x, y);
    if (f.dist > r) continue;
    const top =
      f.dist === 0 ? Math.max(...[[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].map(([ox, oy]) => (footprintDistance(s, x + ox!, y + oy!).dist === 0 ? topOf(s, x + ox!, y + oy!) : -Infinity))) : topOf(s, f.at[0], f.at[1]);
    if (z <= top) return s;
  }
  return null;
}

/**
 * The first solid a ray meets (origin o, direction d, not necessarily unit): the distance along
 * it (in units of d) or null. A box is the region inside six planes (four sides, the bottom, the
 * sloping top); a cylinder is its side and caps.
 */
export function raycast(solids: Solid[], o: V3, d: V3, floor?: number): { t: number; solid: Solid | null } | null {
  let best: { t: number; solid: Solid | null } | null = null;
  const take = (t: number, solid: Solid | null) => {
    if (t > 1e-9 && (!best || t < best.t)) best = { t, solid };
  };
  for (const s of solids) {
    const t = s.kind === 'box' ? hitBox(s, o, d) : hitCyl(s, o, d);
    if (t !== null) take(t, s);
  }
  if (floor !== undefined && Math.abs(d[2]) > 1e-12) take((floor - o[2]) / d[2], null);
  return best;
}

/** Ray against a convex region n·X ≤ c (Cyrus–Beck). */
function hitPlanes(planes: { n: V3; c: number }[], o: V3, d: V3): number | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const { n, c } of planes) {
    const nd = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    const no = n[0] * o[0] + n[1] * o[1] + n[2] * o[2];
    if (Math.abs(nd) < 1e-12) {
      if (no > c) return null;
      continue;
    }
    const t = (c - no) / nd;
    if (nd < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return t0 > 1e-9 ? t0 : null;
}

function hitBox(b: Extract<Solid, { kind: 'box' }>, o: V3, d: V3): number | null {
  const a = (b.angle * Math.PI) / 180;
  const ex: V3 = [Math.cos(a), Math.sin(a), 0];
  const ey: V3 = [-Math.sin(a), Math.cos(a), 0];
  const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const C: V3 = [b.cx, b.cy, 0];
  const [sx, sy] = b.slope ?? [0, 0];
  // top: z − sx·x − sy·y ≤ z1 − sx·cx − sy·cy
  const planes = [
    { n: ex, c: dot(ex, C) + b.w / 2 },
    { n: [-ex[0], -ex[1], 0] as V3, c: -dot(ex, C) + b.w / 2 },
    { n: ey, c: dot(ey, C) + b.d / 2 },
    { n: [-ey[0], -ey[1], 0] as V3, c: -dot(ey, C) + b.d / 2 },
    { n: [0, 0, -1] as V3, c: -b.z0 },
    { n: [-sx, -sy, 1] as V3, c: b.z1 - sx * b.cx - sy * b.cy },
  ];
  return hitPlanes(planes, o, d);
}

function hitCyl(c: Extract<Solid, { kind: 'cyl' }>, o: V3, d: V3): number | null {
  let best: number | null = null;
  const take = (t: number) => {
    if (t > 1e-9 && (best === null || t < best)) best = t;
  };
  // side
  const ox = o[0] - c.cx;
  const oy = o[1] - c.cy;
  const A = d[0] * d[0] + d[1] * d[1];
  if (A > 1e-12) {
    const B = 2 * (ox * d[0] + oy * d[1]);
    const Cc = ox * ox + oy * oy - c.r * c.r;
    const disc = B * B - 4 * A * Cc;
    if (disc >= 0) {
      for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
        const z = o[2] + t * d[2];
        if (z >= c.z0 && z <= c.z1) take(t);
      }
    }
  }
  // caps
  if (Math.abs(d[2]) > 1e-12)
    for (const z of [c.z0, c.z1]) {
      const t = (z - o[2]) / d[2];
      const x = ox + t * d[0];
      const y = oy + t * d[1];
      if (x * x + y * y <= c.r * c.r) take(t);
    }
  return best;
}
