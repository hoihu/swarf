/**
 * The milled block's skin: walls along the cut's outline, no gaps between the squares it is made
 * of, and nothing outside the block.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EXAMPLES, Job, generate, simulate, MillMaterial } from '@swarf/cam';
import { millMesh } from '../src/lib/scene.ts';

function cutPart(): MillMaterial {
  const job = EXAMPLES.mill();
  job.operations.push(
    Job.shape.operations.element.parse({ id: 'op4', type: 'mill_pocket_circle', tool: 1, cx: 62, cy: 25, diameter: 14, zBottom: -4, zTop: 0 }),
    Job.shape.operations.element.parse({ id: 'op5', type: 'mill_chamfer', tool: 4, x: 20, y: 15, w: 40, h: 20, size: 1 }),
  );
  const m = simulate(job, generate(job).program, Infinity, { walls: true }).material;
  if (!(m instanceof MillMaterial)) throw new Error('no mill material');
  return m;
}

const meshes = (g: THREE.Group): THREE.Mesh[] => g.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
/** Every triangle's corners, of all the meshes (the top and the walls). */
const positions = (g: THREE.Group): Float32Array => {
  const all = meshes(g).map((m) => m.geometry.getAttribute('position').array as Float32Array);
  const out = new Float32Array(all.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of all) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};

describe('the milled part in the preview', () => {
  const m = cutPart();
  const group = millMesh(m);
  const pos = positions(group);

  it('stays within the block', () => {
    expect(pos.length).toBeGreaterThan(1000);
    for (let k = 0; k < pos.length; k += 3) {
      const [x, y, z] = [pos[k]!, -pos[k + 2]!, pos[k + 1]!];
      expect(Number.isFinite(x + y + z)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(m.sx + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(m.sy + 1e-6);
      expect(z).toBeGreaterThanOrEqual(m.bottom - 1e-6);
      expect(z).toBeLessThanOrEqual(m.top + 1e-6);
    }
  });

  it('is closed: every edge is shared by two faces, but along the open bottom and the holes cut through', () => {
    const key = (k: number) => `${pos[k]!.toFixed(4)},${pos[k + 1]!.toFixed(4)},${pos[k + 2]!.toFixed(4)}`;
    const edges = new Map<string, number>();
    for (let t = 0; t < pos.length; t += 9) {
      const v = [key(t), key(t + 3), key(t + 6)];
      if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue; // degenerate
      for (let e = 0; e < 3; e++) {
        const a = v[e]!;
        const b = v[(e + 1) % 3]!;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
    const atBottom = (p: string) => Math.abs(Number(p.split(',')[1]) - m.bottom) < 1e-3;
    // an edge may be split at different points on its two sides (a wall meeting two lower ones, a
    // corner of the floor beside it): along each line every stretch must be covered an even number of times
    const lines = new Map<string, [number, number, number][]>();
    const open: string[] = [];
    for (const [k, n] of edges) {
      if (n % 2 === 0) continue;
      if (k.split('|').every(atBottom)) continue;
      const [a, b] = k.split('|').map((p) => new THREE.Vector3(...p.split(',').map(Number))) as [THREE.Vector3, THREE.Vector3];
      const d = b.clone().sub(a).normalize();
      // one direction for both ways round, and the line's point nearest the origin
      if (d.x < -1e-9 || (Math.abs(d.x) < 1e-9 && (d.y < -1e-9 || (Math.abs(d.y) < 1e-9 && d.z < 0)))) d.negate();
      const o = a.clone().sub(d.clone().multiplyScalar(a.dot(d)));
      const f = (v: number) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);
      const line = `${f(d.x)},${f(d.y)},${f(d.z)}@${f(o.x)},${f(o.y)},${f(o.z)}`;
      const [lo, hi] = [a.dot(d), b.dot(d)].map((v) => Math.round(v * 1e4) / 1e4).sort((x, y) => x - y) as [number, number];
      lines.set(line, [...(lines.get(line) ?? []), [lo, hi, n]]);
    }
    for (const [line, spans] of lines) {
      const cuts = [...new Set(spans.flatMap(([lo, hi]) => [lo, hi]))].sort((x, y) => x - y);
      for (let c = 0; c + 1 < cuts.length; c++) {
        const mid = (cuts[c]! + cuts[c + 1]!) / 2;
        const cover = spans.filter(([lo, hi]) => lo < mid && mid < hi).reduce((s, [, , n]) => s + n, 0);
        if (cover % 2) open.push(`${line} ${cuts[c]}…${cuts[c + 1]}`);
      }
    }
    expect(open.slice(0, 5)).toEqual([]);
  });

  it('shades the walls on the side they face: the normals agree with the winding, and are round on a curve', () => {
    const walls = meshes(group)[1]!.geometry;
    const p = walls.getAttribute('position').array as Float32Array;
    const n = walls.getAttribute('normal').array as Float32Array;
    let wrong = 0;
    let rounded = 0;
    for (let t = 0; t < p.length; t += 9) {
      const a = new THREE.Vector3(p[t], p[t + 1], p[t + 2]);
      const f = new THREE.Vector3(p[t + 3], p[t + 4], p[t + 5]).sub(a).cross(new THREE.Vector3(p[t + 6], p[t + 7], p[t + 8]).sub(a));
      if (f.lengthSq() < 1e-14) continue;
      f.normalize();
      for (let v = 0; v < 3; v++) {
        const nv = new THREE.Vector3(n[t + v * 3], n[t + v * 3 + 1], n[t + v * 3 + 2]);
        if (nv.dot(f) <= 0) wrong++;
        if (nv.dot(f) < 0.9999) rounded++;
      }
    }
    expect(wrong).toBe(0);
    expect(rounded).toBeGreaterThan(100);
    // the round pocket's wall faces into the pocket, the block's sides outwards
    let inwards = 0;
    let outwards = 0;
    for (let v = 0; v < p.length; v += 3) {
      const x = p[v]!;
      const y = -p[v + 2]!;
      const nx = n[v]!;
      const ny = -n[v + 2]!;
      const r = Math.hypot(x - 62, y - 25);
      if (Math.abs(r - 7) < 0.6 && x > 61) { // (left of that, the rectangular pocket, deeper, cuts into it)
        if (nx * (62 - x) + ny * (25 - y) > 0) inwards++;
        else outwards++;
      }
      if (x < 1e-6 && y > 0.5 && y < m.sy - 0.5) expect(nx).toBeLessThan(-0.5);
      if (y < 1e-6 && x > 0.5 && x < m.sx - 0.5) expect(ny).toBeLessThan(-0.5);
    }
    expect(inwards).toBeGreaterThan(100);
    expect(outwards).toBe(0);
  });

  it('stands the round wall where the cutter left it: on the circle of the pocket', () => {
    const walls = meshes(group)[1]!.geometry;
    const p = walls.getAttribute('position').array as Float32Array;
    let worst = 0;
    let n = 0;
    for (let v = 0; v < p.length; v += 3) {
      const x = p[v]!;
      const y = -p[v + 2]!;
      const r = Math.hypot(x - 62, y - 25);
      // the right half (the rectangular pocket cuts into the left), clear of the grid's corner squares
      if (Math.abs(r - 7) > 0.5 || x < 63) continue;
      worst = Math.max(worst, Math.abs(r - 7));
      n++;
    }
    expect(n).toBeGreaterThan(100);
    expect(worst).toBeLessThan(0.03);
  });

  it('runs a round wall round, not in steps along the grid', () => {
    // wall faces (vertical) inside the circular pocket's ring: not all lined up with X or Y
    let slanted = 0;
    let square = 0;
    for (let t = 0; t < pos.length; t += 9) {
      const a = new THREE.Vector3(pos[t], pos[t + 1], pos[t + 2]);
      const b = new THREE.Vector3(pos[t + 3], pos[t + 4], pos[t + 5]);
      const c = new THREE.Vector3(pos[t + 6], pos[t + 7], pos[t + 8]);
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();
      const mx = (a.x + b.x + c.x) / 3;
      const my = -(a.z + b.z + c.z) / 3;
      if (Math.abs(n.y) > 0.1 || Math.abs(Math.hypot(mx - 62, my - 25) - 7) > 0.6) continue;
      if (Math.abs(n.x) > 0.999 || Math.abs(n.z) > 0.999) square++;
      else slanted++;
    }
    expect(slanted).toBeGreaterThan(square * 3);
  });
});
