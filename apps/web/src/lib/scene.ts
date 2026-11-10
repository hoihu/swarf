/**
 * three.js builders for the preview. Machine coordinates map to the scene so that "up" is up:
 * mill (x, y, z) → scene (x, z, -y); lathe (radius x, z) → scene (z, x, 0) with the spindle
 * axis along scene X.
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

/** The inverse of toScene as a matrix (scene → work coordinates; lathe: x radius, y across the bed, z along the spindle). */
export function sceneToWork(lathe: boolean): THREE.Matrix4 {
  return lathe ? new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1) : new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
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
    const lathe = job.stock.kind === 'bar';
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => (lathe ? new THREE.Vector3(p.z, p.x, p.y) : toScene(p, false))));
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
  return lathe ? new THREE.Vector3(p.z, p.x, 0) : new THREE.Vector3(p.x, p.z, -p.y);
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

/** The milled block: height map as a stepped top surface plus walls down to the bottom. */
export function millMesh(m: MillMaterial, look: WorkLook = PLAIN): THREE.Group {
  const group = new THREE.Group();
  // resample to at most ~250 cells per side for the mesh
  const k = Math.max(1, Math.ceil(Math.max(m.nx, m.ny) / 250));
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
  const H = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? bottom : heights[j * nx + i]!);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const h = heights[j * nx + i]!;
      const x0 = i * cw;
      const x1 = Math.min(m.sx, (i + 1) * cw);
      const y0 = j * cw;
      const y1 = Math.min(m.sy, (j + 1) * cw);
      if (h > bottom + 1e-4) quad(P(x0, y0, h), P(x1, y0, h), P(x1, y1, h), P(x0, y1, h), h >= m.top - 1e-4);
      // walls towards lower neighbours (+x, -x, +y, -y); the block's own outside is raw
      const hx1 = H(i + 1, j);
      if (hx1 < h) quad(P(x1, y0, hx1), P(x1, y1, hx1), P(x1, y1, h), P(x1, y0, h), i + 1 >= nx);
      const hx0 = H(i - 1, j);
      if (hx0 < h) quad(P(x0, y1, hx0), P(x0, y0, hx0), P(x0, y0, h), P(x0, y1, h), i === 0);
      const hy1 = H(i, j + 1);
      if (hy1 < h) quad(P(x1, y1, hy1), P(x0, y1, hy1), P(x0, y1, h), P(x1, y1, h), j + 1 >= ny);
      const hy0 = H(i, j - 1);
      if (hy0 < h) quad(P(x0, y0, hy0), P(x1, y0, hy0), P(x1, y0, h), P(x0, y0, h), j === 0);
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
