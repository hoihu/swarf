<script lang="ts">
  import { onMount } from 'svelte';
  import { BOARD, TABLE_MARKER, TOOL_MARKER, boardImage, markerImage } from './cv.ts';
  import { camera, SIM_SOURCE } from './camera.svelte.ts';
  import { machine } from '../machine.svelte.ts';
  import { store } from '../store.svelte.ts';

  const lathe = $derived(store.job.machine.kind === 'lathe');
  const lens = $derived(camera.calib.lens);
  const pose = $derived(camera.calib.pose?.kind === store.job.machine.kind ? camera.calib.pose : undefined);
  let method = $state<'machine' | 'marker'>('machine');
  let span = $state({ x: 40, y: 25, z: 30 });
  let markerAt = $state({ x: 20, y: 20, size: 40 });
  let problem = $state('');
  const stockNow = $derived(store.job.stock);
  /** How far off the measured block is, and whether it matters (camera precision is a few tenths). */
  const blockDiff = $derived.by(() => {
    const f = camera.block;
    const s = stockNow;
    if (!f || s.kind !== 'block') return null;
    return { dx: f.corner[0], dy: f.corner[1], sx: f.x - s.x, sy: f.y - s.y, angle: f.angle };
  });
  const off = (v: number, tol = 0.3) => Math.abs(v) > tol;
  const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;

  function useSize(): void {
    const f = camera.block;
    const s = store.job.stock;
    if (!f || s.kind !== 'block') return;
    store.set({ ...store.job, stock: { ...s, x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10 } });
  }
  const ENOUGH = 15;

  onMount(() => void camera.listSources());

  async function run(f: () => Promise<void>): Promise<void> {
    problem = '';
    try {
      await f();
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }

  /** The board and the markers at true size, for printing (A4 landscape, 100 %). */
  async function print(): Promise<void> {
    const cv = await camera.cv();
    const url = (img: ImageData) => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d')!.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    };
    const bw = BOARD.nx * BOARD.square;
    const board = url(boardImage(cv, 12));
    const tool = url(markerImage(cv, TOOL_MARKER, 400));
    const table = url(markerImage(cv, TABLE_MARKER, 600));
    const w = window.open('', '_blank');
    if (!w) {
      problem = 'The browser blocked the print window: allow pop-ups for this page.';
      return;
    }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>swarf camera calibration</title><style>
      @page { size: A4 landscape; margin: 12mm; }
      body { font: 11pt system-ui, sans-serif; margin: 0; color: #222; }
      .page { page-break-after: always; display: flex; flex-direction: column; align-items: center; gap: 4mm; }
      img { image-rendering: pixelated; display: block; }
      .row { display: flex; gap: 20mm; align-items: flex-end; }
      p { margin: 0; max-width: 250mm; }
    </style></head><body>
      <div class="page">
        <img src="${board}" style="width:${bw}mm">
        <p>Lens calibration board, ${BOARD.nx} × ${BOARD.ny} squares of ${BOARD.square} mm. Print at 100 % (no "fit to page"); glue it flat onto card or a board. Its exact size does not matter for the lens.</p>
      </div>
      <div class="page">
        <div class="row">
          <div><img src="${tool}" style="width:32mm"><p>Tool marker (${TOOL_MARKER})</p></div>
          <div><img src="${table}" style="width:${(markerAt.size * 8) / 6}mm"><p>Table marker (${TABLE_MARKER}), black square ${markerAt.size} mm<br>Top edge = this side up = +Y</p></div>
        </div>
        <p>Tool marker: stick it to the tool holder or spindle, facing the camera; it must not move against the tool while calibrating. Table marker (quick method, mill): measure its black square after printing.</p>
      </div>
      <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script>
    </body></html>`);
    w.document.close();
  }
</script>

<section class="camera">
  <h3>Camera</h3>
  <p class="muted small">A camera looking at the work area shows the toolpath drawn over the real picture: wrong work zero, clamps in the way or too little stock are seen before cutting.</p>

  <div class="row">
    <select value={camera.source} onchange={(e) => (camera.source = (e.currentTarget as HTMLSelectElement).value)} disabled={camera.running} aria-label="Camera">
      {#each camera.sources as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
    </select>
    {#if camera.running}
      <button class="btn" onclick={() => camera.stop()}>Stop</button>
    {:else}
      <button class="btn pri" onclick={() => run(() => camera.start())}>Start</button>
    {/if}
  </div>
  {#if camera.source === SIM_SOURCE}<p class="muted small">The simulated camera watches the simulated machine: connect it above to try the whole calibration without hardware.</p>{/if}
  {#if camera.status}<p class="muted small">{camera.status}</p>{/if}
  {#if camera.error}<p class="diag error">{camera.error}</p>{/if}

  {#if camera.running}
    <div class="views" role="group" aria-label="Show">
      <button class:on={camera.view === 'scene'} onclick={() => (camera.view = 'scene')}>3D</button>
      <button class:on={camera.view === 'camera'} onclick={() => (camera.view = 'camera')}>Camera</button>
      <button class:on={camera.view === 'overlay'} disabled={!camera.ready} onclick={() => (camera.view = 'overlay')}>Toolpath on camera</button>
    </div>

    <h4>1 · Lens <span class="muted small">{camera.width} × {camera.height}</span></h4>
    {#if lens && !camera.capturing}
      <p class="small">Calibrated from {lens.views} views: focal length {lens.fx.toFixed(0)} px, error {lens.rms.toFixed(2)} px{lens.rms > 1 ? ' (high: try again with the board flat and sharp)' : ''}.</p>
      <div class="row"><button class="btn" onclick={() => run(() => camera.startLens())}>Calibrate again</button><button class="link" onclick={() => camera.forget('lens')}>Forget</button></div>
    {:else if camera.capturing}
      <p class="small">Hold the board in front of the camera and move it: near and far, in every corner of the picture, tilted different ways. Views are kept as they come: <b>{camera.views.length}</b> of {ENOUGH}.</p>
      <div class="row">
        <button class="btn pri" disabled={camera.views.length < 8} onclick={() => run(() => camera.computeLens())}>Calibrate{camera.views.length < ENOUGH ? ` (${camera.views.length})` : ''}</button>
        <button class="btn" onclick={() => camera.stopLens()}>Cancel</button>
      </div>
    {:else}
      <p class="small">Print the board, then show it to the camera from many angles. Mount the camera firmly and lock its focus and zoom if it can: autofocus changes the lens, and the calibration with it.</p>
      <div class="row"><button class="btn" onclick={print}>Print board and markers</button><button class="btn pri" onclick={() => run(() => camera.startLens())}>Start</button></div>
    {/if}

    {#if lens}
      <h4>2 · Where the camera is</h4>
      {#if pose}
        <p class="small">
          {pose.method === 'machine' ? `Measured at ${pose.points} positions (marker error ${pose.rms.toFixed(2)} px, tool tip clicks ${pose.tipPx !== undefined ? pose.tipPx.toFixed(1) : '–'} px).` : `From the table marker (error ${pose.rms.toFixed(2)} px).`}
          {pose.frame === 'work' ? 'Relative to work zero: re-run it if you set a new work zero.' : 'In machine coordinates: it follows your work zero.'}
        </p>
        <div class="row"><button class="btn" onclick={() => camera.forget('pose')}>Measure again</button></div>

        {#if !lathe}
          <h4>3 · Check the setup</h4>
          <p class="small">Compares the block in the picture with the job: where its front-left corner is (the job's X0 Y0), its length and width, and whether it sits square. Needs Z zero on the block's top; the camera reads to a few tenths of a millimetre.</p>
          <div class="row"><button class="btn pri" onclick={() => run(async () => void (await camera.checkBlock()))}>Check the block</button></div>
          {#if blockDiff && camera.block}
            <ul class="result">
              <li class:warn={off(blockDiff.dx) || off(blockDiff.dy)}>
                Front-left corner at X{signed(blockDiff.dx)} Y{signed(blockDiff.dy)}{off(blockDiff.dx) || off(blockDiff.dy) ? ': the work zero is not on the corner. Touch off again (or move the job), the cuts would land that far off.' : ': on the work zero.'}
              </li>
              <li class:warn={off(blockDiff.sx) || off(blockDiff.sy)}>
                {camera.block.x.toFixed(1)} × {camera.block.y.toFixed(1)} mm{off(blockDiff.sx) || off(blockDiff.sy) ? ` (the job says ${stockNow.kind === 'block' ? `${stockNow.x} × ${stockNow.y}` : ''})` : ', as in the job.'}
                {#if off(blockDiff.sx) || off(blockDiff.sy)}<button class="link" onclick={useSize}>Use this size</button>{/if}
              </li>
              <li class:warn={off(blockDiff.angle, 0.2)}>
                {off(blockDiff.angle, 0.2) ? `Turned ${blockDiff.angle.toFixed(1)}° against X: square the block (or the vise) to the table.` : 'Square to X.'}
              </li>
            </ul>
          {/if}
        {/if}
      {:else}
        {#if !lathe}
          <div class="views" role="group" aria-label="Method">
            <button class:on={method === 'machine'} onclick={() => (method = 'machine')}>Machine moves a marker</button>
            <button class:on={method === 'marker'} onclick={() => (method = 'marker')}>Marker on the stock</button>
          </div>
        {/if}
        {#if method === 'machine' || lathe}
          <p class="small">Stick the tool marker to the {lathe ? 'tool post' : 'spindle'} facing the camera. Jog the tool to the middle of the work area, clear of everything{lathe ? ' (the grid goes outwards in X and away from the chuck in Z)' : ' (the grid goes up from there)'}. The machine then moves through a grid and the camera finds the marker each time; at the end, click the tool tip at four points.</p>
          <div class="grid">
            {#if lathe}
              <label>X out <input type="number" bind:value={span.x} min="5" max="100" /> mm</label>
              <label>Z away <input type="number" bind:value={span.z} min="10" max="200" /> mm</label>
            {:else}
              <label>X ± <input type="number" bind:value={span.x} min="5" max="200" /> mm</label>
              <label>Y ± <input type="number" bind:value={span.y} min="5" max="200" /> mm</label>
              <label>Z up <input type="number" bind:value={span.z} min="5" max="100" /> mm</label>
            {/if}
          </div>
          {#if camera.busy}
            <p class="small"><b>{camera.progress}</b></p>
            <button class="btn" onclick={() => camera.cancel()}>Stop</button>
          {:else}
            <button class="btn pri" disabled={!machine.connected || machine.status?.state !== 'Idle'} onclick={() => run(() => camera.calibratePose(span))}>Measure</button>
            {#if !machine.connected}<p class="muted small">Connect the machine first.</p>{/if}
          {/if}
        {:else}
          <p class="small">Lay the table marker flat on the stock top, edges along X and Y, its top edge towards +Y. Where is its centre, and how big is its black square (measured)?</p>
          <div class="grid">
            <label>X <input type="number" bind:value={markerAt.x} /> mm</label>
            <label>Y <input type="number" bind:value={markerAt.y} /> mm</label>
            <label>Square <input type="number" bind:value={markerAt.size} min="10" /> mm</label>
          </div>
          <button class="btn pri" onclick={() => run(() => camera.calibratePoseFromMarker({ x: markerAt.x, y: markerAt.y }, markerAt.size))}>Measure</button>
          <p class="muted small">Quicker, less exact than letting the machine move a marker{machine.connected ? '' : '; without the machine connected it is tied to the current work zero'}.</p>
        {/if}
      {/if}
    {/if}
  {/if}
  {#if problem}<p class="diag error">{problem}</p>{/if}
</section>

<style>
  .camera { margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
  h3 { margin: 0; font-size: 14px; }
  h4 { margin: 8px 0 0; font-size: 13px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row select { flex: 1; min-width: 0; border: 1px solid var(--line-2); border-radius: 6px; padding: 5px 8px; background: var(--panel); }
  .views { display: inline-flex; border: 1px solid var(--line-2); border-radius: 8px; overflow: hidden; align-self: flex-start; }
  .views button { border: 0; background: var(--panel); padding: 5px 10px; font-size: 12.5px; color: var(--ink-2); }
  .views button + button { border-left: 1px solid var(--line-2); }
  .views button.on { background: var(--ink); color: var(--panel); }
  .views button:disabled { opacity: 0.45; }
  .grid { display: flex; gap: 10px; flex-wrap: wrap; }
  .grid label { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--ink-2); }
  .grid input { width: 64px; border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 6px; background: var(--panel); text-align: right; }
  .small { font-size: 12.5px; margin: 0; }
  .muted { color: var(--ink-3); }
  .result { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
  .result li.warn { color: var(--warn, #b26b00); font-weight: 500; }
  .result .link { margin-left: 6px; }
  .link { border: 0; background: none; color: var(--accent-ink, #2a6fb0); text-decoration: underline; padding: 0; font-size: 12.5px; cursor: pointer; }
</style>
