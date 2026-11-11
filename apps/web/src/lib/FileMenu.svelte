<script lang="ts">
  /** The job as a whole: start a new one, open and save it, what goes to the machine with it. */
  import { EXAMPLES, emptyJob, hasErrors } from '@swarf/cam';
  import { download, fileName, files, programName } from './files.svelte.ts';
  import { machine } from './machine.svelte.ts';
  import { store } from './store.svelte.ts';

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  const errors = $derived(hasErrors(store.analysis.diagnostics));
  const under = $derived(machine.job === 'running' || machine.job === 'paused' || machine.job === 'waiting');

  function start(kind: 'lathe' | 'mill', example: boolean): void {
    open = false;
    if (under) {
      files.say('A program is under way on the machine: stop it before starting another job.', true);
      return;
    }
    store.replace(example ? EXAMPLES[kind]() : emptyJob(kind));
    files.say(`${example ? 'The example' : 'An empty job'} for the ${kind}. Undo brings the job before back.`);
  }
  function act(f: () => void): void {
    open = false;
    f();
  }
  function away(e: MouseEvent): void {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
  function key(e: KeyboardEvent): void {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onclick={away} onkeydown={key} />

<div class="menu" bind:this={root}>
  <button class="btn ghost" aria-haspopup="menu" aria-expanded={open} onclick={() => (open = !open)}>File</button>
  <input bind:this={input} type="file" accept=".json,application/json" hidden onchange={(e) => files.openJobFrom(e)} />
  {#if open}
    <div class="list" role="menu">
      <button role="menuitem" onclick={() => start('mill', false)}>New mill job</button>
      <button role="menuitem" onclick={() => start('lathe', false)}>New lathe job</button>
      <button role="menuitem" onclick={() => start('mill', true)}>Mill example</button>
      <button role="menuitem" onclick={() => start('lathe', true)}>Lathe example</button>
      <hr />
      <button role="menuitem" onclick={() => act(() => input?.click())}>Open a job…</button>
      <button role="menuitem" onclick={() => act(() => files.saveJob())}>Save the job<span>{fileName(store.job.name, '.swarf.json')}</span></button>
      <hr />
      <button role="menuitem" onclick={() => act(() => (files.sheet = true))}>Setup sheet<span>to print</span></button>
      <button role="menuitem" disabled={errors} title={errors ? 'Fix the errors first' : ''} onclick={() => act(() => download(fileName(programName(store.job), '.nc'), store.gcode.text, 'text/plain'))}>Download the G-code<span>{store.job.setups ? `setup ${store.job.setups.at + 1}, .nc` : '.nc'}</span></button>
    </div>
  {/if}
</div>

<style>
  .menu { position: relative; }
  .btn.ghost { background: transparent; color: var(--on-iron); border-color: rgba(255, 255, 255, 0.2); }
  .btn.ghost:hover { background: rgba(255, 255, 255, 0.08); }
  .list { position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; min-width: 250px; background: var(--panel); color: var(--ink); border: 1px solid var(--line-2); border-radius: 8px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28); padding: 5px; display: flex; flex-direction: column; }
  .list button { display: flex; align-items: baseline; gap: 12px; border: 0; background: none; text-align: left; padding: 7px 10px; border-radius: 5px; font-weight: 600; }
  .list button:hover:not(:disabled) { background: var(--panel-2); }
  .list button:disabled { color: var(--ink-3); }
  .list span { margin-left: auto; font-weight: 400; font-size: 12px; color: var(--ink-3); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 4px 2px; }
</style>
