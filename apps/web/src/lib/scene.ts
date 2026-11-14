/**
 * three.js builders for the preview. Machine coordinates map to the scene so that "up" is up:
 * mill (x, y, z) → scene (x, z, -y); lathe (radius x, y, z) → scene (z, -y, x): the spindle axis
 * along scene X, and X out towards the operator at centre height, where the tool on the cross
 * slide comes from (the lathe's Y points down, as for a front tool post).
 */
import * as THREE from 'three';
import { LatheMaterial, MillMaterial, arcPoints, walk, type Job, type Program, type Vec3 } from '@swarf/cam';

/** How the work looks: cut surfaces bright, what is left of the raw stock duller. */
export interface WorkLook {
  color: string;
  raw: string;
  metalness: number;
  roughness: number;
}
const PLAIN: WorkLook = { color: '#b8c2c2', raw: '#b8c2c2', metalness: 0.55, roughness: 0.4 };

export const COLORS = {
  feed: new THREE.Color('#6fb2e8'),
  rapid: new THREE.Color('#ef8a4c'),
  selected: new THREE.Color('#f2d16b'),
  material: new THREE.Color('#b8c2c2'),
  stock: new THREE.Color('#8d9a94'),
  chuck: new THREE.Color('#3a423e'),
  tool: new THREE.Color('#e0a400'),
  drawing: new THREE.Color('#d9e6a8'),
};

/** Imported drawings as thin lines just above the stock top (mill). */
export function drawingLines(job: Job): THREE.LineSegments | null {
  if (job.stock.kind !== 'block' || !job.shapes.length) return null;
  const z = job.stock.top + 0.05;
  const pos: number[] = [];
  for (const sh of job.shapes)
    for (const p of sh.paths) {
      const pts = p.closed ? [...p.pts, p.pts[0]!] : p.pts;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1]!;
        const [bx, by] = pts[i]!;
        pos.push(ax + sh.at.x, z, -(ay + sh.at.y), bx + sh.at.x, z, -(by + sh.at.y));
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COLORS.drawing, transparent: true, opacity: 0.85 }));
}

/** The inverse of toScene as a matrix (scene → work coordinates; lathe: x radius towards the operator, y down, z along the spindle). */
export function sceneToWork(lathe: boolean): THREE.Matrix4 {
  return lathe ? new THREE.Matrix4().set(0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1) : new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
}

/** Obstacles (clamps, vise jaws) as red boxes from the stock's bottom up to their top (mill). */
export function obstacleMeshes(job: Job): THREE.Group | null {
  if (job.stock.kind !== 'block' || !job.obstacles.length) return null;
  const g = new THREE.Group();
  const bottom = job.stock.top - job.stock.z;
  for (const o of job.obstacles) {
    const h = Math.max(0.5, o.top - bottom);
    const box = new THREE.BoxGeometry(o.x1 - o.x0, h, o.y1 - o.y0);
    box.translate((o.x0 + o.x1) / 2, bottom + h / 2, -(o.y0 + o.y1) / 2);
    g.add(new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: '#d9534f', transparent: true, opacity: 0.35, depthWrite: false })));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: '#d9534f' })));
  }
  return g;
}

/** The raw stock's edges and the work zero's axes (X red, Y green, Z blue), for the camera overlay. */
export function stockOutline(job: Job): THREE.Group {
  const g = new THREE.Group();
  const line = (pts: Vec3[], color: string | THREE.Color, opacity = 1) => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => toScene(p, job.stock.kind === 'bar')));
    g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false })));
  };
  const s = job.stock;
  if (s.kind === 'block') {
    const z0 = s.top - s.z;
    for (const z of [z0, s.top]) line([{ x: 0, y: 0, z }, { x: s.x, y: 0, z }, { x: s.x, y: s.y, z }, { x: 0, y: s.y, z }, { x: 0, y: 0, z }], COLORS.stock, 0.9);
    for (const [x, y] of [[0, 0], [s.x, 0], [s.x, s.y], [0, s.y]] as const) line([{ x, y, z: z0 }, { x, y, z: s.top }], COLORS.stock, 0.9);
  } else {
    const r = s.diameter / 2;
    const ring = (z: number) => line(Array.from({ length: 65 }, (_, i) => ({ x: r * Math.cos((i / 64) * 2 * Math.PI), y: r * Math.sin((i / 64) * 2 * Math.PI), z })), COLORS.stock, 0.9);
    ring(s.front);
    ring(s.front - s.stickout);
    for (const a of [0, 90, 180, 270]) {
      const c = Math.cos((a * Math.PI) / 180) * r;
      const d = Math.sin((a * Math.PI) / 180) * r;
      line([{ x: c, y: d, z: s.front }, { x: c, y: d, z: s.front - s.stickout }], COLORS.stock, 0.6);
    }
  }
  const L = 15;
  line([{ x: 0, y: 0, z: 0 }, { x: L, y: 0, z: 0 }], '#e5534b');
  if (s.kind === 'block') line([{ x: 0, y: 0, z: 0 }, { x: 0, y: L, z: 0 }], '#57ab5a');
  line([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: L }], '#539bf5');
  return g;
}

export function toScene(p: Vec3, lathe: boolean): THREE.Vector3 {
  return lathe ? new THREE.Vector3(p.z, -p.y, p.x) : new THREE.Vector3(p.x, p.z, -p.y);
}

export interface PathGeometry {
  geometry: THREE.BufferGeometry;
  /** For each move, the vertex index where its line segments end (for drawRange). */
  vertexEnd: number[];
}

/** All moves as line segments with per-vertex colours (rapids orange, feeds blue, the selected operation highlighted). */
export function pathGeometry(program: Program, selectedOp: string | null): PathGeometry {
  const lathe = program.kind === 'lathe';
  const pos: number[] = [];
  const col: number[] = [];
  const vertexEnd: number[] = [];
  const push = (a: Vec3, b: Vec3, c: THREE.Color) => {
    const p = toScene(a, lathe);
    const q = toScene(b, lathe);
    pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  };
  for (const { seg, from, move } of walk(program)) {
    const op = program.segments[seg]!.opId;
    const c = move.type === 'rapid' ? COLORS.rapid : op === selectedOp ? COLORS.selected : COLORS.feed;
    if (move.type === 'arc') {
      let a = from;
      for (const p of arcPoints(from, move, 0.4)) {
        push(a, p, c);
        a = p;
      }
    } else push(from, move.to, c);
    vertexEnd.push(pos.length / 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return { geometry, vertexEnd };
}

/** The turned part: outer radius and bore revolved around the spindle axis. */
export function latheMesh(m: LatheMaterial, look: WorkLook = PLAIN, rawRadius = Infinity): THREE.Mesh {
  const step = Math.max(1, Math.floor(m.n / 600));
  const outer: THREE.Vector2[] = [];
  const inner: THREE.Vector2[] = [];
  for (let i = 0; i < m.n; i += step) {
    const z = m.zAt(i);
    const r = m.r[i]!;
    const b = Math.min(m.b[i]!, r);
    outer.push(new THREE.Vector2(r, z));
    inner.push(new THREE.Vector2(b, z));
  }
  // closed profile: bore at the chuck → outside towards the face → bore back to the chuck
  const z0 = m.z0;
  const zN = m.z0 + m.n * m.dz;
  const pts = [
    new THREE.Vector2(inner[0]!.x, z0),
    new THREE.Vector2(outer[0]!.x, z0),
    ...outer,
    new THREE.Vector2(outer.at(-1)!.x, zN),
    new THREE.Vector2(inner.at(-1)!.x, zN),
    ...inner.reverse(),
    new THREE.Vector2(inner.at(-1)!.x, z0),
  ];
  const g = new THREE.LatheGeometry(pts, 96);
  // LatheGeometry revolves around Y; the spindle runs along scene X
  g.rotateZ(-Math.PI / 2);
  g.computeVertexNormals();
  // the bar's own skin where nothing has been turned off, bright metal elsewhere
  const cut = new THREE.Color(look.color);
  const raw = new THREE.Color(look.raw);
  const col = new Float32Array(g.getAttribute('position').count * 3);
  const isRaw = pts.map((p, k) => k >= 1 && k <= outer.length + 1 && p.x >= rawRadius - 1e-3);
  for (let v = 0; v < col.length / 3; v++) {
    const c = isRaw[v % pts.length] ? raw : cut;
    col.set([c.r, c.g, c.b], v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: look.metalness, roughness: look.roughness, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** The chuck body behind the stock, for orientation. */
export function chuckMesh(chuckZ: number, diameter: number): THREE.Mesh {
  const len = Math.max(20, diameter * 0.35);
  const g = new THREE.CylinderGeometry(diameter / 2, diameter / 2, len, 64);
  g.rotateZ(-Math.PI / 2);
  g.translate(chuckZ - len / 2, 0, 0);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: COLORS.chuck, metalness: 0.4, roughness: 0.6 }));
}

/**
 * The milled block's skin from its height map, with walls along the outline of the cut rather
 * than round every grid cell: the heights are taken at the cells' centres, and each square
 * between four centres is filled in by itself. Where neighbouring heights differ little (a ramp,
 * the slope of a chamfer) the surface runs straight between them; where they jump (more than
 * 1.5 cells' width: a wall) a wall stands across the square, at a place found from the heights
 * around (smoothed over three cells), so that a round pocket's wall runs round and not in steps.
 * What is decided on an edge between two centres depends on those two only, so neighbouring
 * squares meet without gaps. A corner where three levels meet is filled in quarters.
 */
function smoothSkin(heights: Float32Array, nx: number, ny: number, cw: number, exact: boolean, m: MillMaterial, pos: number[], col: number[], cutC: THREE.Color, rawC: THREE.Color): THREE.BufferGeometry {
  const bottom = m.bottom;
  const top = m.top;
  const wall = cw * 1.5;
  // the centres, and a ring around them on the block's edges (with the edge cells' heights)
  const NX = nx + 2;
  const NY = ny + 2;
  const xs = new Float64Array(NX);
  const ys = new Float64Array(NY);
  xs[NX - 1] = m.sx;
  ys[NY - 1] = m.sy;
  for (let i = 0; i < nx; i++) xs[i + 1] = Math.min(m.sx, (i + 0.5) * cw);
  for (let j = 0; j < ny; j++) ys[j + 1] = Math.min(m.sy, (j + 0.5) * cw);
  const H = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) {
    const jj = Math.min(ny - 1, Math.max(0, j - 1));
    for (let i = 0; i < NX; i++) H[j * NX + i] = heights[jj * nx + Math.min(nx - 1, Math.max(0, i - 1))]!;
  }
  // the heights smoothed (over 5 × 5, the nearer ones weighing more): where between two centres a wall stands
  const S = new Float32Array(NX * NY);
  const W = [1, 4, 6, 4, 1];
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) {
      let sum = 0;
      let n = 0;
      for (let b = -2; b <= 2; b++) {
        const jj = j + b;
        if (jj < 0 || jj >= NY) continue;
        for (let a = -2; a <= 2; a++) {
          const ii = i + a;
          if (ii < 0 || ii >= NX) continue;
          const w = W[a + 2]! * W[b + 2]!;
          sum += H[jj * NX + ii]! * w;
          n += w;
        }
      }
      S[j * NX + i] = sum / n;
    }

  const tri = (a: number[], b: number[], c: number[]) => {
    if (a[2]! <= bottom + 1e-4 && b[2]! <= bottom + 1e-4 && c[2]! <= bottom + 1e-4) return; // cut through
    const raw = a[2]! >= top - 1e-4 && b[2]! >= top - 1e-4 && c[2]! >= top - 1e-4;
    pos.push(a[0]!, a[2]!, -a[1]!, b[0]!, b[2]!, -b[1]!, c[0]!, c[2]!, -c[1]!);
    const k = raw ? rawC : cutC;
    for (let v = 0; v < 3; v++) col.push(k.r, k.g, k.b);
  };
  /** A polygon (x, y, z points, convex enough), as a fan. */
  const poly = (pts: number[][]) => {
    for (let k = 1; k + 1 < pts.length; k++) tri(pts[0]!, pts[k]!, pts[k + 1]!);
  };
  // the walls go in a mesh of their own, shaded round where they turn a little (a curved wall
  // made of short straight pieces) and sharp at real corners
  const wpos: number[] = [];
  const wcol: number[] = [];
  /** Per vertex: the wall's own facing (scene x, z) and where it stands (plan key). */
  const wn: number[] = [];
  const wkey: string[] = [];
  /**
   * A wall standing on the line p–q, from za0 to za1 at p and zb0 to zb1 at q, facing the side
   * where `toward` (plan x, y) is: the lower one, or the outside.
   */
  const face = (p: number[], q: number[], za0: number, za1: number, zb0: number, zb1: number, raw: boolean, toward: number[]) => {
    if (Math.abs(za1 - za0) < 1e-5 && Math.abs(zb1 - zb0) < 1e-5) return;
    const dx = q[0]! - p[0]!;
    const dy = q[1]! - p[1]!;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return;
    // facing in plan, perpendicular to p–q, to the `toward` side
    let fx = dy / len;
    let fy = -dx / len;
    if (fx * (toward[0]! - p[0]!) + fy * (toward[1]! - p[1]!) < 0) {
      fx = -fx;
      fy = -fy;
    }
    // bottom to top at both ends (the two sides of a wall may be given either way round)
    if (za1 - za0 + (zb1 - zb0) < 0) [za0, za1, zb0, zb1] = [za1, za0, zb1, zb0];
    // wound so that its front is that side (three.js turns the normal round for the back)
    // scene normal of (a0, b0, b1) has the sign of the plan cross product of p→q with the facing
    if (dx * fy - dy * fx > 0) {
      [p, q, za0, za1, zb0, zb1] = [q, p, zb0, zb1, za0, za1];
    }
    const a0 = [p[0]!, za0, -p[1]!];
    const a1 = [p[0]!, za1, -p[1]!];
    const b0 = [q[0]!, zb0, -q[1]!];
    const b1 = [q[0]!, zb1, -q[1]!];
    wpos.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
    const k = raw ? rawC : cutC;
    const ka = `${p[0]!.toFixed(4)},${p[1]!.toFixed(4)}`;
    const kb = `${q[0]!.toFixed(4)},${q[1]!.toFixed(4)}`;
    for (const key of [ka, kb, kb, ka, kb, ka]) {
      wcol.push(k.r, k.g, k.b);
      wn.push(fx, -fy);
      wkey.push(key);
    }
  };
  const h = (i: number, j: number) => H[j * NX + i]!;
  /** Where the cutter's edge left the wall between two cells (MillMaterial.ex/ey), as a fraction from a to b; NaN where not known. */
  const noted = (ia: number, ja: number, ib: number, jb: number): number => {
    if (!exact) return NaN;
    // the ring of centres on the block's edges is not cells of the material
    const i = Math.min(ia, ib) - 1;
    const j = Math.min(ja, jb) - 1;
    if (i < 0 || j < 0 || Math.max(ia, ib) - 1 >= nx || Math.max(ja, jb) - 1 >= ny) return NaN;
    const v = ja === jb ? m.ex[j * m.nx + i]! : m.ey[j * m.nx + i]!;
    return (ja === jb ? ia < ib : ja < jb) ? v : 1 - v;
  };
  /** Where on the edge between two centres a wall stands (x, y): where the cutter left it, or else found from the smoothed heights. */
  const cross = (ia: number, ja: number, ib: number, jb: number): number[] => {
    let t = noted(ia, ja, ib, jb);
    if (Number.isNaN(t)) {
      const ha = h(ia, ja);
      const hb = h(ib, jb);
      const thr = (ha + hb) / 2;
      const sa = S[ja * NX + ia]! - thr;
      const sb = S[jb * NX + ib]! - thr;
      t = sa * sb < 0 ? Math.min(0.85, Math.max(0.15, sa / (sa - sb))) : 0.5;
    } else t = Math.min(0.98, Math.max(0.02, t));
    return [xs[ia]! + (xs[ib]! - xs[ia]!) * t, ys[ja]! + (ys[jb]! - ys[ja]!) * t];
  };
  const steep = (ha: number, hb: number) => Math.abs(ha - hb) > wall;

  // corners of a square in order round it, and its edges (edge e from corner e to e + 1)
  const ci = [0, 1, 1, 0];
  const cj = [0, 0, 1, 1];
  const hc = [0, 0, 0, 0];
  const pc: number[][] = [[], [], [], []];
  const br = [false, false, false, false];
  const xe: number[][] = [[], [], [], []];
  // squares flat at one height, next to each other in a row, go as one strip (most of a part is
  // flat: two triangles a square would be far more than the picture needs)
  // (two flat squares side by side share two corners: a row's flat run is all one height)
  const CX = NX - 1;
  const flat = new Uint8Array(CX * (NY - 1));
  for (let j = 0; j + 1 < NY; j++)
    for (let i = 0; i < CX; i++) {
      const z = h(i, j);
      flat[j * CX + i] = h(i + 1, j) === z && h(i + 1, j + 1) === z && h(i, j + 1) === z ? 1 : 0;
    }
  /** Does anything but a flat strip have a corner at centre i on line j? (the strips' edges take those points too: no T-junctions, no pinholes) */
  const used = (i: number, j: number): boolean => {
    for (let b = j - 1; b <= j; b++) {
      if (b < 0 || b >= NY - 1) continue;
      if ((i > 0 && !flat[b * CX + i - 1]) || (i < CX && !flat[b * CX + i])) return true;
    }
    return false;
  };
  let runFrom = -1;
  const chain: number[] = [];
  const along = (j: number, from: number, to: number): number[] => {
    chain.length = 0;
    chain.push(from);
    for (let i = from + 1; i < to; i++) if (used(i, j)) chain.push(i);
    chain.push(to);
    return [...chain];
  };
  const flush = (j: number, to: number) => {
    if (runFrom < 0) return;
    const z = h(runFrom, j);
    // the strip from its two edges, zipped together
    const lo = along(j, runFrom, to);
    const hi = along(j + 1, runFrom, to);
    const P0 = (i: number) => [xs[i]!, ys[j]!, z];
    const P1 = (i: number) => [xs[i]!, ys[j + 1]!, z];
    let p = 0;
    let q = 0;
    while (p < lo.length - 1 || q < hi.length - 1) {
      if (q === hi.length - 1 || (p < lo.length - 1 && xs[lo[p + 1]!]! <= xs[hi[q + 1]!]!)) {
        tri(P0(lo[p]!), P0(lo[p + 1]!), P1(hi[q]!));
        p++;
      } else {
        tri(P0(lo[p]!), P1(hi[q + 1]!), P1(hi[q]!));
        q++;
      }
    }
    runFrom = -1;
  };
  for (let j = 0; j + 1 < NY; j++) {
    for (let i = 0; i + 1 < NX; i++) {
      if (flat[j * CX + i]) {
        if (runFrom < 0) runFrom = i;
        continue;
      }
      flush(j, i);
      let nb = 0;
      for (let c = 0; c < 4; c++) {
        hc[c] = h(i + ci[c]!, j + cj[c]!);
        pc[c] = [xs[i + ci[c]!]!, ys[j + cj[c]!]!];
      }
      for (let e = 0; e < 4; e++) {
        const f = (e + 1) % 4;
        br[e] = steep(hc[e]!, hc[f]!);
        if (br[e]) {
          nb++;
          xe[e] = cross(i + ci[e]!, j + cj[e]!, i + ci[f]!, j + cj[f]!);
        } else xe[e] = [(pc[e]![0]! + pc[f]![0]!) / 2, (pc[e]![1]! + pc[f]![1]!) / 2];
      }
      const at = (c: number) => [pc[c]![0]!, pc[c]![1]!, hc[c]!];
      if (nb === 0) {
        // one surface: two triangles, split across the corners nearer in height
        if (Math.abs(hc[0]! - hc[2]!) <= Math.abs(hc[1]! - hc[3]!)) {
          tri(at(0), at(1), at(2));
          tri(at(0), at(2), at(3));
        } else {
          tri(at(0), at(1), at(3));
          tri(at(1), at(2), at(3));
        }
      } else if (nb === 2) {
        // a wall across the square: from the one steep edge to the other
        const ea = br.indexOf(true);
        const eb = br.lastIndexOf(true);
        const a: number[][] = [[...xe[ea]!, hc[(ea + 1) % 4]!]];
        for (let c = ea + 1; c <= eb; c++) a.push(at(c % 4));
        a.push([...xe[eb]!, hc[eb]!]);
        const b: number[][] = [[...xe[eb]!, hc[(eb + 1) % 4]!]];
        for (let c = eb + 1; c <= ea + 4; c++) b.push(at(c % 4));
        b.push([...xe[ea]!, hc[ea]!]);
        poly(a);
        poly(b);
        const low = hc[ea]! < hc[(ea + 1) % 4]! ? ea : (ea + 1) % 4;
        face(xe[ea]!, xe[eb]!, hc[ea]!, hc[(ea + 1) % 4]!, hc[(eb + 1) % 4]!, hc[eb]!, false, pc[low]!);
      } else {
        // three levels meet (or a saddle): a quarter for each corner, walls between them
        const mid = [(pc[0]![0]! + pc[2]![0]!) / 2, (pc[0]![1]! + pc[2]![1]!) / 2];
        const onEdge = (e: number, c: number) => (br[e] ? hc[c]! : (hc[e]! + hc[(e + 1) % 4]!) / 2);
        for (let c = 0; c < 4; c++) {
          const prev = (c + 3) % 4;
          poly([at(c), [...xe[c]!, onEdge(c, c)], [...mid, hc[c]!], [...xe[prev]!, onEdge(prev, c)]]);
          const n = (c + 1) % 4;
          face(xe[c]!, mid, onEdge(c, c), onEdge(c, n), hc[c]!, hc[n]!, false, pc[hc[c]! < hc[n]! ? c : n]!);
        }
      }
    }
    flush(j, NX - 1);
  }
  // the block's own sides, from the bottom up to the edge of the top
  const side = (ia: number, ja: number, ib: number, jb: number) => {
    const ha = h(ia, ja);
    const hb = h(ib, jb);
    const pa = [xs[ia]!, ys[ja]!];
    const pb = [xs[ib]!, ys[jb]!];
    // outwards: away from the block's middle
    const out = [pa[0]! + pb[0]! - m.sx / 2, pa[1]! + pb[1]! - m.sy / 2];
    if (steep(ha, hb)) {
      const x = cross(ia, ja, ib, jb);
      face(pa, x, bottom, ha, bottom, ha, true, out);
      face(x, pb, bottom, hb, bottom, hb, true, out);
    } else face(pa, pb, bottom, ha, bottom, hb, true, out);
  };
  for (let i = 0; i + 1 < NX; i++) {
    side(i, 0, i + 1, 0);
    side(i, NY - 1, i + 1, NY - 1);
  }
  for (let j = 0; j + 1 < NY; j++) {
    side(0, j, 0, j + 1);
    side(NX - 1, j, NX - 1, j + 1);
  }
  // each wall vertex: the facings of the walls that stand there, averaged, unless they turn by
  // more than 40° (a corner: it stays sharp)
  const sum = new Map<string, [number, number]>();
  for (let v = 0; v < wkey.length; v++) {
    const s = sum.get(wkey[v]!) ?? [0, 0];
    s[0] += wn[2 * v]!;
    s[1] += wn[2 * v + 1]!;
    sum.set(wkey[v]!, s);
  }
  const normals = new Float32Array(wkey.length * 3);
  const sharp = Math.cos((40 * Math.PI) / 180);
  for (let v = 0; v < wkey.length; v++) {
    const fx = wn[2 * v]!;
    const fz = wn[2 * v + 1]!;
    const [sx, sz] = sum.get(wkey[v]!)!;
    const l = Math.hypot(sx, sz);
    const round = l > 1e-9 && (fx * sx + fz * sz) / l >= sharp;
    normals.set(round ? [sx / l, 0, sz / l] : [fx, 0, fz], v * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(wcol, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return g;
}

/** The milled block from the height map: its skin with walls along the outline of the cut (smoothSkin), or, where a part brought hollows with it from earlier setups, a column per cell with those hollows. */
export function millMesh(m: MillMaterial, look: WorkLook = PLAIN): THREE.Group {
  const group = new THREE.Group();
  // resample to at most ~320 cells per side for the mesh (the grid is about 300 on its longer side)
  const k = Math.max(1, Math.ceil(Math.max(m.nx, m.ny) / 320));
  const nx = Math.ceil(m.nx / k);
  const ny = Math.ceil(m.ny / k);
  const cw = m.cell * k;
  const hAt = (i: number, j: number) => {
    let h = Infinity;
    for (let jj = j * k; jj < Math.min(m.ny, (j + 1) * k); jj++)
      for (let ii = i * k; ii < Math.min(m.nx, (i + 1) * k); ii++) h = Math.min(h, m.h[jj * m.nx + ii]!);
    return h;
  };
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = hAt(i, j);

  // one flat quad per cell top, plus vertical faces where neighbours differ (a voxel-style skin)
  const pos: number[] = [];
  const col: number[] = [];
  const cutC = new THREE.Color(look.color);
  const rawC = new THREE.Color(look.raw);
  // `raw`: a face of the block as it came (its top where nothing was taken off, its outside)
  const quad = (a: number[], b: number[], c: number[], d: number[], raw: boolean) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    const k = raw ? rawC : cutC;
    for (let v = 0; v < 6; v++) col.push(k.r, k.g, k.b);
  };
  const P = (x: number, y: number, z: number) => [x, z, -y];
  const bottom = m.bottom;
  // Each column's metal as stretches of Z, bottom up. Cut from above only, that is one stretch
  // from the bottom to the height map; a part that came over from an earlier setup may have
  // hollows under its top (a pocket that is now in a side wall), kept in m.spans.
  const NONE: number[] = [];
  const columns: number[][] = new Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const h = heights[j * nx + i]!;
      let c: number[];
      if (h <= bottom + 1e-4) c = NONE;
      else if (!m.spans) c = [bottom, h];
      else {
        c = [];
        const k0 = Math.min(m.ny - 1, j * k) * m.nx + Math.min(m.nx - 1, i * k);
        for (let a = m.spans.at[k0]!; a < m.spans.at[k0 + 1]!; a += 2) {
          const z0 = m.spans.z[a]!;
          const z1 = Math.min(h, m.spans.z[a + 1]!);
          if (z1 > z0 + 1e-4) c.push(z0, z1);
        }
      }
      columns[j * nx + i] = c;
    }
  }
  const colOf = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? NONE : columns[j * nx + i]!);
  /** The parts of [a, b] that the other column's stretches do not cover: where a wall shows. */
  const bare = (a: number, b: number, other: number[], out: number[]) => {
    let lo = a;
    for (let n = 0; n < other.length && lo < b; n += 2) {
      const o0 = other[n]!;
      const o1 = other[n + 1]!;
      if (o1 <= lo) continue;
      if (o0 >= b) break;
      if (o0 > lo + 1e-4) out.push(lo, o0);
      lo = Math.max(lo, o1);
    }
    if (lo < b - 1e-4) out.push(lo, b);
  };
  // cut from above only (no hollows): walls that follow the cut's outline
  const hollow = !!m.spans && columns.some((c) => c.length > 2 || (c.length === 2 && c[0]! > bottom + 1e-4));
  const walls = hollow ? null : smoothSkin(heights, nx, ny, cw, k === 1, m, pos, col, cutC, rawC);
  const gaps: number[] = [];
  for (let j = 0; j < ny && hollow; j++) {
    for (let i = 0; i < nx; i++) {
      const c = columns[j * nx + i]!;
      if (!c.length) continue;
      const x0 = i * cw;
      const x1 = Math.min(m.sx, (i + 1) * cw);
      const y0 = j * cw;
      const y1 = Math.min(m.sy, (j + 1) * cw);
      for (let n = 0; n < c.length; n += 2) {
        const z0 = c[n]!;
        const z1 = c[n + 1]!;
        // the top of the stretch, and its underside where a hollow is below it
        quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), z1 >= m.top - 1e-4);
        if (z0 > bottom + 1e-4) quad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0), P(x0, y0, z0), false);
        // walls where the neighbour has no metal beside it (+x, -x, +y, -y); the block's own outside is raw
        gaps.length = 0;
        bare(z0, z1, colOf(i + 1, j), gaps);
        for (let q = 0; q < gaps.length; q += 2) quad(P(x1, y0, gaps[q]!), P(x1, y1, gaps[q]!), P(x1, y1, gaps[q + 1]!), P(x1, y0, gaps[q + 1]!), i + 1 >= nx);
        gaps.length = 0;
        bare(z0, z1, colOf(i - 1, j), gaps);
        for (let q = 0; q < gaps.length; q += 2) quad(P(x0, y1, gaps[q]!), P(x0, y0, gaps[q]!), P(x0, y0, gaps[q + 1]!), P(x0, y1, gaps[q + 1]!), i === 0);
        gaps.length = 0;
        bare(z0, z1, colOf(i, j + 1), gaps);
        for (let q = 0; q < gaps.length; q += 2) quad(P(x1, y1, gaps[q]!), P(x0, y1, gaps[q]!), P(x0, y1, gaps[q + 1]!), P(x1, y1, gaps[q + 1]!), j + 1 >= ny);
        gaps.length = 0;
        bare(z0, z1, colOf(i, j - 1), gaps);
        for (let q = 0; q < gaps.length; q += 2) quad(P(x0, y0, gaps[q]!), P(x1, y0, gaps[q]!), P(x1, y0, gaps[q + 1]!), P(x0, y0, gaps[q + 1]!), j === 0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: look.metalness, roughness: look.roughness, flatShading: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  if (walls) {
    const wm = new THREE.Mesh(walls, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: look.metalness, roughness: look.roughness, side: THREE.DoubleSide }));
    wm.castShadow = true;
    wm.receiveShadow = true;
    group.add(wm);
  }

  // the raw stock as an outline
  const box = new THREE.BoxGeometry(m.sx, m.top - bottom, m.sy);
  box.translate(m.sx / 2, (m.top + bottom) / 2, -m.sy / 2);
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: COLORS.stock, transparent: true, opacity: 0.6 })));
  return group;
}

/** The tool at its tip position: an insert on the lathe, a cutter body on the mill. */
export function toolMesh(lathe: boolean, diameter: number): THREE.Object3D {
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.tool, metalness: 0.3, roughness: 0.45, transparent: true, opacity: 0.9 });
  if (lathe) {
    // a rhombic insert pointing at the work, holder going up and back
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(5, 2.5);
    shape.lineTo(3.5, 9);
    shape.lineTo(-1.5, 6.5);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false });
    g.translate(0, 0, -1.5);
    return new THREE.Mesh(g, mat);
  }
  const len = Math.max(15, diameter * 3);
  const g = new THREE.CylinderGeometry(diameter / 2, diameter / 2, len, 32);
  g.translate(0, len / 2, 0);
  return new THREE.Mesh(g, mat);
}
