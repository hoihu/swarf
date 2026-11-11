<script lang="ts">
  /** What was measured on the machine and is applied to this job's G-code, with the way to forget it. */
  import { alignmentLines } from '@swarf/cam';
  import { store } from './store.svelte.ts';

  const m = $derived(store.job.measured);
  const has = $derived(!!m && (Math.abs(m.angle) > 1e-9 || m.top.length > 0));
  const applied = $derived(alignmentLines(store.job));
  const following = $derived(store.job.operations.some((o) => 'follow' in o && o.follow));

  function forget(): void {
    const { measured: _, ...rest } = store.job;
    store.set(rest);
  }
</script>

{#if has && m}
  <div class="measured" role="note">
    <strong>Measured on the machine, for this clamping</strong>
    <ul>
      {#if Math.abs(m.angle) > 1e-9}<li>The block sits turned {m.angle.toFixed(2)}°: the G-code is turned with it, about X0 Y0. The preview and the checks show the block as drawn.</li>{/if}
      {#if m.top.length}
        <li>The top, touched at {m.top.length} points{#if following && applied.some((l) => l.includes('follow'))}: operations set to follow it keep their depth against it.{:else}. No operation follows it yet: switch on "Follow the measured top" in an engraving.{/if}</li>
      {/if}
    </ul>
    <button class="btn" onclick={forget}>Forget (the block was taken out)</button>
  </div>
{/if}

<style>
  .measured { border: 1px solid var(--warn); background: var(--warn-soft); border-radius: 8px; padding: 8px 10px; margin: 8px 0; font-size: 12.5px; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  ul { margin: 0; padding-left: 16px; }
</style>
