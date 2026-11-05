<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { LatheMaterial, MillMaterial, simulate, walk, type Job, type Program, type Vec3 } from '@swarf/cam';
  import { chuckMesh, latheMesh, millMesh, pathGeometry, toScene, toolMesh, type PathGeometry } from './scene.ts';

  let { job, program, selected = null }: { job: Job; program: Program; selected?: string | null } = $props();

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
  let tips: { p: Vec3; tool: number }[] = [];

  function dispose(o: THREE.Object3D | null): void {
    if (!o) return;
    world.remove(o);
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mm of mats) mm.dispose();
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
    for (const w of walk(program)) tips.push({ p: w.move.to, tool: program.segments[w.seg]!.tool });
    total = tips.length;
    if (followEnd || at > total) at = total;
  }

  function buildPart(): void {
    dirty = true;
    dispose(part);
    const { material } = simulate(job, program, at);
    if (material instanceof LatheMaterial) part = latheMesh(material);
    else if (material instanceof MillMaterial) part = millMesh(material);
    else part = null;
    if (part) world.add(part);
  }

  function buildFixture(): void {
    dispose(fixture);
    fixture = null;
    if (job.stock.kind === 'bar') {
      fixture = chuckMesh(job.stock.front - job.stock.stickout, job.machine.chuckDiameter ?? job.stock.diameter * 2.5);
      world.add(fixture);
    }
  }

  function placeTool(): void {
    const lathe = program.kind === 'lathe';
    const t = at > 0 ? tips[at - 1] : null;
    const p = t?.p ?? program.home;
    const id = t?.tool ?? program.segments[0]?.tool ?? 0;
    const spec = job.tools.find((x) => x.id === id);
    const key = `${lathe}:${spec?.diameter ?? 0}`;
    if (key !== toolKey) {
      dispose(tool);
      tool = toolMesh(lathe, spec?.diameter ?? 6);
      world.add(tool);
      toolKey = key;
    }
    tool!.position.copy(toScene(p, lathe));
  }

  function updateRange(): void {
    if (!path || !doneLines || !todoLines) return;
    const end = at > 0 ? path.vertexEnd[at - 1]! : 0;
    const n = path.vertexEnd.at(-1) ?? 0;
    doneLines.geometry.setDrawRange(0, end);
    todoLines.geometry.setDrawRange(end, n - end);
  }

  function fit(force = false): void {
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
      dir = new THREE.Vector3(0.25, 0.55, 1);
    } else {
      center = new THREE.Vector3(s.x / 2, s.top - s.z / 2, -s.y / 2);
      size = Math.max(s.x, s.y, s.z) * 1.15;
      dir = new THREE.Vector3(0.35, 0.95, 1);
    }
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (size / 2 / Math.tan(fov / 2)) * Math.max(1, 1.15 / Math.max(camera.aspect, 0.3));
    camera.position.copy(center).addScaledVector(dir.normalize(), dist);
    controls.target.copy(center);
    camera.near = size / 200;
    camera.far = size * 50;
    camera.updateProjectionMatrix();
    controls.update();
    dirty = true;
  }

  let simTimer = 0;
  function refreshPart(): void {
    clearTimeout(simTimer);
    simTimer = window.setTimeout(buildPart, 30);
  }

  function frame(): void {
    raf = requestAnimationFrame(frame);
    if (playing) {
      if (at >= total) playing = false;
      else {
        at = Math.min(total, at + Math.max(1, Math.round(total / 600)));
        onScrub();
      }
    }
    // render only when something changed: software GL (and laptops) thank us
    const moved = controls.update();
    if (moved || dirty) {
      dirty = false;
      renderer?.render(scene, camera);
    }
  }

  function onScrub(): void {
    dirty = true;
    followEnd = at >= total;
    updateRange();
    placeTool();
    refreshPart();
  }

  function play(): void {
    if (at >= total) at = 0;
    playing = !playing;
  }

  onMount(() => {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    host.appendChild(renderer.domElement);
    camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;

    scene.add(new THREE.HemisphereLight(0xe8eee9, 0x30383a, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(80, 140, 120);
    scene.add(key);
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
    controls?.dispose();
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

  const pct = $derived(total ? Math.round((at / total) * 100) : 0);
</script>

<div class="viewer">
  <div class="canvas" bind:this={host}></div>
  <div class="legend" aria-hidden="true">
    <span><i class="sw feed"></i>cutting</span>
    <span><i class="sw rapid"></i>rapid</span>
  </div>
  <button class="fit" onclick={() => fit(true)} title="Reset the view">Reset view</button>
  <div class="scrub">
    <button class="play" onclick={play} aria-label={playing ? 'Pause' : 'Play the program'}>
      {#if playing}
        <svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
      {:else}
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 2.5v11l9.5-5.5z" /></svg>
      {/if}
    </button>
    <input type="range" min="0" max={total} bind:value={at} oninput={() => { playing = false; onScrub(); }} aria-label="Program position" />
    <span class="pos">{at} / {total} moves · {pct}%</span>
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
  .fit { position: absolute; right: 12px; top: 10px; background: rgba(255, 255, 255, 0.06); color: var(--on-iron); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 6px; padding: 4px 10px; font-size: 12px; }
  .fit:hover { background: rgba(255, 255, 255, 0.12); }
  .scrub { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: linear-gradient(transparent, rgba(0, 0, 0, 0.35)); color: var(--on-iron); }
  .scrub input { flex: 1; accent-color: var(--accent); }
  .play { width: 32px; height: 32px; border-radius: 50%; border: 0; background: var(--accent); color: #1c1a10; display: grid; place-items: center; flex: none; }
  .play svg { fill: currentColor; }
  .pos { font-size: 12px; color: var(--on-iron-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  @media (max-width: 560px) { .pos { display: none; } }
</style>
