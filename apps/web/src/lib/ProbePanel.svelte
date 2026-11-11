<script lang="ts">
  import { machine } from './machine.svelte.ts';
  import { probe } from './probe.svelte.ts';
  import { store } from './store.svelte.ts';
  import MeasuredNote from './MeasuredNote.svelte';

  const KEY = 'swarf.probe';
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '{}') as { plate?: number };
    } catch {
      return {};
    }
  })();
  let plate = $state(saved.plate ?? 10);
  const endmills = $derived(store.job.tools.filter((t) => t.type === 'endmill'));
  let toolId = $state<number | null>(null);
  const tool = $derived(endmills.find((t) => t.id === toolId) ?? endmills[0]);
  const diameter = $derived(tool?.diameter ?? 6);
  const ready = $derived(machine.connected && machine.status?.state === 'Idle' && !probe.busy);

  const measured = $derived(store.job.measured);
  const keptTop = $derived((measured?.top.length ?? 0) > 0);
  const turn = $derived(probe.corner ? Math.round(probe.corner.angle * 100) / 100 : 0);

  /** Keep the touched top with the job, for operations that follow it. */
  function keepTop(): void {
    if (!probe.surface) return;
    store.set({ ...store.job, measured: { angle: measured?.angle ?? 0, top: probe.surface.points.map((p) => ({ x: p.x, y: p.y, z: p.z })) } });
  }
  /** Turn the toolpath with the block as the corner routine found it. */
  function keepAngle(): void {
    store.set({ ...store.job, measured: { angle: turn, top: measured?.top ?? [] } });
  }
  /** Z zero moved: a top kept before is in the old zero. */
  async function setZ(which: 'highest' | 'mean'): Promise<void> {
    await probe.setZ(which);
    if (keptTop && !probe.error) keepTop();
  }

  function remember(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ plate }));
    } catch {
      // not kept
    }
  }
</script>

<section class="probe">
  <details class="how"><summary>How this works</summary><p class="muted small">The cutter is the probe: wire it (the spindle or a clip on the cutter) to the controller's probe input, and the other side to a touch plate or, for aluminium and other conductive stock, a clip on the stock. Each touch goes down slowly and stops the moment the circuit closes (G38.2).</p></details>
  <p class="small">Probe input: <b class:on={probe.touching}>{probe.touching ? 'closed (touching)' : 'open'}</b> <span class="muted">— {machine.probeTested ? 'circuit tested since connecting.' : 'before the first touch, hold the plate (or the clip) against the cutter: it must read closed. Nothing here moves until it has.'}</span></p>
  <div class="grid">
    <label>Cutter
      <select value={tool?.id} onchange={(e) => (toolId = Number((e.currentTarget as HTMLSelectElement).value))}>
        {#each endmills as t (t.id)}<option value={t.id}>T{t.id} Ø{t.diameter}</option>{/each}
      </select>
    </label>
    <label>Plate <input type="number" step="0.01" min="0" bind:value={plate} onchange={remember} /> mm</label>
  </div>

  <h4>Z on a touch plate</h4>
  <p class="small">Lay the plate on the stock under the cutter, 5–30 mm below it.</p>
  <button class="btn pri" disabled={!ready} onclick={() => probe.zeroZ(plate, diameter)}>Touch the plate, set Z</button>

  <h4>On the stock itself (clip on the stock)</h4>
  <div class="row">
    <button class="btn" disabled={!ready} onclick={() => probe.zeroZ(0, diameter)}>Touch the top, set Z</button>
    <button class="btn" disabled={!ready} onclick={() => probe.checkSurface(diameter)}>Check the top (3 × 3)</button>
    <button class="btn" disabled={!ready} onclick={() => probe.checkSurface(diameter, 6, 4)} title="24 points, for engraving that follows an uneven top">finer (6 × 4)</button>
    <button class="btn" disabled={!ready} onclick={() => probe.findCorner(diameter)}>Find the front-left corner</button>
  </div>
  <p class="muted small">Check the top: start above the top; it touches nine points and tells how flat and level it is. Corner: start above the corner, within about 5 mm; it touches the top, the left side and the front side twice, sets X, Y and Z zero there and tells whether the block sits square.</p>

  {#if probe.busy}
    <p class="small"><b>{probe.step}…</b> <button class="btn danger" onclick={() => probe.cancel()}>Stop</button></p>
  {/if}
  {#if probe.result}<p class="small ok">{probe.result}</p>{/if}
  {#if probe.surface && !probe.busy}
    <div class="row">
      <button class="btn" disabled={!ready} onclick={() => setZ('highest')}>Z zero on the highest point</button>
      <button class="btn" disabled={!ready} onclick={() => setZ('mean')}>on the average</button>
    </div>
    <p class="muted small">Highest point before facing (nothing is cut in the air), the average to measure from an uneven top.</p>
    <div class="row">
      <button class="btn" onclick={keepTop}>{keptTop ? 'Keep this top instead' : 'Keep this top for engraving'} ({probe.surface.points.length} points)</button>
    </div>
    <p class="muted small">An engraving with "Follow the measured top" then keeps its depth against the top as touched, instead of a flat one. Between the points the top is estimated: touch more of them (6 × 4) on a top that is not just tilted.</p>
  {/if}
  {#if probe.corner && !probe.busy && Math.abs(turn) >= 0.05 && Math.abs(turn) !== Math.abs(measured?.angle ?? 0)}
    {#if Math.abs(turn) <= 5}
      <div class="row">
        <button class="btn" onclick={keepAngle}>Turn the toolpath with the block ({turn.toFixed(2)}°)</button>
      </div>
      <p class="muted small">Instead of squaring the block: the G-code is turned about the corner by the angle measured. Clamps stay where they are, so leave them room.</p>
    {:else}
      <p class="muted small">Turned by more than 5°: that is not a block sitting a little askew. Square it and find the corner again.</p>
    {/if}
  {/if}
  <MeasuredNote />
  {#if probe.error}<p class="diag error">{probe.error}</p>{/if}
</section>

<style>
  .how summary { cursor: pointer; color: var(--link); font-size: 12.5px; font-weight: 600; }
  .how p { margin-top: 6px; }
  .probe { display: flex; flex-direction: column; gap: 8px; }
  h4 { margin: 8px 0 0; font-size: 13px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .grid { display: flex; gap: 12px; flex-wrap: wrap; }
  .grid label { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--ink-2); }
  .grid input { width: 70px; border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 6px; background: var(--panel); text-align: right; }
  .grid select { border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 6px; background: var(--panel); }
  .small { font-size: 12.5px; margin: 0; }
  .muted { color: var(--ink-3); }
  b.on { color: #2e7d32; }
  .ok { color: var(--ink); background: var(--panel-2); padding: 6px 8px; border-radius: 6px; }
</style>
