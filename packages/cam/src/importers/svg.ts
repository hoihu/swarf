/**
 * SVG → 2D paths in mm. Reads path (all commands, curves and arcs flattened), rect, circle,
 * ellipse, line, polyline and polygon, with transforms on elements and groups. Size: the root's
 * width/height units with its viewBox (Inkscape and most CAD exports give mm); without units,
 * 96 px per inch. SVG's y axis points down; the result is flipped so the drawing is upright with
 * y up, its bottom edge at y 0 when the height is known.
 */
import { dedupe, type Pt } from '../geom2d.ts';
import type { Imported } from './dxf.ts';

type M = [number, number, number, number, number, number]; // a b c d e f
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const nums = (s: string) => (s.match(NUM) ?? []).map(Number);

export function parseTransform(s: string | undefined): M {
  let m = I;
  if (!s) return m;
  for (const [, fn, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = nums(args!);
    let t: M = I;
    switch (fn) {
      case 'matrix':
        if (a.length === 6) t = a as M;
        break;
      case 'translate':
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
        t = mul(mul([1, 0, 0, 1, cx, cy], [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, t);
  }
  return m;
}

/** Flatten cubic Bézier into n segments. */
function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt[] {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.max(4, Math.min(400, Math.ceil(len / 0.25)));
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n;
    const u = 1 - t;
    return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
  });
}

/** SVG elliptical arc (endpoint form) flattened, from p0 to p. */
function arc(p0: Pt, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p: Pt): Pt[] {
  if (!rx || !ry) return [p];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const dx = (p0[0] - p[0]) / 2;
  const dy = (p0[1] - p[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (k * rx * y1) / ry;
  const cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / 0.25));
  return Array.from({ length: n }, (_, i) => {
    const t = t1 + (dt * (i + 1)) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy] as Pt;
  });
}

/** All subpaths of a path's d attribute, flattened. */
export function parsePathData(d: string): { closed: boolean; pts: Pt[] }[] {
  const out: { closed: boolean; pts: Pt[] }[] = [];
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  let pts: Pt[] = [];
  let lastCtrl: Pt | null = null;
  let lastQ: Pt | null = null;
  const num = () => Number(tokens[i++]);
  const more = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]!);
  const flush = (closed: boolean) => {
    if (pts.length >= 2) out.push({ closed, pts });
    pts = [];
  };
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i]!)) cmd = tokens[i++]!;
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const R = (x: number, y: number): Pt => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      flush(true);
      cur = start;
      lastCtrl = lastQ = null;
      continue;
    }
    if (!more()) {
      i++;
      continue;
    }
    switch (C) {
      case 'M': {
        flush(false);
        cur = R(num(), num());
        start = cur;
        pts = [cur];
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L':
        cur = R(num(), num());
        pts.push(cur);
        break;
      case 'H':
        cur = [rel ? cur[0] + num() : num(), cur[1]];
        pts.push(cur);
        break;
      case 'V':
        cur = [cur[0], rel ? cur[1] + num() : num()];
        pts.push(cur);
        break;
      case 'C': {
        const p1 = R(num(), num());
        const p2 = R(num(), num());
        const p = R(num(), num());
        pts.push(...cubic(cur, p1, p2, p));
        lastCtrl = p2;
        cur = p;
        continue;
      }
      case 'S': {
        const p1: Pt = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const p2 = R(num(), num());
        const p = R(num(), num());
        pts.push(...cubic(cur, p1, p2, p));
        lastCtrl = p2;
        cur = p;
        continue;
      }
      case 'Q': {
        const q = R(num(), num());
        const p = R(num(), num());
        pts.push(...cubic(cur, [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p));
        lastQ = q;
        cur = p;
        continue;
      }
      case 'T': {
        const q: Pt = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const p = R(num(), num());
        pts.push(...cubic(cur, [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p));
        lastQ = q;
        cur = p;
        continue;
      }
      case 'A': {
        const [rx, ry, rot, large, sw] = [num(), num(), num(), num(), num()];
        const p = R(num(), num());
        pts.push(...arc(cur, rx, ry, rot, !!large, !!sw, p));
        cur = p;
        break;
      }
      default:
        i++;
    }
    lastCtrl = lastQ = null;
  }
  flush(false);
  return out;
}

const LENGTH: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
function lengthMm(v: string | undefined): number | null {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(mm|cm|in|pt|pc|px|)\s*$/.exec(v ?? '');
  return m ? Number(m[1]) * LENGTH[m[2]!]! : null;
}

export function importSvg(text: string): Imported {
  const notes: string[] = [];
  const paths: Imported['paths'] = [];
  const attrs = (s: string) => {
    const a: Record<string, string> = {};
    for (const m of s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[m[1]!] = m[2] ?? m[3] ?? '';
    return a;
  };
  const stack: { tag: string; m: M; hidden: boolean }[] = [];
  let root: M | null = null;
  let heightMm: number | null = null;
  const skippedTags = new Map<string, number>();
  const HIDDEN = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'title', 'desc', 'metadata', 'style', 'text']);

  for (const m of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<\s*(\/?)([\w:-]+)([^>]*?)(\/?)\s*>/g)) {
    const [, closing, rawTag, rest, selfClosing] = m;
    const tag = rawTag!.replace(/^svg:/, '');
    if (closing) {
      while (stack.length && stack.at(-1)!.tag !== tag) stack.pop();
      stack.pop();
      continue;
    }
    const a = attrs(rest!);
    const parent = stack.at(-1);
    const hidden = (parent?.hidden ?? false) || HIDDEN.has(tag) || a.display === 'none' || /display\s*:\s*none/.test(a.style ?? '');
    let mx = mul(parent?.m ?? I, parseTransform(a.transform));
    if (tag === 'svg' && !root) {
      // root size: units → mm, and the viewBox mapped onto it
      const vb = a.viewBox ? nums(a.viewBox) : null;
      const w = lengthMm(a.width);
      const h = lengthMm(a.height);
      let sx = 25.4 / 96;
      let sy = sx;
      let ox = 0;
      let oy = 0;
      if (vb && vb.length === 4) {
        sx = w ? w / vb[2]! : sx;
        sy = h ? h / vb[3]! : w ? sx : sy;
        ox = -vb[0]! * sx;
        oy = -vb[1]! * sy;
        heightMm = h ?? vb[3]! * sy;
      } else heightMm = h;
      if (!w && !vb) notes.push('The SVG has no size in mm; read at 96 px per inch.');
      root = [sx, 0, 0, sy, ox, oy];
      mx = mul(root, parseTransform(a.transform));
    }
    if (!selfClosing) stack.push({ tag, m: mx, hidden });
    if (hidden || tag === 'svg' || tag === 'g') continue;
    const n = (k: string) => Number(a[k] ?? 0);
    const add = (pts: Pt[], closed: boolean) => {
      if (pts.length >= 2) paths.push({ closed, pts: pts.map((p) => apply(mx, p)) });
    };
    switch (tag) {
      case 'path':
        for (const p of parsePathData(a.d ?? '')) add(p.pts, p.closed);
        break;
      case 'rect':
        add([[n('x'), n('y')], [n('x') + n('width'), n('y')], [n('x') + n('width'), n('y') + n('height')], [n('x'), n('y') + n('height')]], true);
        break;
      case 'circle':
      case 'ellipse': {
        const rx = tag === 'circle' ? n('r') : n('rx');
        const ry = tag === 'circle' ? n('r') : n('ry');
        const k = Math.max(24, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / 0.25));
        add(Array.from({ length: k }, (_, i) => [n('cx') + rx * Math.cos((2 * Math.PI * i) / k), n('cy') + ry * Math.sin((2 * Math.PI * i) / k)] as Pt), true);
        break;
      }
      case 'line':
        add([[n('x1'), n('y1')], [n('x2'), n('y2')]], false);
        break;
      case 'polyline':
      case 'polygon': {
        const v = nums(a.points ?? '');
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i]!, v[i + 1]!]);
        add(pts, tag === 'polygon');
        break;
      }
      default:
        if (!['stop', 'linearGradient', 'radialGradient', 'tspan', 'namedview', 'sodipodi:namedview'].includes(tag)) skippedTags.set(tag, (skippedTags.get(tag) ?? 0) + 1);
    }
  }
  for (const [tag, k] of skippedTags) notes.push(`${k} <${tag}> skipped`);
  // y up: flip about the drawing's height (or just mirror when it is unknown)
  const H = heightMm ?? 0;
  const flipped = paths.map((p) => ({ closed: p.closed, pts: dedupe(p.pts.map(([x, y]) => [x, H - y] as Pt), p.closed) }));
  return { paths: flipped.filter((p) => p.pts.length >= 2), units: 'mm', notes };
}
