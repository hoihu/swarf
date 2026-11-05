/**
 * A drawing of a turned part, seen from the side with the spindle axis horizontal, → lathe profile
 * points. The outline may be the full part (symmetric about the axis) or only its upper half
 * drawn on the axis. The upper envelope is read off the drawing, steps and faces included, from
 * the front face towards the chuck; the back face (where the part is parted off) is left out.
 */
import { area, type Pt } from '../geom2d.ts';
import type { Shape } from '../schema.ts';
import type { ProfilePoint } from '../ops/profile.ts';

/** Highest y where a vertical line at x meets the loop's edges (null: it does not). */
function topAt(loop: Pt[], x: number): number | null {
  let best: number | null = null;
  for (let i = 0; i < loop.length; i++) {
    const [ax, ay] = loop[i]!;
    const [bx, by] = loop[(i + 1) % loop.length]!;
    if ((ax <= x && bx >= x) || (bx <= x && ax >= x)) {
      if (Math.abs(bx - ax) < 1e-12) continue; // vertical edge: the neighbours give its ends
      const y = ay + ((by - ay) * (x - ax)) / (bx - ax);
      if (best === null || y > best) best = y;
    }
  }
  return best;
}

function bottomAt(loop: Pt[], x: number): number | null {
  const flipped = loop.map(([px, py]) => [px, -py] as Pt);
  const t = topAt(flipped, x);
  return t === null ? null : -t;
}

export function profileFromDrawing(shape: Shape, face: 'right' | 'left' = 'right'): { points: ProfilePoint[]; notes: string[] } {
  const notes: string[] = [];
  const closed = shape.paths.filter((p) => p.closed && p.pts.length >= 3).map((p) => p.pts);
  let loop: Pt[];
  if (closed.length) {
    loop = closed.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a));
    if (closed.length > 1) notes.push(`Used the largest outline of ${closed.length}.`);
  } else {
    // an open half profile: close it along the axis (its lowest y)
    const open = shape.paths.reduce((a, b) => (b.pts.length > a.pts.length ? b : a)).pts;
    const minY = Math.min(...open.map((p) => p[1]));
    loop = [...open, [open.at(-1)![0], minY], [open[0]![0], minY]];
  }
  // mirror so the face is on the right
  if (face === 'left') loop = loop.map(([x, y]) => [-x, y] as Pt);
  const xs = [...new Set(loop.map((p) => p[0]))].sort((a, b) => b - a);
  const maxX = xs[0]!;
  const minX = xs.at(-1)!;
  const eps = Math.max(1e-6, (maxX - minX) * 1e-7);
  // the axis: the middle when the outline is symmetric about it, else its bottom edge
  const ys = loop.map((p) => p[1]);
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const samples = Array.from({ length: 41 }, (_, i) => minX + ((maxX - minX) * (i + 0.5)) / 41);
  const symmetric = samples.every((x) => {
    const t = topAt(loop, x);
    const b = bottomAt(loop, x);
    return t === null || b === null || Math.abs(t - mid - (mid - b)) < 0.02;
  });
  const axis = symmetric ? mid : Math.min(...ys);
  notes.push(symmetric ? 'Read as a full side view, axis through its middle.' : 'Read as a half profile drawn on the axis (its bottom edge).');

  // upper envelope, right to left, with the jumps at faces and shoulders
  const pts: { x: number; y: number }[] = [];
  const push = (x: number, y: number) => {
    const last = pts.at(-1);
    if (!last || Math.abs(last.x - x) > 1e-9 || Math.abs(last.y - y) > 1e-9) pts.push({ x, y });
  };
  for (const x of xs) {
    const right = x === maxX ? axis : (topAt(loop, x + eps) ?? axis);
    const left = x === minX ? axis : (topAt(loop, x - eps) ?? axis);
    push(x, right);
    push(x, left);
  }
  // drop the back face: the radius must not shrink towards the chuck
  while (pts.length > 2 && pts.at(-1)!.y < pts.at(-2)!.y - 1e-9) pts.pop();
  // drop points in a straight line with their neighbours
  const kept = pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const a = pts[i - 1]!;
    const b = pts[i + 1]!;
    return Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) > 1e-6;
  });
  const points = kept.map((p) => ({ d: Math.max(0, 2 * (p.y - axis)), z: p.x - maxX }));
  return { points, notes };
}
