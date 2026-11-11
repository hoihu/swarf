/**
 * Clearing a pocket with a small bite at full depth ("adaptive", "high-efficiency" clearing).
 *
 * The usual pocket runs rings parallel to the wall: the first cut is a full-width slot, and in
 * every inside corner the cutter is wrapped in material. Here the cleared area grows from where
 * the cutter came down, by one bite at a time: each pass runs along the edge of (what is cleared,
 * grown by the bite), kept inside the pocket. So the cutter never has more than the bite beside
 * it, and can take it over the whole depth of its flutes: long, thin chips instead of short,
 * thick ones, the wear spread along the flutes, less load on a small machine.
 *
 * This is the simple form of it: fronts that spread like ripples. Where a front runs along the
 * pocket's wall and nothing is left there, it is skipped, and the cutter crosses what is cleared
 * to where the front goes on.
 */
import { CamError } from '../program.ts';
import { area, depthOf, inRegion, intersect, normalize, offsetRegion, orient, regionArea, type Loop, type Pt } from '../geom2d.ts';

export interface AdaptivePass {
  pts: Pt[];
  closed: boolean;
}

export interface AdaptivePlan {
  /** Where the cutter comes down: a helix of radius `rh` about `c`. */
  entry: { c: Pt; rh: number };
  /** In cutting order; within a front the passes run so that the material is on the right. */
  fronts: {
    passes: AdaptivePass[];
    /** Where the cutter may cross at depth while this front is cut (what is cleared, and the bite being taken). */
    open: Loop[];
  }[];
}

const circle = (c: Pt, r: number, n = 48): Loop => Array.from({ length: n }, (_, k) => [c[0] + r * Math.cos((2 * Math.PI * k) / n), c[1] + r * Math.sin((2 * Math.PI * k) / n)] as Pt);

/** The parts of a region that hang together: each outer boundary with the holes in it. */
function parts(region: Loop[]): Loop[][] {
  const outers = region.filter((l) => depthOf(l, region) % 2 === 0);
  return outers.map((o) => [o, ...region.filter((l) => l !== o && depthOf(l, region) % 2 === 1 && inside(l[0]!, o, region))]);
}
/** Is the hole (by one of its points) directly inside this outer boundary? */
function inside(p: Pt, outer: Loop, region: Loop[]): boolean {
  // the innermost outer boundary that contains the point
  let best: Loop | null = null;
  for (const l of region) {
    if (depthOf(l, region) % 2 !== 0) continue;
    if (!inRegion(p, [l])) continue;
    if (!best || Math.abs(area(l)) < Math.abs(area(best))) best = l;
  }
  return best === outer;
}

/** The point of a region furthest from its edge, and how far that is (to about 0.05 mm). */
export function deepest(region: Loop[]): { c: Pt; depth: number } {
  let lo = 0;
  let hi = 1;
  while (offsetRegion(region, -hi).length && hi < 1e4) hi *= 2;
  while (hi - lo > 0.05) {
    const mid = (lo + hi) / 2;
    if (offsetRegion(region, -mid).length) lo = mid;
    else hi = mid;
  }
  const core = offsetRegion(region, -lo * 0.98);
  const l = (core.length ? core : region).reduce((a, b) => (Math.abs(area(a)) >= Math.abs(area(b)) ? a : b));
  let c: Pt = [l.reduce((s, p) => s + p[0], 0) / l.length, l.reduce((s, p) => s + p[1], 0) / l.length];
  if (!inRegion(c, region)) c = l[0]!;
  return { c, depth: lo };
}

/**
 * The passes that clear `region` (where the cutter's centre may go: the pocket less the cutter's
 * radius and any allowance), taking `bite` mm at a time, for a cutter of diameter `d`. One plan
 * per part of the region that hangs together.
 */
export function adaptivePlans(region0: Loop[], bite: number, d: number): AdaptivePlan[] {
  const region = normalize(region0);
  const plans: AdaptivePlan[] = [];
  for (const part of parts(region)) {
    const { c, depth } = deepest(part);
    if (depth < 0.2 * d) throw new CamError(`part of the pocket leaves the Ø${d} tool only ${(2 * depth).toFixed(1)} mm to move sideways: too narrow to clear with a small bite (it would start as a slot). Use the ordinary strategy there, or a smaller tool`);
    // a helix the cutter overlaps itself on (no post left standing in the middle)
    const rh = Math.min(depth, 0.45 * d);
    let cleared = intersect([circle(c, rh)], part);
    const fronts: AdaptivePlan['fronts'] = [];
    for (let k = 0; ; k++) {
      if (k > 4000) throw new CamError('the pocket needs too many passes at this bite; use a bigger tool or a wider bite');
      const next = intersect(offsetRegion(cleared, bite), part);
      if (regionArea(next) - regionArea(cleared) < 1e-3) break;
      // what of the new edge was not already the edge: there is material beside it
      const old = offsetRegion(cleared, 0.02);
      const passes: AdaptivePass[] = [];
      for (const whole of orient(next, false)) {
        // in short pieces, so that a long edge that is only partly new (a wall running into a corner) is told apart
        const loop = dense(whole, 0.25);
        const n = loop.length;
        const out = loop.map((p) => !inRegion(p, old));
        const fresh = loop.map((p, i) => {
          const q = loop[(i + 1) % n]!;
          return out[i]! || out[(i + 1) % n]! || !inRegion([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], old);
        });
        if (fresh.every(Boolean)) {
          passes.push({ pts: whole, closed: true });
          continue;
        }
        if (!fresh.some(Boolean)) continue;
        // runs of fresh edges, each starting after an old one
        const first = fresh.findIndex((f, i) => f && !fresh[(i - 1 + n) % n]);
        let i = first;
        do {
          if (fresh[i] && !fresh[(i - 1 + n) % n]) {
            const pts: Pt[] = [loop[i]!];
            let j = i;
            while (fresh[j]) {
              j = (j + 1) % n;
              pts.push(loop[j]!);
            }
            if (length(pts) > 0.05) passes.push({ pts: tidy(pts), closed: false });
            i = j;
          } else i = (i + 1) % n;
        } while (i !== first);
      }
      if (passes.length) fronts.push({ passes, open: offsetRegion(next, 0.03) });
      cleared = next;
    }
    plans.push({ entry: { c, rh }, fronts });
  }
  return plans;
}

/** The loop with points put in so that no edge is longer than `max`. */
function dense(loop: Loop, max: number): Loop {
  const out: Loop = [];
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % loop.length]!;
    out.push(p);
    const k = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / max);
    for (let j = 1; j < k; j++) out.push([p[0] + ((q[0] - p[0]) * j) / k, p[1] + ((q[1] - p[1]) * j) / k]);
  }
  return out;
}

/** The path without the points that lie on the straight line between their neighbours. */
function tidy(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out.at(-1)!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (Math.abs(cross) > 1e-4 * Math.max(len, 1e-9)) out.push(b);
  }
  out.push(pts.at(-1)!);
  return out;
}

function length(pts: Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return s;
}

/** Does the straight line from a to b stay inside the region (sampled every 0.4 mm)? */
export function clearWay(a: Pt, b: Pt, region: Loop[]): boolean {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len / 0.4));
  for (let i = 0; i <= n; i++) {
    if (!inRegion([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n], region)) return false;
  }
  return true;
}
