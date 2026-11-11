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
import { simWorld } from '../simworld.ts';
import { topOf, type Solid } from '../sim/solids.ts';
import { LAG, LASER, millCamera } from '../sim/rig.ts';

export interface SimWorld {
  job: Job;
  /** Machine position of the tool tip; lathe x is a radius. */
  mpos: V3;
  /** Work offset (machine coordinates of work zero); lathe x a radius. */
  wco: V3;
  /** Show the board in front of the camera (lens calibration). */
  board: boolean;
  /** The line laser on the spindle head is on. */
  laser: boolean;
}

export { LASER };

/** Where the tool marker sits relative to the tip, in machine coordinates (the "truth" the calibration finds). */
// (on an arm beside the spindle, clear of the laser's fan)
const MARKER_OFFSET = { mill: [50, -40, 58] as V3, lathe: [34, 22, 4] as V3 };
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
  readonly laser = LASER;
  #laserMat: THREE.ShaderMaterial;
  #noise: THREE.ShaderMaterial;
  /** The laser's view, for its shadows: distance to the first surface along each ray of the fan. */
  #shadow = new THREE.WebGLRenderTarget(2048, 160, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  #shadowCam = new THREE.PerspectiveCamera(10, Math.tan((50 * Math.PI) / 180) / Math.tan((5 * Math.PI) / 180), 1, 3000);
  #distMat = new THREE.ShaderMaterial({
    uniforms: { P: { value: new THREE.Vector3() } },
    vertexShader: 'varying vec3 wp; void main() { wp = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 P; varying vec3 wp; void main() { gl_FragColor = vec4(length(wp - P), 0.0, 0.0, 1.0); }',
    side: THREE.DoubleSide,
  });
  /** How the picture lags the machine (ms). */
  readonly lag = LAG;
  #history: { t: number; mpos: V3; laser: boolean }[] = [];
  #timer: ReturnType<typeof setInterval>;
  #sampler: ReturnType<typeof setInterval>;

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
      uniforms: { src: { value: this.#target.texture }, size: { value: new THREE.Vector2(L.width, L.height) }, k: { value: new THREE.Vector4(L.fx, L.fy, L.cx, L.cy) }, d: { value: L.dist }, seed: { value: 0 } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D src; uniform vec2 size; uniform vec4 k; uniform float d[5]; uniform float seed;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
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
          // a real lens is never perfectly sharp: a slight blur (3 × 3, 0.7 px apart), which also
          // smooths the stair steps of the unantialiased render
          vec4 c = vec4(0.0);
          for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
            float w = (i == 0 ? 2.0 : 1.0) * (j == 0 ? 2.0 : 1.0) / 16.0;
            vec2 q = s + 0.7 * vec2(float(i), float(j));
            c += w * texture2D(src, vec2((q.x + 0.5) / size.x, 1.0 - (q.y + 0.5) / size.y));
          }
          gl_FragColor = (s.x < 0.0 || s.y < 0.0 || s.x > size.x || s.y > size.y) ? vec4(0.0, 0.0, 0.0, 1.0) : c;
          #include <colorspace_fragment>
          // the sensor's noise: a few levels, different in every picture and every colour
          gl_FragColor.rgb += 5.0 / 255.0 * (vec3(hash(gl_FragCoord.xy), hash(gl_FragCoord.yx + 17.0), hash(gl_FragCoord.xy + 31.0)) - 0.5) * 2.0;
        }`,
    });
    this.#noise = mat;
    this.#laserMat = new THREE.ShaderMaterial({
      uniforms: {
        n: { value: new THREE.Vector3() },
        d: { value: 0 },
        hw: { value: LASER.halfWidth },
        P: { value: new THREE.Vector3() },
        down: { value: new THREE.Vector3(...LASER.down) },
        across: { value: new THREE.Vector3() },
        fan: { value: (LASER.fan * Math.PI) / 180 },
        sh: { value: this.#shadow.texture },
        shM: { value: new THREE.Matrix4() },
      },
      // the same position computation as three's own materials (else the depth test flickers against them)
      vertexShader: 'varying vec3 wp; void main() { wp = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 n; uniform float d; uniform float hw; uniform vec3 P; uniform vec3 down; uniform vec3 across; uniform float fan;
        uniform sampler2D sh; uniform mat4 shM; varying vec3 wp;
        void main() {
          float x = (dot(n, wp) + d) / hw; float i = exp(-x * x); if (i < 0.02) discard;
          // within the fan
          vec3 v = wp - P;
          if (abs(atan(dot(v, across), dot(v, down))) > fan) discard;
          // and lit: nothing nearer to the laser along this ray (1 mm grace for the map's coarseness)
          vec4 c = shM * vec4(wp, 1.0);
          if (c.w <= 0.0) discard;
          vec2 uv = c.xy / c.w * 0.5 + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          float first = texture2D(sh, uv).r;
          if (first > 0.0 && length(v) > first + 1.0) discard;
          gl_FragColor = vec4(i, 0.0, 0.0, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      // and pulled a hair towards the camera, so it always wins against the surface it lies on
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      transparent: true,
    });
    const post = new THREE.Scene();
    post.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    this.#post = { scene: post, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };

    // what the machine was doing, a little while back (the picture shows the past)
    this.#sampler = setInterval(() => {
      const w = this.#world();
      const t = performance.now();
      this.#history.push({ t, mpos: [...w.mpos] as V3, laser: w.laser });
      while (this.#history.length > 2 && this.#history[1]!.t < t - 1000) this.#history.shift();
    }, 10);
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
    // what is really there sits where the simulator's work zero started (a new zero does not move it)
    const [ox, oy, oz] = simWorld.origin ?? w.wco;
    const key = `${job.machine.kind}:${JSON.stringify(job.stock)}:${[ox, oy, oz].join(',')}:${JSON.stringify([simWorld.stockError, simWorld.setup, simWorld.plate, simWorld.toolDiameter, simWorld.stickout, simWorld.barError])}`;
    if (key === this.#key) return;
    this.#key = key;
    this.#fixed.clear();
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
      // the real block and what holds it (simworld.ts, sim/setups.ts)
      const looks: Record<Solid['look'], THREE.Material> = {
        stock: metal,
        steel: new THREE.MeshLambertMaterial({ color: '#8b9296' }),
        dark: dark,
        copper: new THREE.MeshLambertMaterial({ color: '#c08a50' }),
      };
      const world = simWorld.world(job);
      for (const sol of world.solids) this.#fixed.add(solidMesh(sol, looks[sol.look], [ox, oy, oz]));
      const table = new THREE.Mesh(new THREE.BoxGeometry(600, 300, 20), dark);
      table.position.set(ox + s.x / 2, oy + s.y / 2, oz + world.floor - 10);
      this.#fixed.add(table);
      // the camera: in front of the machine, up and looking down at the work
      const cam = millCamera(s);
      this.pose = lookAt([ox + cam.at[0], oy + cam.at[1], oz + cam.at[2]], [ox + cam.target[0], oy + cam.target[1], oz + cam.target[2]], [0, 0, 1]);
      // cutter (tip at the origin of the tool group) and spindle
      // the cutter now in the spindle: its diameter, and how much further it sticks out than the first one
      const d = simWorld.toolDiameter;
      const out = simWorld.stickout;
      const cutter = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, 40 + out, 24).rotateX(Math.PI / 2).translate(0, 0, 20 - out / 2), metal);
      const spindle = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 80, 32).rotateX(Math.PI / 2).translate(0, 0, 80), dark);
      this.#tool.add(cutter, spindle);
      // the laser module on the front of the spindle head
      const module = new THREE.Mesh(new THREE.BoxGeometry(14, 10, 22), dark);
      module.name = 'laser module';
      module.position.set(LASER.at[0], LASER.at[1] - 2, LASER.at[2] + 8);
      this.#tool.add(module);
      plate.position.set(...MARKER_OFFSET.mill);
      plate.lookAt(new THREE.Vector3(...MARKER_OFFSET.mill).add(new THREE.Vector3(0, -1, 0.35)));
    } else {
      const s = job.stock;
      const chuckZ = s.front - s.stickout;
      // the bar as it really is: not quite the job's
      const e = simWorld.barError;
      const real = { d: s.diameter + e.diameter, out: s.stickout + e.stickout, chuck: s.front + e.front - (s.stickout + e.stickout) };
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(real.d / 2, real.d / 2, real.out, 64).rotateX(Math.PI / 2), metal);
      bar.position.set(ox, oy, oz + real.chuck + real.out / 2);
      const cd = job.machine.chuckDiameter ?? 100;
      const chuck = new THREE.Mesh(new THREE.CylinderGeometry(cd / 2, cd / 2, 50, 64).rotateX(Math.PI / 2), dark);
      chuck.position.set(ox, oy, oz + real.chuck - 25);
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
    const now = this.#world();
    // the machine as it was LAG ms ago
    const then = performance.now() - LAG;
    let past = this.#history[0];
    for (const h of this.#history) if (h.t <= then) past = h;
    const w = past ? { ...now, mpos: past.mpos, laser: past.laser } : now;
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
    if (w.laser && w.job.machine.kind === 'mill') {
      // the laser line: wherever the sheet of light cuts the surfaces, added on top of the picture
      const P: V3 = [w.mpos[0] + LASER.at[0], w.mpos[1] + LASER.at[1], w.mpos[2] + LASER.at[2]];
      const n = LASER.normal;
      this.#laserMat.uniforms.n!.value.set(...n);
      this.#laserMat.uniforms.d!.value = -(n[0] * P[0] + n[1] * P[1] + n[2] * P[2]);
      const board = this.#board.visible;
      this.#board.visible = false;
      this.#laserShadows(P);
      // a colour background makes three.js clear the picture even without autoClear: off for this pass
      const bg = this.#scene.background;
      this.#scene.background = null;
      this.#scene.overrideMaterial = this.#laserMat;
      this.#renderer.autoClear = false;
      try {
        this.#renderer.render(this.#scene, this.#camera);
      } finally {
        this.#renderer.autoClear = true;
        this.#scene.overrideMaterial = null;
        this.#scene.background = bg;
      }
      this.#board.visible = board;
    }
    this.#renderer.setRenderTarget(null);
    this.#noise.uniforms.seed!.value = Math.random() * 100;
    this.#renderer.render(this.#post.scene, this.#post.camera);
    this.frameNo++;
  }

  /** The laser's view of the scene into the shadow map (the module itself left out: the light comes from inside it). */
  #laserShadows(P: V3): void {
    const c = this.#shadowCam;
    const dn = LASER.down;
    const n = LASER.normal;
    c.position.set(...P);
    c.up.set(...n);
    c.lookAt(P[0] + dn[0], P[1] + dn[1], P[2] + dn[2]);
    c.updateMatrixWorld(true);
    c.updateProjectionMatrix();
    const u = this.#laserMat.uniforms;
    u.P!.value.set(...P);
    u.across!.value.set(...LASER.across);
    u.shM!.value.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.#distMat.uniforms.P!.value.set(...P);
    const module = this.#tool.getObjectByName('laser module');
    if (module) module.visible = false;
    const bg = this.#scene.background;
    this.#scene.background = null;
    this.#scene.overrideMaterial = this.#distMat;
    this.#renderer.setRenderTarget(this.#shadow);
    // cleared to 0: nothing there
    this.#renderer.setClearColor(0x000000, 0);
    this.#renderer.clear();
    this.#renderer.render(this.#scene, c);
    this.#scene.overrideMaterial = null;
    this.#scene.background = bg;
    if (module) module.visible = true;
    this.#renderer.setRenderTarget(this.#target);
  }

  dispose(): void {
    clearInterval(this.#timer);
    clearInterval(this.#sampler);
    this.#shadow.dispose();
    this.#target.dispose();
    this.#renderer.dispose();
  }
}

/** A solid's mesh (machine coordinates: its work position plus the origin): a box with its top sloped as it is, or a cylinder. */
function solidMesh(s: Solid, material: THREE.Material, o: V3): THREE.Mesh {
  if (s.kind === 'cyl') {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(s.r, s.r, s.z1 - s.z0, 32).rotateX(Math.PI / 2), material);
    m.position.set(o[0] + s.cx, o[1] + s.cy, o[2] + (s.z0 + s.z1) / 2);
    return m;
  }
  // a unit-high box, turned and placed, then each corner at its height: the bottom, or the top there
  const g = new THREE.BoxGeometry(s.w, s.d, 1).translate(0, 0, 0.5).rotateZ((s.angle * Math.PI) / 180).translate(s.cx, s.cy, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    p.setXYZ(i, o[0] + x, o[1] + y, o[2] + (p.getZ(i) > 0.5 ? topOf(s, x, y) : s.z0));
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, material);
}
