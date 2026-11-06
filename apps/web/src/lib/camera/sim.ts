/**
 * A simulated camera looking at the (simulated) machine: the stock, the chuck or table, the tool
 * at the machine position with the tool marker on its holder, and, while the lens is being
 * calibrated, the board held up in front of the camera at changing angles. It renders through a
 * known lens (with distortion) from a known position onto `canvas`, which the app reads like a
 * webcam's picture. Its true lens and pose are on `window.__swarfSimCamera`,
 * to check a calibration against.
 */
import * as THREE from 'three';
import type { Job } from '@swarf/cam';
import { BOARD, TOOL_MARKER, boardImage, markerImage, type CV } from './cv.ts';
import { glProjection, glView, project, type Lens, type Pose, type V3 } from './geometry.ts';

export interface SimWorld {
  job: Job;
  /** Machine position of the tool tip; lathe x is a radius. */
  mpos: V3;
  /** Work offset (machine coordinates of work zero); lathe x a radius. */
  wco: V3;
  /** Show the board in front of the camera (lens calibration). */
  board: boolean;
}

/** Where the tool marker sits relative to the tip, in machine coordinates (the "truth" the calibration finds). */
const MARKER_OFFSET = { mill: [6, -44, 58] as V3, lathe: [34, 22, 4] as V3 };
const MARKER_SIZE = 24; // black square, mm

function lookAt(C: V3, target: V3, up: V3): Pose {
  const n = (v: V3): V3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = n([target[0] - C[0], target[1] - C[1], target[2] - C[2]]);
  const x = n(cross(z, up));
  const y = cross(z, x);
  const R = [...x, ...y, ...z] as Pose['R'];
  const t: V3 = [-(x[0] * C[0] + x[1] * C[1] + x[2] * C[2]), -(y[0] * C[0] + y[1] * C[1] + y[2] * C[2]), -(z[0] * C[0] + z[1] * C[1] + z[2] * C[2])];
  return { R, t };
}

const texture = (img: ImageData): THREE.Texture => {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};

export class SimCamera {
  readonly width = 1280;
  readonly height = 720;
  readonly lens: Lens = { width: 1280, height: 720, fx: 1060, fy: 1058, cx: 652, cy: 349, dist: [-0.16, 0.09, 0.0006, -0.0004, 0] };
  pose: Pose = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  /** The camera picture. */
  readonly canvas: HTMLCanvasElement;
  /** Counts the pictures rendered (to redraw only on a new one). */
  frameNo = 0;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #target: THREE.WebGLRenderTarget;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera();
  readonly #post: { scene: THREE.Scene; camera: THREE.OrthographicCamera };
  readonly #world: () => SimWorld;
  #fixed = new THREE.Group();
  #tool = new THREE.Group();
  #board: THREE.Mesh;
  #boardUntil = 0;
  #key = '';
  /** How the real block differs from the job's (for trying the setup check): front-left corner offset, size difference, turn in degrees. */
  stockError = { dx: 0, dy: 0, dsx: 0, dsy: 0, angle: 0 };
  #timer: ReturnType<typeof setInterval>;

  constructor(cv: CV, world: () => SimWorld) {
    this.#world = world;
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    this.canvas = canvas;
    // kept after compositing, so the picture can be copied out any time
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.#renderer.setSize(this.width, this.height, false);
    this.#target = new THREE.WebGLRenderTarget(this.width, this.height);
    this.#target.texture.colorSpace = THREE.SRGBColorSpace;

    this.#scene.background = new THREE.Color('#5d6468');
    this.#scene.add(new THREE.HemisphereLight(0xf0f2f0, 0x707478, 2.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(200, -300, 600);
    this.#scene.add(sun, this.#fixed, this.#tool, this.#camera);

    // the board, held in front of the camera (a child of it, posed in its frame)
    const bw = BOARD.nx * BOARD.square;
    const bh = BOARD.ny * BOARD.square;
    const margin = 8;
    this.#board = new THREE.Mesh(new THREE.PlaneGeometry(bw + 2 * margin, bh + 2 * margin), new THREE.MeshBasicMaterial({ map: texture(boardImage(cv, 4, margin)), side: THREE.DoubleSide, depthTest: false }));
    // held up to the camera: in front of everything, whatever is farther away in the scene
    this.#board.renderOrder = 10;
    this.#board.visible = false;
    this.#camera.add(this.#board);

    // the tool: a cutter or an insert holder, with the marker on a little plate
    const markerTex = texture(markerImage(cv, TOOL_MARKER, 256));
    const plate = new THREE.Mesh(new THREE.PlaneGeometry((MARKER_SIZE * 8) / 6, (MARKER_SIZE * 8) / 6), new THREE.MeshBasicMaterial({ map: markerTex, side: THREE.DoubleSide }));
    plate.name = 'marker';
    this.#tool.add(plate);

    // lens distortion: the sharp pinhole picture, resampled the way the lens bends it
    const L = this.lens;
    const mat = new THREE.ShaderMaterial({
      uniforms: { src: { value: this.#target.texture }, size: { value: new THREE.Vector2(L.width, L.height) }, k: { value: new THREE.Vector4(L.fx, L.fy, L.cx, L.cy) }, d: { value: L.dist } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D src; uniform vec2 size; uniform vec4 k; uniform float d[5];
        void main() {
          // this pixel in OpenCV's terms (pixel centres at whole numbers; GL's are at +0.5, from the bottom)
          vec2 p = vec2(gl_FragCoord.x - 0.5, size.y - gl_FragCoord.y - 0.5);
          vec2 xd = (p - k.zw) / k.xy;
          vec2 x = xd;
          for (int i = 0; i < 8; i++) {
            float r2 = dot(x, x);
            float radial = 1.0 + d[0] * r2 + d[1] * r2 * r2 + d[4] * r2 * r2 * r2;
            vec2 tang = vec2(2.0 * d[2] * x.x * x.y + d[3] * (r2 + 2.0 * x.x * x.x), d[2] * (r2 + 2.0 * x.y * x.y) + 2.0 * d[3] * x.x * x.y);
            x = (xd - tang) / radial;
          }
          vec2 s = x * k.xy + k.zw;
          gl_FragColor = (s.x < 0.0 || s.y < 0.0 || s.x > size.x || s.y > size.y) ? vec4(0.0, 0.0, 0.0, 1.0) : texture2D(src, vec2((s.x + 0.5) / size.x, 1.0 - (s.y + 0.5) / size.y));
          #include <colorspace_fragment>
        }`,
    });
    const post = new THREE.Scene();
    post.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    this.#post = { scene: post, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };

    this.#timer = setInterval(() => this.#render(), 100);
    (window as unknown as { __swarfSimCamera?: unknown }).__swarfSimCamera = this;
  }

  /** The true pixel of a machine point in this camera's image (for tests). */
  project(X: V3): [number, number] | null {
    return project(this.lens, this.pose, X);
  }

  /** The tool marker's true offset from the tip (machine coordinates). */
  markerOffset(): V3 {
    return MARKER_OFFSET[this.#world().job.machine.kind];
  }

  #build(w: SimWorld): void {
    const { job } = w;
    const key = `${job.machine.kind}:${JSON.stringify(job.stock)}:${w.wco.join(',')}:${JSON.stringify(this.stockError)}`;
    if (key === this.#key) return;
    this.#key = key;
    this.#fixed.clear();
    const [ox, oy, oz] = w.wco;
    const metal = new THREE.MeshLambertMaterial({ color: '#c9ced0' });
    const dark = new THREE.MeshLambertMaterial({ color: '#4a5155' });
    const plate = this.#tool.getObjectByName('marker')!;
    this.#tool.clear();
    // aimed in the tool's own frame: put the tool at the origin while doing so (lookAt works in world terms)
    this.#tool.position.set(0, 0, 0);
    this.#tool.updateMatrixWorld(true);
    this.#tool.add(plate);
    if (job.stock.kind === 'block') {
      const s = job.stock;
      // the real block: as the job has it, unless told otherwise (corner offset, size, turned about its front-left corner)
      const er = this.stockError;
      const bx = s.x + er.dsx;
      const by = s.y + er.dsy;
      const a = (er.angle * Math.PI) / 180;
      const block = new THREE.Mesh(new THREE.BoxGeometry(bx, by, s.z), metal);
      block.rotation.z = a;
      block.position.set(ox + er.dx + (bx / 2) * Math.cos(a) - (by / 2) * Math.sin(a), oy + er.dy + (bx / 2) * Math.sin(a) + (by / 2) * Math.cos(a), oz + s.top - s.z / 2);
      const table = new THREE.Mesh(new THREE.BoxGeometry(600, 300, 20), dark);
      table.position.set(ox + s.x / 2, oy + s.y / 2, oz + s.top - s.z - 10);
      this.#fixed.add(block, table);
      // the camera: in front of the machine, up and looking down at the work
      this.pose = lookAt([ox + s.x / 2 + 30, oy - 210, oz + s.top + 190], [ox + s.x / 2, oy + s.y / 2, oz + s.top + 15], [0, 0, 1]);
      // cutter (tip at the origin of the tool group) and spindle
      const d = 6;
      const cutter = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, 40, 24).rotateX(Math.PI / 2).translate(0, 0, 20), metal);
      const spindle = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 80, 32).rotateX(Math.PI / 2).translate(0, 0, 80), dark);
      this.#tool.add(cutter, spindle);
      plate.position.set(...MARKER_OFFSET.mill);
      plate.lookAt(new THREE.Vector3(...MARKER_OFFSET.mill).add(new THREE.Vector3(0, -1, 0.35)));
    } else {
      const s = job.stock;
      const chuckZ = s.front - s.stickout;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(s.diameter / 2, s.diameter / 2, s.stickout, 64).rotateX(Math.PI / 2), metal);
      bar.position.set(ox, oy, oz + chuckZ + s.stickout / 2);
      const cd = job.machine.chuckDiameter ?? 100;
      const chuck = new THREE.Mesh(new THREE.CylinderGeometry(cd / 2, cd / 2, 50, 64).rotateX(Math.PI / 2), dark);
      chuck.position.set(ox, oy, oz + chuckZ - 25);
      this.#fixed.add(bar, chuck);
      // the lathe's frame: x towards the operator, z along the spindle, y up; camera in front, above
      this.pose = lookAt([ox + 190, oy + 150, oz + s.front - s.stickout / 2 + 25], [ox + 15, oy, oz + s.front - s.stickout / 2 + 10], [0, 1, 0]);
      const insert = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 8).translate(4, 0, 2), metal);
      const holder = new THREE.Mesh(new THREE.BoxGeometry(80, 16, 16).translate(44, -4, 6), dark);
      this.#tool.add(insert, holder);
      plate.position.set(...MARKER_OFFSET.lathe);
      plate.lookAt(new THREE.Vector3(...MARKER_OFFSET.lathe).add(new THREE.Vector3(0.7, 0.75, 0.05)));
    }
    this.#camera.projectionMatrix.fromArray(glProjection({ ...this.lens, dist: [0, 0, 0, 0, 0] }, 20, 5000));
    this.#camera.projectionMatrixInverse.copy(this.#camera.projectionMatrix).invert();
    this.#camera.matrixAutoUpdate = false;
    this.#camera.matrix.fromArray(glView(this.pose)).invert();
    this.#camera.matrixWorldNeedsUpdate = true;
  }

  #render(): void {
    const w = this.#world();
    this.#build(w);
    this.#tool.position.set(...w.mpos);
    // the board: a new hold every 1.2 s, somewhere in view, tilted
    this.#board.visible = w.board;
    if (w.board && performance.now() > this.#boardUntil) {
      this.#boardUntil = performance.now() + 1200;
      const r = (a: number) => (Math.random() * 2 - 1) * a;
      const dist = 330 + Math.random() * 200;
      this.#board.position.set(r(0.28) * dist, r(0.18) * dist, -dist);
      this.#board.rotation.set(r(0.6), r(0.6), r(0.35));
    }
    this.#renderer.setRenderTarget(this.#target);
    this.#renderer.render(this.#scene, this.#camera);
    this.#renderer.setRenderTarget(null);
    this.#renderer.render(this.#post.scene, this.#post.camera);
    this.frameNo++;
  }

  dispose(): void {
    clearInterval(this.#timer);
    this.#target.dispose();
    this.#renderer.dispose();
  }
}
