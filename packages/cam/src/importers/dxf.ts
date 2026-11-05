/**
 * DXF → 2D paths in mm (model space, Z ignored). LINE, ARC, CIRCLE, LWPOLYLINE and POLYLINE (with
 * bulges), ELLIPSE, SPLINE (B-spline evaluated from control points and knots, or its fit points)
 * and INSERT (block references, with position, scale and rotation). Loose lines and arcs that
 * meet end to end are joined into one path; a path that comes back to its start is closed.
 * Text, dimensions and hatches are skipped and reported.
 */
import DxfParser from 'dxf-parser';
import { dedupe, type Pt } from '../geom2d.ts';

export interface Imported {
  paths: { closed: boolean; pts: Pt[] }[];
  /** What the drawing said its units are, and the factor used to get mm. */
  units: string;
  notes: string[];
}

interface P {
  x: number;
  y: number;
}
interface Ent {
  type: string;
  inPaperSpace?: boolean;
  [k: string]: unknown;
}

const UNITS: Record<number, [string, number]> = { 1: ['inches', 25.4], 2: ['feet', 304.8], 4: ['mm', 1], 5: ['cm', 10], 6: ['m', 1000], 8: ['microinches', 25.4e-6], 9: ['mils', 0.0254] };
/** Largest gap between an arc and its chords, mm; in drawing units while one file is read. */
const CHORD_MM = 0.005;
let CHORD = CHORD_MM;

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, ccw = true): Pt[] {
  let sweep = a1 - a0;
  if (ccw) while (sweep <= 0) sweep += 2 * Math.PI;
  else while (sweep >= 0) sweep -= 2 * Math.PI;
  const step = 2 * Math.acos(Math.max(-1, 1 - CHORD / Math.max(r, 1e-6)));
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3)));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + (sweep * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

/** Points of a polyline segment with a bulge (tan of a quarter of the included angle; + = counter-clockwise). */
function bulgePts(a: P, b: P, bulge: number): Pt[] {
  if (Math.abs(bulge) < 1e-9) return [[b.x, b.y]];
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const h = Math.sqrt(Math.max(r * r - (chord / 2) ** 2, 0));
  // centre on the left of a→b for a counter-clockwise arc of less than half a turn
  const ux = (b.x - a.x) / chord;
  const uy = (b.y - a.y) / chord;
  const side = (bulge > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const cx = mx - uy * h * side;
  const cy = my + ux * h * side;
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  const a1 = Math.atan2(b.y - cy, b.x - cx);
  return arcPts(cx, cy, r, a0, a1, bulge > 0).slice(1);
}

function polyPts(vs: (P & { bulge?: number })[], closed: boolean): Pt[] {
  if (!vs.length) return [];
  const out: Pt[] = [[vs[0]!.x, vs[0]!.y]];
  const n = closed ? vs.length : vs.length - 1;
  for (let i = 0; i < n; i++) out.push(...bulgePts(vs[i]!, vs[(i + 1) % vs.length]!, vs[i]!.bulge ?? 0));
  return out;
}

/** de Boor evaluation of a (possibly rational) B-spline. */
function splinePts(ctrl: P[], knots: number[], degree: number, weights?: number[]): Pt[] {
  const k = degree;
  if (ctrl.length <= k || knots.length !== ctrl.length + k + 1) return ctrl.map((p) => [p.x, p.y]);
  const t0 = knots[k]!;
  const t1 = knots[knots.length - k - 1]!;
  let len = 0;
  for (let i = 1; i < ctrl.length; i++) len += Math.hypot(ctrl[i]!.x - ctrl[i - 1]!.x, ctrl[i]!.y - ctrl[i - 1]!.y);
  const n = Math.min(4000, Math.max(16, Math.ceil(len / 0.2)));
  const w = weights ?? ctrl.map(() => 1);
  const out: Pt[] = [];
  for (let s = 0; s <= n; s++) {
    const t = Math.min(t0 + ((t1 - t0) * s) / n, t1 - 1e-12 * (t1 - t0));
    let span = k;
    while (span < knots.length - k - 2 && t >= knots[span + 1]!) span++;
    const d = Array.from({ length: k + 1 }, (_, j) => {
      const p = ctrl[span - k + j]!;
      const wj = w[span - k + j]!;
      return [p.x * wj, p.y * wj, wj];
    });
    for (let r = 1; r <= k; r++)
      for (let j = k; j >= r; j--) {
        const i = span - k + j;
        const denom = knots[i + k - r + 1]! - knots[i]!;
        const alpha = denom === 0 ? 0 : (t - knots[i]!) / denom;
        for (let c = 0; c < 3; c++) d[j]![c] = (1 - alpha) * d[j - 1]![c]! + alpha * d[j]![c]!;
      }
    out.push([d[k]![0]! / d[k]![2]!, d[k]![1]! / d[k]![2]!]);
  }
  return out;
}

/** A smooth curve through fit points (centripetal Catmull-Rom), for splines given only by them. */
function throughPoints(p: Pt[], closed: boolean): Pt[] {
  if (p.length < 3) return p;
  const at = (i: number) => (closed ? p[(i + p.length) % p.length]! : p[Math.max(0, Math.min(p.length - 1, i))]!);
  const out: Pt[] = [p[0]!];
  const segs = closed ? p.length : p.length - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const n = Math.max(4, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / (0.2 / Math.max(CHORD_MM / CHORD, 1e-9))));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  return out;
}

export function importDxf(text: string): Imported {
  const dxf = new DxfParser().parseSync(text);
  if (!dxf) throw new Error('Not a DXF file this importer can read.');
  const code = Number(dxf.header?.$INSUNITS ?? 0);
  const [unitName, scale] = UNITS[code] ?? ['not given (read as mm)', 1];
  CHORD = CHORD_MM / scale;
  const notes: string[] = [];
  const skipped = new Map<string, number>();
  const closed: Pt[][] = [];
  const open: Pt[][] = [];

  type Xf = (p: Pt) => Pt;
  const walk = (ents: Ent[], xf: Xf, depth: number) => {
    for (const e of ents) {
      if (e.inPaperSpace) continue;
      const add = (pts: Pt[], isClosed: boolean) => {
        const t = pts.map(xf);
        if (t.length >= 2) (isClosed ? closed : open).push(t);
      };
      switch (e.type) {
        case 'LINE': {
          const v = e.vertices as P[];
          add([[v[0]!.x, v[0]!.y], [v[1]!.x, v[1]!.y]], false);
          break;
        }
        case 'ARC': {
          const c = e.center as P;
          add(arcPts(c.x, c.y, e.radius as number, e.startAngle as number, e.endAngle as number), false);
          break;
        }
        case 'CIRCLE': {
          const c = e.center as P;
          add(arcPts(c.x, c.y, e.radius as number, 0, 2 * Math.PI).slice(0, -1), true);
          break;
        }
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          const vs = e.vertices as (P & { bulge?: number })[];
          add(polyPts(vs, !!e.shape), !!e.shape);
          break;
        }
        case 'ELLIPSE': {
          const c = e.center as P;
          const m = e.majorAxisEndPoint as P;
          const ratio = e.axisRatio as number;
          const a = Math.hypot(m.x, m.y);
          const rot = Math.atan2(m.y, m.x);
          let t0 = (e.startAngle as number) ?? 0;
          let t1 = (e.endAngle as number) ?? 2 * Math.PI;
          if (t1 <= t0) t1 += 2 * Math.PI;
          const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6;
          const n = Math.max(32, Math.ceil(((t1 - t0) * a) / (0.2 / scale)));
          const pts: Pt[] = Array.from({ length: n + 1 }, (_, i) => {
            const t = t0 + ((t1 - t0) * i) / n;
            const x = a * Math.cos(t);
            const y = a * ratio * Math.sin(t);
            return [c.x + x * Math.cos(rot) - y * Math.sin(rot), c.y + x * Math.sin(rot) + y * Math.cos(rot)] as Pt;
          });
          add(full ? pts.slice(0, -1) : pts, full);
          break;
        }
        case 'SPLINE': {
          const ctrl = (e.controlPoints as P[] | undefined) ?? [];
          const knots = (e.knotValues as number[] | undefined) ?? [];
          const fit = (e.fitPoints as P[] | undefined) ?? [];
          const pts = ctrl.length && knots.length ? splinePts(ctrl, knots, (e.degreeOfSplineCurve as number) ?? 3) : throughPoints(fit.map((p) => [p.x, p.y] as Pt), !!e.closed);
          if (!pts.length) break;
          const isClosed = !!e.closed || Math.hypot(pts[0]![0] - pts.at(-1)![0], pts[0]![1] - pts.at(-1)![1]) < 1e-6;
          add(isClosed ? pts.slice(0, -1) : pts, isClosed);
          break;
        }
        case 'INSERT': {
          const block = dxf.blocks?.[e.name as string];
          if (!block?.entities || depth > 8) break;
          const pos = e.position as P;
          const sx = (e.xScale as number) || 1;
          const sy = (e.yScale as number) || 1;
          const rot = (((e.rotation as number) || 0) * Math.PI) / 180;
          const base = (block as unknown as { position?: P }).position ?? { x: 0, y: 0 };
          const inner: Xf = ([x, y]) => {
            const px = (x - base.x) * sx;
            const py = (y - base.y) * sy;
            return xf([pos.x + px * Math.cos(rot) - py * Math.sin(rot), pos.y + px * Math.sin(rot) + py * Math.cos(rot)]);
          };
          walk(block.entities as unknown as Ent[], inner, depth + 1);
          break;
        }
        default:
          skipped.set(e.type, (skipped.get(e.type) ?? 0) + 1);
      }
    }
  };
  walk(dxf.entities as unknown as Ent[], ([x, y]) => [x * scale, y * scale], 0);

  // join loose pieces end to end
  const tol = 0.01;
  const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const pieces = open.map((p) => [...p]);
  const chains: Pt[][] = [];
  while (pieces.length) {
    let chain = pieces.pop()!;
    for (let grew = true; grew; ) {
      grew = false;
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i]!;
        const [s, e] = [chain[0]!, chain.at(-1)!];
        if (near(e, p[0]!)) chain = [...chain, ...p.slice(1)];
        else if (near(e, p.at(-1)!)) chain = [...chain, ...[...p].reverse().slice(1)];
        else if (near(s, p.at(-1)!)) chain = [...p, ...chain.slice(1)];
        else if (near(s, p[0]!)) chain = [...[...p].reverse(), ...chain.slice(1)];
        else continue;
        pieces.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  const paths: Imported['paths'] = closed.map((pts) => ({ closed: true, pts: dedupe(pts, true) }));
  for (const c of chains) {
    const isClosed = c.length > 3 && near(c[0]!, c.at(-1)!);
    paths.push({ closed: isClosed, pts: dedupe(c, isClosed) });
  }
  for (const [type, n] of skipped) notes.push(`${n} ${type} entit${n === 1 ? 'y' : 'ies'} skipped`);
  if (!code) notes.push('The drawing does not say its units; read as millimetres.');
  return { paths: paths.filter((p) => p.pts.length >= 2), units: unitName, notes };
}
