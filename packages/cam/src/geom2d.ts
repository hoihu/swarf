/**
 * 2D regions for the mill: closed loops (even-odd: outer boundaries and their islands) offset with
 * Clipper (clipper-lib, Angus Johnson's Clipper 6 in JavaScript, Boost licence) on a 1 µm integer
 * grid, and orientation helpers so every cut can run climb (material on the right of the travel,
 * spindle M3).
 */
import ClipperLib from 'clipper-lib';

type Paths64 = ClipperLib.IntPoint[][];

export type Pt = [number, number];
/** Closed: the last point joins back to the first (not repeated). */
export type Loop = Pt[];

const SCALE = 1000; // µm

const toPaths = (loops: Loop[]): Paths64 => loops.map((l) => l.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));

const fromPaths = (ps: Paths64): Loop[] => ps.filter((p) => p.length >= 3).map((p) => p.map((q) => [q.X / SCALE, q.Y / SCALE] as Pt));

function boolean(type: ClipperLib.ClipType, subject: Paths64, clip: Paths64, fill: ClipperLib.PolyFillType): Paths64 {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out: Paths64 = [];
  c.Execute(type, out, fill, fill);
  return out;
}

const union = (a: Paths64, fill = ClipperLib.PolyFillType.pftNonZero) => boolean(ClipperLib.ClipType.ctUnion, a, [], fill);

/** Signed area (positive = counter-clockwise, y up). */
export function area(l: Loop): number {
  let a = 0;
  for (let i = 0; i < l.length; i++) {
    const [x0, y0] = l[i]!;
    const [x1, y1] = l[(i + 1) % l.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export function pointInLoop(p: Pt, l: Loop): boolean {
  let inside = false;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const [xi, yi] = l[i]!;
    const [xj, yj] = l[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** How many other loops contain this one (even = an outer boundary, odd = a hole/island). */
export function depthOf(l: Loop, all: Loop[]): number {
  const probe = l[0]!;
  return all.filter((o) => o !== l && pointInLoop(probe, o)).length;
}

/** The region the loops enclose (even-odd), cleaned up: overlaps merged, holes kept. */
export function normalize(loops: Loop[]): Loop[] {
  return fromPaths(union(toPaths(loops), ClipperLib.PolyFillType.pftEvenOdd));
}

/** Offset loops that are all counter-clockwise (outer boundaries), merged where they overlap. */
function offsetCCW(loops: Loop[], delta: number): Paths64 {
  const co = new ClipperLib.ClipperOffset(2, 5);
  co.AddPaths(toPaths(loops.map((l) => (area(l) < 0 ? [...l].reverse() : l))), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: Paths64 = [];
  co.Execute(out, delta * SCALE);
  return union(out);
}

/**
 * Grow (delta > 0) or shrink (delta < 0) the region the loops enclose (even-odd). Round corners,
 * arcs within 5 µm. Done level by level of nesting: outer boundaries move by delta and the
 * islands in them by −delta, then islands of islands again by delta, and so on.
 */
export function offsetRegion(loops: Loop[], delta: number): Loop[] {
  if (!loops.length) return [];
  const clean = normalize(loops);
  if (Math.abs(delta) < 1e-9) return clean;
  const byDepth = new Map<number, Loop[]>();
  for (const l of clean) {
    const dd = depthOf(l, clean);
    byDepth.set(dd, [...(byDepth.get(dd) ?? []), l]);
  }
  let region: Paths64 = [];
  for (const dd of [...byDepth.keys()].sort((a, b) => a - b)) {
    const ls = byDepth.get(dd)!;
    region =
      dd % 2 === 0
        ? union([...region, ...offsetCCW(ls, delta)])
        : boolean(ClipperLib.ClipType.ctDifference, region, offsetCCW(ls, -delta), ClipperLib.PolyFillType.pftNonZero);
  }
  return fromPaths(region);
}

/** Orient so the region is on the right of the travel (climb with M3 along its boundary from outside) or on the left. */
export function orient(loops: Loop[], regionOnRight: boolean): Loop[] {
  return loops.map((l) => {
    const hole = depthOf(l, loops) % 2 === 1;
    // CCW outer boundary has the region on its left
    const ccw = area(l) > 0;
    const regionLeft = hole ? !ccw : ccw;
    return regionLeft === !regionOnRight ? l : [...l].reverse();
  });
}

/** What two regions (even-odd) have in common. */
export function intersect(a: Loop[], b: Loop[]): Loop[] {
  if (!a.length || !b.length) return [];
  return fromPaths(boolean(ClipperLib.ClipType.ctIntersection, toPaths(a), toPaths(b), ClipperLib.PolyFillType.pftEvenOdd));
}

/** Is the point in the region the loops enclose (even-odd)? */
export function inRegion(p: Pt, loops: Loop[]): boolean {
  let n = 0;
  for (const l of loops) if (pointInLoop(p, l)) n++;
  return n % 2 === 1;
}

/** The area of the region the loops enclose (even-odd, loops not crossing). */
export function regionArea(loops: Loop[]): number {
  let a = 0;
  for (const l of loops) a += (depthOf(l, loops) % 2 === 1 ? -1 : 1) * Math.abs(area(l));
  return a;
}

export function bbox(paths: Pt[][]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of paths)
    for (const [x, y] of p) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Drop points closer than `tol` to the previous one (and a closing duplicate). */
export function dedupe(pts: Pt[], closed: boolean, tol = 1e-4): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out.at(-1);
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > tol) out.push(p);
  }
  if (closed && out.length > 1) {
    const [a, b] = [out[0]!, out.at(-1)!];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol) out.pop();
  }
  return out;
}
