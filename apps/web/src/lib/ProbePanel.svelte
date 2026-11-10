<script lang="ts">
  import { machine } from './machine.svelte.ts';
  import { probe } from './probe.svelte.ts';
  import { store } from './store.svelte.ts';

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

  function remember(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ plate }));
    } catch {
      // not kept
    }
  }
</script>

<section class="probe">
  <h3>Zero by touching</h3>
  <p class="muted small">The cutter is the probe: wire it (the spindle or a clip on the cutter) to the controller's probe input, and the other side to a touch plate or, for aluminium and other conductive stock, a clip on the stock. Each touch goes down slowly and stops the moment the circuit closes (G38.2).</p>
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
    <button class="btn" disabled={!ready} onclick={() => probe.findCorner(diameter)}>Find the front-left corner</button>
  </div>
  <p class="muted small">Check the top: start above the top; it touches nine points and tells how flat and level it is. Corner: start above the corner, within about 5 mm; it touches the top, the left side and the front side twice, sets X, Y and Z zero there and tells whether the block sits square.</p>

  {#if probe.busy}
    <p class="small"><b>{probe.step}…</b> <button class="btn danger" onclick={() => probe.cancel()}>Stop</button></p>
  {/if}
  {#if probe.result}<p class="small ok">{probe.result}</p>{/if}
  {#if probe.surface && !probe.busy}
    <div class="row">
      <button class="btn" disabled={!ready} onclick={() => probe.setZ('highest')}>Z zero on the highest point</button>
      <button class="btn" disabled={!ready} onclick={() => probe.setZ('mean')}>on the average</button>
    </div>
    <p class="muted small">Highest point before facing (nothing is cut in the air), the average to measure from an uneven top.</p>
  {/if}
  {#if probe.error}<p class="diag error">{probe.error}</p>{/if}
</section>

<style>
  .probe { margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
  h3 { margin: 0; font-size: 14px; }
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
