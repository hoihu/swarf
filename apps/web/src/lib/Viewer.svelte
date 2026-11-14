<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { LatheMaterial, MillMaterial, moveLength, samplePath, simulate, walk, type Job, type Move, type Program, type Tool, type Vec3 } from '@swarf/cam';
  import { drawingLines, latheMesh, millMesh, obstacleMeshes, pathGeometry, sceneToWork, stockOutline, toScene, type PathGeometry } from './scene.ts';
  import { CHIPS, Chips, Coolant } from './workshop/particles.ts';
  import { METAL, bedMesh, chuckGroup, latheToolMesh, millToolMesh, nozzleMesh, tableMesh } from './workshop/stage.ts';
  import { SURROUNDS, cover, makeSurround, type Surround } from './workshop/surround.ts';
  import { MachineSound } from './workshop/sound.ts';
  import { SPEEDS, look } from './workshop/look.svelte.ts';
  import { camera as cam } from './camera/camera.svelte.ts';
  import { glProjection, glView } from './camera/geometry.ts';
  import { laserScan } from './camera/laserscan.svelte.ts';

  let {
    job,
    program,
    selected = null,
    live = null,
    spindle = 0,
  }: { job: Job; program: Program; selected?: string | null; /** The machine's work position while a controller is connected (lathe: x is a radius). */ live?: Vec3 | null; /** The connected machine's spindle speed (0: off). */ spindle?: number } = $props();

  let host: HTMLDivElement;
  let renderer: THREE.WebGLRenderer | null = null;
  let camera: THREE.PerspectiveCamera;
  let controls: OrbitControls;
  const scene = new THREE.Scene();
  const world = new THREE.Group();
  scene.add(world);

  let total = $state(0);
  /** Moves shown as done; total = the whole program. */
  let at = $state(0);
  let playing = $state(false);
  let followEnd = true;
  let fitKey = '';
  let raf = 0;
  let resize: ResizeObserver | null = null;
  let mounted = $state(false);
  /** Something in the scene changed since the last render. */
  let dirty = true;

  // scene objects that are rebuilt
  let path: PathGeometry | null = null;
  let doneLines: THREE.LineSegments | null = null;
  let todoLines: THREE.LineSegments | null = null;
  let part: THREE.Object3D | null = null;
  let fixture: THREE.Object3D | null = null;
  let tool: THREE.Object3D | null = null;
  let toolKey = '';
  let tips: { p: Vec3; tool: number; cut: boolean; rpm: number }[] = [];
  /** Each move as walked: where it starts, and the move. */
  let moves: { from: Vec3; move: Move }[] = [];
  /** Program time at the end of each move, seconds: length over feed, rapids at the machine's rapid rate. */
  let ends: number[] = [];
  /** Where Play has got to, program seconds. */
  let clock = $state(0);
  /** The whole program's time, seconds (shown beside the slider). */
  let runtime = $state(0);
  /** While playing: the tool part way along move `at` (null: at the end of move at − 1). */
  let between: Vec3 | null = null;
  /** The points of a move (arcs as short chords) from its start, with the length up to each: the last one asked for. */
  let way: { i: number; pts: Vec3[]; cum: number[] } | null = null;
  /** Program time the part in the preview is cut to, seconds: while playing it follows the tool. */
  let cutClock = 0;
  /** The part was cut since its mesh was last made; when that was (ms). */
  let meshDue = false;
  let meshAt = 0;

  // ---- the workshop around it: surroundings, table, chips, coolant, sound ----
  const chips = new Chips();
  const coolant = new Coolant();
  const sound = new MachineSound();
  let surround: Surround | null = null;
  let keyLight: THREE.DirectionalLight | null = null;
  let hemi: THREE.HemisphereLight | null = null;
  let stage: THREE.Object3D | null = null;
  let nozzle: THREE.Object3D | null = null;
  /** The coolant between the nozzle and the cutter: a thin stream (the drops are what splashes off). */
  const jet = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.8, 1, 10, 1, true).translate(0, 0.5, 0), coolant.mesh.material);
  jet.visible = false;
  /** The machine's own lamp, for the night shift: warm, from beside the spindle, on the work. */
  const lamp = new THREE.SpotLight(0xffd9a8, 0, 0, 0.6, 0.6, 0);
  lamp.castShadow = false;
  let material: LatheMaterial | MillMaterial | null = null;
  const partMaterials = new Map<string, THREE.MeshStandardMaterial>();
  let lastTime = 0;
  let liveAt = '';
  /** Where the cutter's tip was at the last frame (scene), for the chips between there and here. */
  const lastTip = new THREE.Vector3();
  let haveTip = false;
  let menu = $state(false);
  let dropping = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  /** Is the cutter in the work at this tip position (work coordinates)? Roughly: within the stock. */
  function engaged(p: Vec3, toolId: number): boolean {
    const s = job.stock;
    const r = (job.tools.find((t) => t.id === toolId)?.diameter ?? 6) / 2;
    if (s.kind === 'block') return p.z <= s.top + 0.02 && p.x > -r && p.x < s.x + r && p.y > -r && p.y < s.y + r;
    return p.x <= s.diameter / 2 + 0.02 && p.z <= s.front + 0.02;
  }

  /** The ground for what falls: the work as it is cut, the table around it (mill); the bed (lathe). */
  function setGround(): void {
    const s = job.stock;
    if (s.kind === 'block') {
      const ext = stage?.userData.extent as { x0: number; x1: number; z0: number; z1: number } | undefined;
      const bottom = s.top - s.z;
      const m = material instanceof MillMaterial ? material : null;
      const ground = (x: number, z: number) => {
        const y = -z;
        if (m && x >= 0 && y >= 0 && x < m.sx && y < m.sy) return m.h[Math.min(m.ny - 1, Math.floor(y / m.cell)) * m.nx + Math.min(m.nx - 1, Math.floor(x / m.cell))]!;
        if (ext && x > ext.x0 && x < ext.x1 && z > ext.z0 && z < ext.z1) return bottom;
        return -Infinity;
      };
      chips.ground = ground;
      coolant.ground = ground;
    } else {
      const y = -Math.max(s.diameter * 1.1, (job.machine.chuckDiameter ?? s.diameter * 2.5) / 2 + 12);
      const ground = (x: number, z: number) => (Math.abs(z) < s.diameter * 1.6 && x > s.front - s.stickout - 60 && x < s.front + 80 ? y + 5 : -Infinity);
      chips.ground = ground;
      coolant.ground = ground;
    }
  }

  /** The surroundings as the look says. */
  function applySurround(): void {
    if (!renderer) return;
    surround?.dispose();
    surround = makeSurround(renderer, look.surround, look.picture, look.soften);
    scene.environment = surround.environment;
    scene.environmentIntensity = surround.light;
    placeBackground();
    if (keyLight) keyLight.intensity = 2.2 * surround.light;
    if (hemi) hemi.intensity = 0.5 * surround.light;
    // at night the machine's lamp does the work
    lamp.intensity = look.surround === 'night' ? 3.2 : 0;
    dirty = true;
  }

  function placeBackground(): void {
    if (!surround) return;
    scene.background = overlay ? null : surround.background;
    scene.backgroundBlurriness = surround.background && !surround.backdrop && look.surround !== 'picture' ? 0.06 : 0;
    if (surround.backdrop && surround.background && host) cover(surround.background, host.clientWidth / Math.max(1, host.clientHeight));
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dropping = false;
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f) void look.usePicture(f);
    else look.error = 'Drop a picture (JPEG, PNG or WebP).';
  }

  // ---- the toolpath over the camera picture ----
  const overlay = $derived(cam.view === 'overlay' && cam.running && cam.ready);
  const camView = new THREE.PerspectiveCamera();
  camView.matrixAutoUpdate = false;
  let outline: THREE.Object3D | null = null;
  const bg = (() => {
    // the picture without lens distortion: for each pixel of the ideal image, where the lens put it
    const mat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: null as THREE.Texture | null }, size: { value: new THREE.Vector2(1, 1) }, k: { value: new THREE.Vector4(1, 1, 0, 0) }, d: { value: [0, 0, 0, 0, 0] } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        varying vec2 vUv; uniform sampler2D tex; uniform vec2 size; uniform vec4 k; uniform float d[5];
        void main() {
          // OpenCV pixel coordinates (centres at whole numbers)
          vec2 p = vec2(vUv.x * size.x - 0.5, (1.0 - vUv.y) * size.y - 0.5);
          vec2 x = (p - k.zw) / k.xy;
          float r2 = dot(x, x);
          float radial = 1.0 + d[0] * r2 + d[1] * r2 * r2 + d[4] * r2 * r2 * r2;
          vec2 xd = x * radial + vec2(2.0 * d[2] * x.x * x.y + d[3] * (r2 + 2.0 * x.x * x.x), d[2] * (r2 + 2.0 * x.y * x.y) + 2.0 * d[3] * x.x * x.y);
          vec2 s = xd * k.xy + k.zw;
          vec4 c = texture2D(tex, vec2((s.x + 0.5) / size.x, 1.0 - (s.y + 0.5) / size.y));
          gl_FragColor = (s.x < 0.0 || s.y < 0.0 || s.x > size.x || s.y > size.y) ? vec4(0.006, 0.006, 0.006, 1.0) : vec4(c.rgb * 0.75, 1.0);
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    return { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat };
  })();

  let bgTexture: THREE.Texture | null = null;
  let camFrame = -1;
  let bgSource: HTMLVideoElement | HTMLCanvasElement | null = null;

  /** Point the overlay camera like the real one; returns the picture's rectangle in the canvas (CSS pixels). */
  function placeCamView(w: number, h: number): { x: number; y: number; w: number; h: number } | null {
    const { lens, pose } = cam.calib;
    const vw = cam.width;
    const vh = cam.height;
    const frame = cam.frame;
    if (!lens || !pose || !vw || !vh || !frame) return null;
    // the picture as a texture: a video updates itself, a canvas is uploaded each frame
    if (bgSource !== frame) {
      bgTexture?.dispose();
      bgTexture = frame instanceof HTMLVideoElement ? new THREE.VideoTexture(frame) : new THREE.CanvasTexture(frame);
      bgTexture.colorSpace = THREE.SRGBColorSpace;
      bgSource = frame;
      bg.mat.uniforms.tex!.value = bgTexture;
    }
    if (!(frame instanceof HTMLVideoElement)) bgTexture!.needsUpdate = true;
    const wco: [number, number, number] | null = pose.frame === 'machine' ? cam.wco() : [0, 0, 0];
    if (!wco) return null;
    // intrinsics for the stream's size (calibrated at lens.width × lens.height)
    const k = vw / lens.width;
    const L = { ...lens, width: vw, height: vh, fx: lens.fx * k, fy: lens.fy * k, cx: lens.cx * k, cy: lens.cy * k };
    camView.projectionMatrix.fromArray(glProjection(L, 5, 5000));
    camView.projectionMatrixInverse.copy(camView.projectionMatrix).invert();
    // scene → work → machine (plus the work offset) → camera
    const view = new THREE.Matrix4().fromArray(glView(pose)).multiply(new THREE.Matrix4().makeTranslation(wco[0], wco[1], wco[2])).multiply(sceneToWork(program.kind === 'lathe'));
    camView.matrix.copy(view).invert();
    camView.updateMatrixWorld(true);
    const u = bg.mat.uniforms;
    u.size!.value.set(vw, vh);
    u.k!.value.set(L.fx, L.fy, L.cx, L.cy);
    u.d!.value = lens.dist;
    const s = Math.min(w / vw, h / vh);
    return { x: (w - vw * s) / 2, y: (h - vh * s) / 2, w: vw * s, h: vh * s };
  }

  function dispose(o: THREE.Object3D | null): void {
    if (!o) return;
    world.remove(o);
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mm of mats) if (!mm.userData.keep) mm.dispose();
    });
  }

  function buildPath(): void {
    dispose(doneLines);
    dispose(todoLines);
    path = pathGeometry(program, selected);
    doneLines = new THREE.LineSegments(path.geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
    todoLines = new THREE.LineSegments(path.geometry.clone(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22 }));
    world.add(todoLines, doneLines);
    tips = [];
    moves = [];
    ends = [];
    way = null;
    between = null;
    let time = 0;
    const rapid = Math.max(1, job.machine.rapidRate);
    for (const w of walk(program)) {
      const seg = program.segments[w.seg]!;
      tips.push({ p: w.move.to, tool: seg.tool, cut: w.move.type !== 'rapid' && (engaged(w.move.to, seg.tool) || engaged(w.from, seg.tool)), rpm: seg.rpm });
      moves.push({ from: w.from, move: w.move });
      const f = w.move.type === 'rapid' ? rapid : w.move.f;
      time += f > 0 ? (moveLength(w.from, w.move) / f) * 60 : 0;
      ends.push(time);
    }
    total = tips.length;
    runtime = time;
    if (followEnd || at > total) at = total;
    clock = at > 0 ? ends[at - 1]! : 0;
  }

  /** The whole program's time, seconds. */
  const duration = (): number => ends.at(-1) ?? 0;

  /** The move under way `s` seconds into the program: the first that ends after it (moves.length past the end). */
  function moveAt(s: number): number {
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid]! <= s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Move i's points, as the checks sample them (the material's own step: what is cut is what simulate would cut). */
  function wayOf(i: number): { pts: Vec3[]; cum: number[] } {
    if (way?.i === i) return way;
    const { from, move } = moves[i]!;
    const step = material instanceof MillMaterial ? Math.max(0.1, material.cell * 0.5) : material instanceof LatheMaterial ? 0.1 : 0.5;
    const pts = [from, ...samplePath(from, move, step)];
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1]! + Math.hypot(pts[k]!.x - pts[k - 1]!.x, pts[k]!.y - pts[k - 1]!.y, pts[k]!.z - pts[k - 1]!.z));
    way = { i, pts, cum };
    return way;
  }

  /** The point `d` mm along a way, and the index of the first point beyond it. */
  function along(w: { pts: Vec3[]; cum: number[] }, d: number): { p: Vec3; k: number } {
    let k = 1;
    while (k < w.cum.length - 1 && w.cum[k]! < d) k++;
    const a = w.pts[k - 1]!;
    const b = w.pts[k] ?? a;
    const l = (w.cum[k] ?? 0) - w.cum[k - 1]!;
    const u = l > 0 ? Math.min(1, Math.max(0, (d - w.cum[k - 1]!) / l)) : 1;
    return { p: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u }, k };
  }

  /** How far through move i the program is `s` seconds in, 0…1. */
  function fraction(i: number, s: number): number {
    const start = i > 0 ? ends[i - 1]! : 0;
    const span = ends[i]! - start;
    return span > 0 ? Math.min(1, Math.max(0, (s - start) / span)) : 1;
  }

  /** Where the tool is `s` seconds into the program: the moves done, and the place along the next one. */
  function seek(s: number): void {
    const i = moveAt(s);
    at = i;
    between = null;
    if (i >= ends.length) return;
    const w = wayOf(i);
    between = along(w, fraction(i, s) * w.cum.at(-1)!).p;
  }

  /** Cut the part on, from where it was cut to, to `s` seconds into the program: the tool's way, as the checks cut it. */
  function cutOn(s: number): void {
    if (!material || s <= cutClock) return;
    for (let i = moveAt(cutClock); i < moves.length; i++) {
      const move = moves[i]!.move;
      // a thread is a groove too shallow to change the outline the material keeps (as in simulate)
      const tool = move.type === 'thread' ? undefined : job.tools.find((t) => t.id === tips[i]!.tool);
      const u0 = fraction(i, cutClock);
      const u1 = fraction(i, s);
      if (tool && u1 > u0) {
        const w = wayOf(i);
        const len = w.cum.at(-1)!;
        const a = along(w, u0 * len);
        const b = along(w, u1 * len);
        const pts = [a.p];
        for (let k = a.k; k < w.pts.length && w.cum[k]! < u1 * len; k++) pts.push(w.pts[k]!);
        pts.push(b.p);
        if (material instanceof MillMaterial) material.cutPath(pts, tool as Tool);
        else for (let k = 1; k < pts.length; k++) material.cut(pts[k - 1]!, pts[k]!, tool as Tool);
        meshDue = true;
      }
      if (ends[i]! >= s) break;
    }
    cutClock = s;
  }

  /** The move the tool is on or has just finished: what it cuts with and how fast it turns. */
  const current = () => (between && at < total ? tips[at] : at > 0 ? tips[at - 1] : null) ?? null;

  /** The part as the program leaves it after `at` moves (and, while playing, cut on to where the tool is). */
  function buildPart(): void {
    material = simulate(job, program, at, { walls: true }).material;
    way = null; // sampled at the new material's step
    cutClock = at > 0 ? ends[at - 1]! : 0;
    if (playing) cutOn(clock);
    meshPart();
  }

  /** The part's mesh, from the material as it is cut now. */
  function meshPart(): void {
    dirty = true;
    meshDue = false;
    meshAt = performance.now();
    dispose(part);
    const metal = METAL[job.workMaterial] ?? METAL.aluminium!;
    if (material instanceof LatheMaterial) part = latheMesh(material, metal, job.stock.kind === 'bar' ? job.stock.diameter / 2 : Infinity);
    else if (material instanceof MillMaterial) part = millMesh(material, metal);
    else part = null;
    // the part is rebuilt at every step of the program: one material for all of them (a new one
    // each time would have its shader compiled again each time)
    part?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (!mesh.isMesh || !mat?.isMeshStandardMaterial) return;
      const key = `${job.workMaterial}:${mat.flatShading}`;
      let kept = partMaterials.get(key);
      if (!kept) {
        kept = mat;
        kept.userData.keep = true;
        partMaterials.set(key, kept);
      } else mat.dispose();
      mesh.material = kept;
    });
    setGround();
    if (part) {
      part.visible = !overlay;
      world.add(part);
    }
  }

  function buildFixture(): void {
    dispose(fixture);
    dispose(stage);
    fixture = null;
    stage = null;
    const s = job.stock;
    if (s.kind === 'block') {
      const g = new THREE.Group();
      const lines = drawingLines(job);
      const obs = obstacleMeshes(job);
      if (lines) g.add(lines);
      if (obs) g.add(obs);
      fixture = g;
      world.add(fixture);
      stage = tableMesh(s.x, s.y, s.top - s.z);
    } else if (s.kind === 'bar') {
      const d = job.machine.chuckDiameter ?? s.diameter * 2.5;
      const chuck = chuckGroup(s.front - s.stickout, d, s.diameter);
      fixture = chuck;
      world.add(chuck);
      stage = bedMesh(s.front - s.stickout - Math.max(20, d * 0.35) - 10, s.front + 60, -Math.max(s.diameter * 1.1, d / 2 + 12), Math.max(60, s.diameter * 2.4));
    }
    if (stage) {
      stage.visible = !overlay;
      world.add(stage);
    }
    chips.clear();
    coolant.clear();
    setGround();
  }

  function placeTool(): void {
    const lathe = program.kind === 'lathe';
    const t = current();
    const p = between ?? (at > 0 ? tips[at - 1]!.p : program.home);
    const id = t?.tool ?? program.segments[0]?.tool ?? 0;
    const spec = job.tools.find((x) => x.id === id);
    const d = spec?.diameter ?? 6;
    const key = `${lathe}:${spec?.type}:${d}:${spec?.angle}:${look.coolant}`;
    if (key !== toolKey) {
      dispose(tool);
      const made: THREE.Object3D = lathe ? latheToolMesh() : millToolMesh(spec?.type === 'drill' || spec?.type === 'chamfer' || spec?.type === 'threadmill' ? spec.type : 'endmill', d, spec?.fluteLength, spec?.flutes ?? 3, spec?.angle ?? 90);
      // the coolant hose comes down beside the cutter and looks at its tip
      nozzle = null;
      if (look.coolant) {
        const size = Math.max(1.6, Math.min(3.2, d * 0.35));
        const top = (made.userData.top as number | undefined) ?? 30;
        nozzle = lathe ? nozzleMesh(new THREE.Vector3(26, 44, 6), new THREE.Vector3(12, 16, 3), size) : nozzleMesh(new THREE.Vector3(-d - 13, top * 0.85, d + 9), new THREE.Vector3(-d * 0.8 - 7, Math.max(9, d * 1.7), d * 0.6 + 5), size);
        made.add(nozzle);
      }
      tool = made;
      world.add(made);
      toolKey = key;
    }
    tool!.position.copy(toScene(live ?? p, lathe));
  }

  function updateRange(): void {
    if (!path || !doneLines || !todoLines) return;
    const end = at > 0 ? path.vertexEnd[at - 1]! : 0;
    const n = path.vertexEnd.at(-1) ?? 0;
    doneLines.geometry.setDrawRange(0, end);
    todoLines.geometry.setDrawRange(end, n - end);
  }

  // ---- the viewpoint: presets, and the one the user left it at (kept per kind of machine) ----
  type ViewName = '3d' | 'top' | 'front' | 'side';
  const VIEW_KEY = 'swarf.view';
  /** Where the eye is from the target, and the target from the work's centre, both in units of the work's size. */
  type SavedView = { d: [number, number, number]; t: [number, number, number] };
  const savedViews: Record<string, SavedView> = (() => {
    try {
      return JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Record<string, SavedView>;
    } catch {
      return {};
    }
  })();
  let viewMoved = false;
  /** The page goes away while the view still glides: keep it as it is now. */
  const leaving = () => {
    if (viewMoved) rememberView();
  };
  const fitCenter = new THREE.Vector3();
  let fitSize = 1;
  function keepViews(): void {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(savedViews));
    } catch {
      // not kept
    }
  }
  /** Remember where the user turned the view to. */
  function rememberView(): void {
    if (overlay || !fitSize) return;
    const d = camera.position.clone().sub(controls.target).divideScalar(fitSize);
    const t = controls.target.clone().sub(fitCenter).divideScalar(fitSize);
    if (![...d.toArray(), ...t.toArray()].every(Number.isFinite)) return;
    savedViews[program.kind] = { d: d.toArray() as [number, number, number], t: t.toArray() as [number, number, number] };
    keepViews();
  }
  /** A preset: from above, from the front (where the operator stands), from the side (the mill's right; the lathe's tailstock end), or the usual three-quarter view. */
  function view(name: ViewName): void {
    delete savedViews[program.kind];
    fit(true, name);
    if (name !== '3d') rememberView();
    else keepViews();
  }

  /**
   * Frame the work. Without `name`: the view the user left (if any), else the three-quarter view;
   * only when the stock changed, unless `force`.
   */
  function fit(force = false, name?: ViewName): void {
    const s = job.stock;
    const key = JSON.stringify(s) + program.kind;
    if (!force && key === fitKey) return;
    fitKey = key;
    let center: THREE.Vector3;
    let size: number;
    let dir: THREE.Vector3;
    if (s.kind === 'bar') {
      center = new THREE.Vector3(s.front - s.stickout / 2, 0, 0);
      size = Math.max(s.stickout * 1.25, s.diameter * 2);
      // from the operator's side and above: the tool comes in from the front, the cuts lie level
      dir = new THREE.Vector3(0.3, 0.85, 1);
    } else {
      center = new THREE.Vector3(s.x / 2, s.top - s.z / 2, -s.y / 2);
      size = Math.max(s.x, s.y, s.z) * 1.15;
      dir = new THREE.Vector3(0.35, 0.95, 1);
    }
    // (straight down needs a hair of tilt, or the view has no "up")
    if (name === 'top') dir = new THREE.Vector3(0, 1, 0.0005);
    else if (name === 'front') dir = new THREE.Vector3(0, 0, 1);
    else if (name === 'side') dir = new THREE.Vector3(1, 0, 0);
    fitCenter.copy(center);
    fitSize = size;
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (size / 2 / Math.tan(fov / 2)) * Math.max(1, 1.15 / Math.max(camera.aspect, 0.3));
    const kept = name ? undefined : savedViews[program.kind];
    if (kept) {
      controls.target.copy(center).add(new THREE.Vector3(...kept.t).multiplyScalar(size));
      camera.position.copy(controls.target).add(new THREE.Vector3(...kept.d).multiplyScalar(size));
    } else {
      camera.position.copy(center).addScaledVector(dir.normalize(), dist);
      controls.target.copy(center);
    }
    camera.near = size / 200;
    camera.far = size * 50;
    // zoom no further out than the work stays in sight, nor in closer than its finest detail: out
    // past that it vanishes, and coming back takes as long as going out did
    controls.minDistance = size * 0.05;
    controls.maxDistance = size * 8;
    camera.updateProjectionMatrix();
    controls.update();
    if (keyLight) {
      // the light looks at the work; its shadow covers the work and the table around it
      keyLight.target.position.copy(center);
      keyLight.position.copy(center).add(new THREE.Vector3(0.45, 1, 0.6).multiplyScalar(size * 2.5));
      const c = keyLight.shadow.camera;
      c.left = c.bottom = -size * 1.3;
      c.right = c.top = size * 1.3;
      c.near = size * 0.5;
      c.far = size * 6;
      c.updateProjectionMatrix();
    }
    dirty = true;
  }

  let simTimer = 0;
  function refreshPart(): void {
    clearTimeout(simTimer);
    simTimer = window.setTimeout(buildPart, 30);
  }

  /** Chips, coolant, the turning of the cutter and the chuck, the sound: `dt` seconds on. */
  function effects(dt: number): void {
    const lathe = program.kind === 'lathe';
    const t = current();
    // the simulated run, or the machine itself
    const rpm = live ? spindle : playing && t ? t.rpm : 0;
    const tip = tool ? tool.position : lastTip;
    const moved = haveTip && tip.distanceToSquared(lastTip) > 1e-8;
    const cutting = !overlay && rpm > 0 && moved && (live ? engaged(live, t?.tool ?? 0) : !!t?.cut);
    if (rpm > 0 && !overlay) {
      const turn = dt * Math.min(40, Math.max(8, rpm / 150));
      const spin = (lathe ? fixture : tool)?.userData.spin as THREE.Object3D | undefined;
      if (spin) {
        if (lathe) spin.rotation.x -= turn;
        else spin.rotation.y -= turn;
      }
      dirty = true;
    }
    if (cutting && look.chips) {
      const d = job.tools.find((x) => x.id === (t?.tool ?? 0))?.diameter ?? 6;
      const away = new THREE.Vector3();
      if (lathe) away.set(0.35, 0.5, 0.8).normalize();
      else {
        // behind the cutter and to the side its edge moves away on
        const f = tip.clone().sub(lastTip).setY(0);
        if (f.lengthSq() < 1e-10) f.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        f.normalize();
        away.set(-f.x * 0.6 - f.z * 0.8, 0.3, -f.z * 0.6 + f.x * 0.8).normalize();
      }
      chips.emit(CHIPS[job.workMaterial] ?? CHIPS.aluminium!, lastTip, tip, away, lathe ? Math.max(4, d ?? 6) : d, dt);
    }
    if (look.coolant && rpm > 0 && !overlay && nozzle && tool) {
      const mouth = (nozzle.userData.mouth as THREE.Vector3).clone().add(tool.position);
      const d = job.tools.find((x) => x.id === (t?.tool ?? 0))?.diameter ?? 6;
      const target = lathe ? tip.clone().add(new THREE.Vector3(0.5, 0.5, 0)) : tip.clone().add(new THREE.Vector3(-d * 0.3, d * 0.5, d * 0.2));
      const width = Math.max(0.9, Math.min(1.6, d * 0.2));
      coolant.emit(mouth, target, width, dt);
      // the stream itself, wavering a little
      const dir = target.clone().sub(mouth);
      jet.position.copy(mouth);
      jet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      const wob = 1 + 0.12 * Math.sin(performance.now() / 45);
      jet.scale.set(width * 0.55 * wob, dir.length(), width * 0.55 / wob);
      jet.visible = true;
    } else jet.visible = false;
    // the lamp follows the spindle
    if (tool && lamp.intensity > 0) {
      const size = job.stock.kind === 'block' ? Math.max(job.stock.x, job.stock.y) : job.stock.kind === 'bar' ? job.stock.stickout : 100;
      lamp.position.copy(tool.position).add(new THREE.Vector3(-size * 0.35, size * 0.9, size * 0.5));
      lamp.target.position.copy(tool.position);
    }
    chips.mesh.visible = coolant.mesh.visible = !overlay;
    if (chips.update(dt)) dirty = true;
    if (coolant.update(dt)) dirty = true;
    if (look.sound) sound.set(overlay ? 0 : rpm, cutting ? 1 : 0);
    lastTip.copy(tip);
    haveTip = !!tool;
  }

  function frame(now = 0): void {
    raf = requestAnimationFrame(frame);
    // (real time, also when frames come slowly: what flies must land and fade in its seconds, not its frames)
    const dt = Math.min(0.12, lastTime ? (now - lastTime) / 1000 : 0.016);
    lastTime = now;
    if (playing) {
      if (at >= total) {
        playing = false;
        between = null;
      } else {
        // quick: the whole program in about ten seconds; else times its own time
        const rate = look.speed === 0 ? duration() / 10 : look.speed;
        clock = Math.min(duration(), clock + dt * rate);
        seek(clock);
        if (clock >= duration()) {
          at = total;
          between = null;
        }
        followEnd = at >= total;
        dirty = true;
        updateRange();
        placeTool();
        // the part is cut along with the tool, its mesh made again a few times a second
        clearTimeout(simTimer);
        cutOn(clock);
        if (meshDue && (now - meshAt > 90 || at >= total)) meshPart();
      }
    }
    effects(dt);
    // render only when something changed: software GL (and laptops) thank us
    if (overlay && renderer) {
      // draw on a new camera picture, or when the scene changed
      const n = cam.newFrame(camFrame);
      if (n === camFrame && !dirty) return;
      camFrame = n;
      dirty = false;
      const w = host.clientWidth;
      const h = host.clientHeight;
      const rect = placeCamView(w, h);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      renderer.setClearColor(0x111111, 1);
      renderer.clear();
      if (rect) {
        const y = h - rect.y - rect.h;
        renderer.setViewport(rect.x, y, rect.w, rect.h);
        renderer.setScissor(rect.x, y, rect.w, rect.h);
        renderer.setScissorTest(true);
        renderer.autoClear = false;
        renderer.render(bg.scene, bg.camera);
        renderer.clearDepth();
        renderer.render(scene, camView);
        renderer.autoClear = true;
        renderer.setScissorTest(false);
      }
      renderer.setClearColor(0x000000, 0);
      return;
    }
    const moved = controls.update();
    if (!moved && viewMoved) {
      viewMoved = false;
      rememberView();
    }
    if (moved || dirty) {
      dirty = false;
      renderer?.setViewport(0, 0, host.clientWidth, host.clientHeight);
      renderer?.render(scene, camera);
    }
  }

  function onScrub(): void {
    dirty = true;
    if (!playing) {
      between = null;
      clock = at > 0 ? ends[at - 1]! : 0;
    }
    followEnd = at >= total;
    updateRange();
    placeTool();
    refreshPart();
  }

  function play(): void {
    if (at >= total) {
      at = 0;
      clock = 0;
      between = null;
      updateRange();
      placeTool();
      clearTimeout(simTimer);
      buildPart();
    }
    playing = !playing;
  }

  /** m:ss (h:mm:ss from an hour). */
  function clockText(s: number): string {
    const t = Math.round(s);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  onMount(() => {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    // drawn in software (no graphics card to speak of): shadows cost too much there unless asked for
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const software = /swiftshader|llvmpipe|software/i.test(String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ''));
    if (software && !look.asked) {
      look.shadows = false;
      look.chips = false;
    }
    renderer.shadowMap.enabled = look.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    world.add(chips.mesh, coolant.mesh, jet);
    scene.add(lamp, lamp.target);
    host.appendChild(renderer.domElement);
    camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    // kept once the view has come to rest (it glides on a little): not at every turn of the wheel
    // (a trackpad sends a hundred a second, and more as it coasts on)
    controls.addEventListener('end', () => {
      viewMoved = true;
    });
    // the wheel zooms at once, in its own event (controls.update() in the frame then sees nothing
    // left to do): draw whenever the view changed, however it changed
    controls.addEventListener('change', () => {
      dirty = true;
    });
    window.addEventListener('pagehide', leaving);

    // most of the light comes from the surroundings (what the metal reflects); a key light for the shadows
    hemi = new THREE.HemisphereLight(0xe8eee9, 0x30383a, 0.5);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(80, 140, 120);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.6;
    scene.add(key, key.target);
    keyLight = key;
    applySurround();
    const rim = new THREE.DirectionalLight(0xbcd2ff, 0.8);
    rim.position.set(-120, 40, -80);
    scene.add(rim);

    resize = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer!.setSize(w, h, false);
      const first = camera.aspect === 1 && w !== h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      placeBackground();
      if (first) fit(true);
      dirty = true;
    });
    resize.observe(host);
    frame();
    mounted = true;
  });

  onDestroy(() => {
    cancelAnimationFrame(raf);
    clearTimeout(simTimer);
    resize?.disconnect();
    window.removeEventListener('pagehide', leaving);
    controls?.dispose();
    surround?.dispose();
    sound.stop();
    renderer?.dispose();
  });

  // rebuild when the program, job or selection changes
  $effect(() => {
    void program;
    void selected;
    void job;
    if (!mounted) return;
    untrack(() => {
      // a different job (new stock): show it finished, not at the old scrub position
      if (JSON.stringify(job.stock) + program.kind !== fitKey) followEnd = true;
      dirty = true;
      buildPath();
      buildFixture();
      toolKey = '';
      updateRange();
      placeTool();
      buildPart();
      fit();
    });
  });

  // follow the machine
  $effect(() => {
    const at = live ? `${live.x},${live.y},${live.z}` : '';
    if (!mounted) return;
    untrack(() => {
      // (a status report with the machine where it was is nothing to draw again)
      if (at === liveAt) return;
      liveAt = at;
      placeTool();
      dirty = true;
    });
  });

  // the laser scan's points, coloured by height (blue low, red high)
  let cloud: THREE.Points | null = null;
  $effect(() => {
    const pts = laserScan.cloud;
    if (!mounted) return;
    untrack(() => {
      dispose(cloud);
      cloud = null;
      if (pts?.length && job.stock.kind === 'block') {
        const pos = new Float32Array(pts.length * 3);
        const col = new Float32Array(pts.length * 3);
        const lo = job.stock.top - job.stock.z;
        const hi = job.stock.top + 10;
        const c = new THREE.Color();
        pts.forEach((p, i) => {
          const s = toScene({ x: p[0], y: p[1], z: p[2] }, false);
          pos.set([s.x, s.y, s.z], i * 3);
          c.setHSL(0.66 * (1 - Math.min(1, Math.max(0, (p[2] - lo) / (hi - lo)))), 0.85, 0.55);
          col.set([c.r, c.g, c.b], i * 3);
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        cloud = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true }));
        world.add(cloud);
      }
      dirty = true;
    });
  });

  // the overlay: the part as a ghost would hide the real stock, so its outline and the work zero instead
  $effect(() => {
    const on = overlay;
    void job;
    if (!mounted) return;
    untrack(() => {
      dispose(outline);
      outline = null;
      if (on) {
        outline = stockOutline(job);
        world.add(outline);
      }
      if (part) part.visible = !on;
      // the chuck would hide the real one; drawings and obstacles stay (the obstacles are worth comparing)
      if (fixture) fixture.visible = !on || job.stock.kind === 'block';
      if (stage) stage.visible = !on;
      placeBackground();
      controls.enabled = !on;
      dirty = true;
    });
  });

  // the look: surroundings, shadows, the hose, the sound
  $effect(() => {
    void look.surround;
    void look.picture;
    void look.soften;
    if (!mounted) return;
    untrack(applySurround);
  });
  $effect(() => {
    const on = look.shadows;
    void look.coolant;
    void look.chips;
    if (!mounted) return;
    untrack(() => {
      if (renderer) renderer.shadowMap.enabled = on;
      if (keyLight) keyLight.castShadow = on;
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        for (const x of Array.isArray(m) ? m : m ? [m] : []) x.needsUpdate = true;
      });
      if (!look.chips) chips.clear();
      if (!look.coolant) coolant.clear();
      toolKey = '';
      placeTool();
      dirty = true;
    });
  });
  $effect(() => {
    if (look.sound) sound.start();
    else sound.stop();
  });

</script>

<div
  class="viewer"
  class:pictured={look.surround !== 'plain' && !overlay}
  role="application"
  aria-label="3D preview"
  ondragover={(e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dropping = true; } }}
  ondragleave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) dropping = false; }}
  ondrop={onDrop}
>
  <div class="canvas" bind:this={host}></div>
  {#if dropping}<div class="drop"><b>Drop a picture of your workshop</b><span>It becomes the surroundings, and what the metal reflects. A 360° panorama surrounds the machine; any other picture stands behind it.</span></div>{/if}
  <div class="legend" aria-hidden="true">
    <span><i class="sw feed"></i>cutting</span>
    <span><i class="sw rapid"></i>rapid</span>
  </div>
  {#if !overlay}
    <div class="tools">
      <button class="fit" onclick={() => (menu = !menu)} aria-expanded={menu}>Look</button>
      <div class="views" role="group" aria-label="Viewpoint">
        <button class="fit" onclick={() => view('3d')} title="The usual three-quarter view (and forget the one you left)">3D</button>
        <button class="fit" onclick={() => view('top')} title="From above">Top</button>
        <button class="fit" onclick={() => view('front')} title="From the front, where you stand">Front</button>
        <button class="fit" onclick={() => view('side')} title={program.kind === 'lathe' ? 'From the tailstock end, along the spindle' : 'From the right'}>{program.kind === 'lathe' ? 'End' : 'Side'}</button>
      </div>
    </div>
    {#if menu}
      <div class="look" role="dialog" aria-label="How the preview looks">
        <div class="lbl">Surroundings</div>
        <div class="chips">
          {#each SURROUNDS as s (s.name)}
            {#if s.name !== 'picture' || look.picture}
              <button class:on={look.surround === s.name} onclick={() => { look.surround = s.name; look.save(); }}>{s.label}</button>
            {/if}
          {/each}
        </div>
        <p>Drop a picture of your own workshop onto the preview, or <button class="lnk" onclick={() => fileInput?.click()}>choose one</button>.{#if look.picture} <button class="lnk" onclick={() => look.removePicture()}>Remove it</button>{/if}</p>
        <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void look.usePicture(f); e.currentTarget.value = ''; }} />
        {#if look.surround === 'picture'}<label><input type="checkbox" bind:checked={look.soften} onchange={() => look.save()} /> Soften the picture a little</label>{/if}
        {#if look.error}<p class="err">{look.error}</p>{/if}
        <div class="lbl">While it cuts</div>
        <label><input type="checkbox" bind:checked={look.chips} onchange={() => { look.asked = true; look.save(); }} /> Chips</label>
        <label><input type="checkbox" bind:checked={look.coolant} onchange={() => look.save()} /> Coolant</label>
        <label><input type="checkbox" bind:checked={look.sound} /> Sound</label>
        <div class="lbl">Light</div>
        <label><input type="checkbox" bind:checked={look.shadows} onchange={() => { look.asked = true; look.save(); }} /> Shadows</label>
        <p class="dim">Press play to see it cut. None of this changes the checks or the G-code.</p>
      </div>
    {/if}
  {/if}
  <div class="scrub">
    <button class="play" onclick={play} aria-label={playing ? 'Pause' : 'Play the program'}>
      {#if playing}
        <svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
      {:else}
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 2.5v11l9.5-5.5z" /></svg>
      {/if}
    </button>
    <input type="range" min="0" max={total} bind:value={at} oninput={() => { playing = false; onScrub(); }} aria-label="Program position" />
    <span class="pos">{clockText(clock)} / {clockText(runtime)} · {at} / {total} moves</span>
    <select class="speed" bind:value={look.speed} onchange={() => look.save()} aria-label="Playing speed" title="How fast Play goes">
      {#each SPEEDS as s (s)}<option value={s}>{s === 0 ? 'Quick (10 s)' : s === 1 ? 'Real time' : `${s}×`}</option>{/each}
    </select>
  </div>
</div>

<style>
  .viewer { position: relative; flex: 1; min-height: 0; background: radial-gradient(120% 90% at 50% 20%, var(--iron-2), var(--iron)); }
  .canvas { position: absolute; inset: 0; }
  .canvas :global(canvas) { display: block; width: 100%; height: 100%; }
  .legend { position: absolute; left: 14px; top: 12px; display: flex; gap: 14px; font-size: 12px; color: var(--on-iron-2); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .sw { width: 16px; height: 0; border-top: 2px solid; display: inline-block; }
  .sw.feed { border-color: #6fb2e8; }
  .sw.rapid { border-color: #ef8a4c; }
  .tools { position: absolute; right: 12px; top: 10px; display: flex; gap: 6px; }
  .fit { background: rgba(255, 255, 255, 0.06); color: var(--on-iron); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 6px; padding: 4px 10px; font-size: 12px; }
  .fit:hover { background: rgba(255, 255, 255, 0.12); }
  .views { display: flex; }
  .views .fit { border-radius: 0; margin-left: -1px; padding: 4px 8px; }
  .views .fit:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
  .views .fit:last-child { border-radius: 0 6px 6px 0; }
  /* over a picture: the controls on a dark glass so they stay readable */
  .pictured .fit, .pictured .legend { background: rgba(20, 22, 24, 0.62); color: #f1f3f4; }
  .pictured .legend { padding: 4px 9px; border-radius: 6px; }
  .look { position: absolute; right: 12px; top: 44px; width: 250px; padding: 12px 14px; border-radius: 10px; background: rgba(22, 25, 27, 0.94); color: #eef0f1; font-size: 12.5px; border: 1px solid rgba(255, 255, 255, 0.14); display: flex; flex-direction: column; gap: 5px; z-index: 3; }
  .look .lbl { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #a9b0b4; margin-top: 6px; }
  .look .lbl:first-child { margin-top: 0; }
  .look .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .look .chips button { border: 1px solid rgba(255, 255, 255, 0.18); background: transparent; color: inherit; border-radius: 14px; padding: 3px 10px; font-size: 12px; }
  .look .chips button.on { background: var(--accent); border-color: var(--accent); color: #1c1a10; font-weight: 600; }
  .look p { margin: 2px 0; color: #c9ced1; line-height: 1.35; }
  .look p.dim { color: #8f979b; margin-top: 6px; }
  .look p.err { color: #ffb4a8; }
  .look label { display: flex; align-items: center; gap: 7px; }
  .look .lnk { border: 0; background: none; padding: 0; color: #f2d16b; text-decoration: underline; font-size: inherit; cursor: pointer; }
  .drop { position: absolute; inset: 10px; border: 2px dashed #f2d16b; border-radius: 14px; background: rgba(20, 22, 24, 0.72); color: #fff; display: grid; place-content: center; text-align: center; gap: 8px; padding: 24px; z-index: 4; pointer-events: none; }
  .drop b { font-size: 18px; }
  .drop span { max-width: 420px; color: #d5d9dc; font-size: 13px; }
  .scrub { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: linear-gradient(transparent, rgba(0, 0, 0, 0.35)); color: var(--on-iron); }
  .scrub input { flex: 1; accent-color: var(--accent); }
  .play { width: 32px; height: 32px; border-radius: 50%; border: 0; background: var(--accent); color: #1c1a10; display: grid; place-items: center; flex: none; }
  .play svg { fill: currentColor; }
  .speed { flex: none; font-size: 12px; padding: 4px 8px; border-radius: 6px; background: rgba(255, 255, 255, 0.06); color: var(--on-iron); border: 1px solid rgba(255, 255, 255, 0.14); color-scheme: dark; }
  .speed option { background: #1f2326; color: #eef0f1; }
  .pos { font-size: 12px; color: var(--on-iron-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  @media (max-width: 560px) { .pos { display: none; } }
</style>
