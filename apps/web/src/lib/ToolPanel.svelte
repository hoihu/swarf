<script lang="ts">
  /** Tool changes: carrying the work zero over to the new tool (tooling.svelte.ts). */
  import { machine } from './machine.svelte.ts';
  import { store } from './store.svelte.ts';
  import { tooling } from './tooling.svelte.ts';
  import { camera } from './camera/camera.svelte.ts';

  const tools = $derived(store.job.tools);
  const name = (id: number | null) => (id === null ? '' : `T${id} ${tools.find((t) => t.id === id)?.name ?? ''}`.trim());
  const idle = $derived(machine.connected && machine.status?.state === 'Idle' && machine.job !== 'running' && machine.job !== 'paused' && !tooling.busy);
  const withOffset = $derived(tools.filter((t) => t.offset));
  const mill = $derived(store.job.machine.kind === 'mill');
  let next = $state<number | null>(null);
  const fmt = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3);

  // the camera, when it is running and calibrated, can tell whether the right cutter went in
  const pendingTool = $derived(tools.find((t) => t.id === tooling.pending));
  const canLook = $derived(mill && camera.running && camera.ready && !!pendingTool?.diameter);
  let looked = $state<{ id: number; ok: boolean; text: string } | null>(null);
  async function look(): Promise<void> {
    const t = pendingTool;
    if (!t?.diameter) return;
    looked = null;
    try {
      const s = await camera.checkTool(t.diameter);
      const ok = Math.abs(s.diameter - t.diameter) <= Math.max(0.5, t.diameter * 0.1);
      looked = { id: t.id, ok, text: ok ? `The camera sees a Ø${s.diameter.toFixed(1)} cutter: fits T${t.id} (Ø${t.diameter}).` : `The camera sees a Ø${s.diameter.toFixed(1)} cutter, but T${t.id} is Ø${t.diameter}: is the right tool in?` };
    } catch (e) {
      looked = { id: t.id, ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }
</script>

{#if machine.connected}
  <section class="toolpanel" aria-label="Tool changes">
    <div class="line">
      <label class="small">The zero is right for
        <select value={tooling.active ?? ''} onchange={(e) => tooling.setActive(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))} disabled={!idle || tooling.pending !== null}>
          <option value="">not known</option>
          {#each tools as t (t.id)}<option value={t.id}>{name(t.id)}</option>{/each}
        </select>
      </label>
      {#if tooling.pending === null}
        <label class="small">change to
          <select bind:value={next} disabled={!idle}>
            <option value={null}>…</option>
            {#each tools.filter((t) => t.id !== tooling.active) as t (t.id)}<option value={t.id}>{name(t.id)}</option>{/each}
          </select>
        </label>
        <button class="btn" disabled={!idle || next === null} onclick={() => { if (next !== null) tooling.begin(next); next = null; }}>Start the change</button>
      {/if}
    </div>

    {#if tooling.pending !== null}
      <div class="change">
        <p><b>Changing to {name(tooling.pending)}.</b> Put it in, then carry the zero over, one of these ways:</p>
        <div class="ways">
          {#if tooling.offsetOf(tooling.pending) && tooling.offsetOf(tooling.active)}
            <button class="btn pri" disabled={!idle} onclick={() => tooling.applyStored()}>Use T{tooling.pending}'s stored offset</button>
          {/if}
          {#if mill && tooling.setter}
            <button class="btn" class:pri={tooling.hasReading} disabled={!idle} onclick={() => tooling.measure()}>Measure it on the setter</button>
          {/if}
          <button class="btn" disabled={!idle} onclick={() => tooling.touchedOff(false)} title="You have set its zero yourself: by touching the work, the plate, or with the jog panel's Set buttons">I touched it off by hand</button>
          {#if tooling.offsetOf(tooling.active)}
            <button class="btn" disabled={!idle} onclick={() => tooling.touchedOff(true)} title="As above, and remember how this tool sits against the one before, for next time (tools in quick-change holders come back to the same place)">…and store that as its offset</button>
          {/if}
          <button class="link" onclick={() => tooling.setActive(tooling.active)}>Cancel the change</button>
        </div>
        {#if canLook}
          <p class="small"><button class="btn" disabled={!idle} onclick={look}>Is it the right tool? Ask the camera</button> <span class="muted">Raise the cutter clear of the work first.</span></p>
          {#if looked && looked.id === tooling.pending}<p class="small" class:bad={!looked.ok}>{looked.text}</p>{/if}
        {/if}
        {#if mill && tooling.setter && !tooling.hasReading}<p class="muted small">The setter has no reading of the tool before, so it cannot tell the difference this time: touch this one off on the work, say so, then take its reading below.</p>{/if}
      </div>
    {/if}

    {#if tooling.busy}<p class="small">Measuring on the setter… <button class="btn danger" onclick={() => machine.stop()}>Stop</button></p>{/if}
    {#if tooling.note}<p class="small ok">{tooling.note}</p>{/if}
    {#if tooling.error}<p class="diag error">{tooling.error}</p>{/if}

    <details>
      <summary class="small">Stored offsets{withOffset.length ? ` (${withOffset.length})` : ''}{mill ? ' and the tool setter' : ''}</summary>
      <p class="muted small">For tools that come back to the same place every time (quick-change holders): one tool is the reference, each other tool's tip is stored against it and the zero moved by that at a change. Not for collets: a tool sits differently in a collet each time.</p>
      {#if withOffset.length}
        <ul class="small">
          {#each withOffset as t (t.id)}
            <li>{name(t.id)}: {t.offset!.x === 0 && t.offset!.z === 0 ? 'the reference' : `${mill ? '' : `X ${fmt(t.offset!.x)} (radius), `}Z ${fmt(t.offset!.z)}`} <button class="link" onclick={() => tooling.forgetOffset(t.id)}>forget</button></li>
          {/each}
        </ul>
      {:else if tooling.active !== null}
        <button class="btn" onclick={() => tooling.makeReference(tooling.active!)}>Make T{tooling.active} the reference</button>
      {:else}
        <p class="muted small">Say which tool the zero is right for, then make it the reference.</p>
      {/if}
      {#if mill}
        <p class="muted small">Tool setter: a switch on the table, wired to the probe input. Each tool is touched on it; the difference between two readings is the difference in length. It is remembered in machine coordinates, so home the machine the same way each time.</p>
        {#if tooling.setter}
          <p class="small">At machine X{tooling.setter.x.toFixed(2)} Y{tooling.setter.y.toFixed(2)}, coming down from Z{tooling.setter.z.toFixed(2)}.
            <button class="link" onclick={() => tooling.removeSetter()}>forget it</button></p>
          <button class="btn" disabled={!idle || tooling.pending !== null} onclick={() => tooling.measure()}>Take a reading of the tool now in</button>
        {/if}
        <button class="btn" disabled={!idle} onclick={() => tooling.setterHere()} title="Jog the longest tool to about 20 mm above the setter first">The setter is under the tool now</button>
        {#if machine.simulated && !tooling.setter}<button class="btn" onclick={() => tooling.useSimulatedSetter()}>Use the simulated setter</button>{/if}
      {/if}
    </details>
  </section>
{/if}

<style>
  .bad { color: var(--err); font-weight: 600; }
  .toolpanel { margin: 0; }
  .line, .ways { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
  .change { margin-top: 8px; padding: 8px 10px; border-radius: 6px; background: var(--accent-soft, rgba(240, 180, 0, 0.12)); }
  .change p { margin: 0 0 6px; font-size: 13px; }
  .small { font-size: 12px; }
  .muted { color: var(--ink-3); }
  .ok { color: var(--ok, #2e7d32); margin: 8px 0 0; }
  select { border: 1px solid var(--line-2); border-radius: 6px; padding: 2px 4px; font-size: 12px; background: var(--panel); max-width: 220px; }
  details { margin-top: 8px; }
  details > * + * { margin-top: 6px; }
  ul { margin: 4px 0; padding-left: 18px; }
  .diag { margin: 8px 0 0; padding: 6px 9px; border-radius: 6px; font-size: 12.5px; }
  .diag.error { background: var(--err-soft); color: var(--err); }
</style>
