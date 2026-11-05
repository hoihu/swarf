<script lang="ts">
  import Viewer from './lib/Viewer.svelte';
  import JobPanel from './lib/JobPanel.svelte';
  import Chat from './lib/Chat.svelte';
  import Settings from './lib/Settings.svelte';
  import { store } from './lib/store.svelte.ts';
  import { minutes } from './lib/ops.ts';

  let settings = $state(false);
  /** Which pane a phone shows. */
  let pane = $state<'job' | 'view' | 'chat'>('view');

  const errors = $derived(store.analysis.diagnostics.filter((d) => d.severity === 'error').length);
  const warnings = $derived(store.analysis.diagnostics.filter((d) => d.severity === 'warning').length);
  const tools = $derived(new Set(store.analysis.program.segments.map((s) => s.tool)).size);
</script>

<div class="app">
  <header class="top">
    <span class="brand">
      <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><path d="M6 21c4-1 5-6 9-6s4 5 8 5 3-4 3-4" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" /><path d="M8 25c3 0 4-2 7-2s4 2 8 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55" /></svg>
      swarf
    </span>
    <input class="name" value={store.job.name} aria-label="Job name" onchange={(e) => store.set({ ...store.job, name: (e.currentTarget as HTMLInputElement).value || 'Job' })} />
    <span class="facts">
      <span>{store.job.machine.kind === 'lathe' ? 'Lathe' : 'Mill'}</span>
      <span>{store.job.operations.length} operation{store.job.operations.length === 1 ? '' : 's'}</span>
      {#if tools > 1}<span>{tools} tools</span>{/if}
      <span>{minutes(store.analysis.seconds)}</span>
      {#if errors}<span class="st err">{errors} error{errors === 1 ? '' : 's'}</span>
      {:else if warnings}<span class="st warn">{warnings} note{warnings === 1 ? '' : 's'}</span>
      {:else}<span class="st ok">Checks pass</span>{/if}
    </span>
    <span class="grow"></span>
    <button class="btn ghost" onclick={() => store.undo()} disabled={!store.history.length}>Undo</button>
    <button class="btn ghost" onclick={() => (settings = true)}>Model</button>
  </header>

  <main class="panes" data-pane={pane}>
    <div class="pane-job"><JobPanel /></div>
    <div class="pane-view"><Viewer job={store.job} program={store.analysis.program} selected={store.selected} /></div>
    <div class="pane-chat"><Chat onSettings={() => (settings = true)} /></div>
  </main>

  <nav class="switch" aria-label="Panes">
    <button class:on={pane === 'job'} onclick={() => (pane = 'job')}>Job</button>
    <button class:on={pane === 'view'} onclick={() => (pane = 'view')}>Preview</button>
    <button class:on={pane === 'chat'} onclick={() => (pane = 'chat')}>Assistant</button>
  </nav>
</div>

{#if settings}<Settings onClose={() => (settings = false)} />{/if}

<style>
  .app { height: 100dvh; display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; gap: 14px; padding: 8px 14px; background: var(--iron); color: var(--on-iron); flex: none; min-width: 0; }
  .brand { display: inline-flex; align-items: center; gap: 7px; font-weight: 700; font-size: 18px; letter-spacing: 0.01em; }
  .name { background: transparent; border: 1px solid transparent; color: inherit; border-radius: 6px; padding: 4px 8px; font-weight: 600; font-size: 15px; min-width: 0; width: 18ch; }
  .name:hover, .name:focus { border-color: rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.05); }
  .facts { display: flex; gap: 14px; font-size: 13px; color: var(--on-iron-2); white-space: nowrap; overflow: hidden; }
  .st { font-weight: 600; }
  .st.ok { color: #9ed3a6; }
  .st.warn { color: #f0c76a; }
  .st.err { color: #ff8f86; }
  .grow { flex: 1; }
  .btn.ghost { background: transparent; color: var(--on-iron); border-color: rgba(255, 255, 255, 0.2); }
  .btn.ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
  .panes { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(300px, 340px) 1fr minmax(320px, 380px); }
  .panes > div { min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .pane-job { border-right: 1px solid var(--line); }
  .pane-chat { border-left: 1px solid var(--line); }
  .switch { display: none; }

  @media (max-width: 980px) {
    .facts span:not(.st) { display: none; }
    .panes { grid-template-columns: 1fr; }
    .panes > div { display: none; }
    .panes[data-pane='job'] .pane-job, .panes[data-pane='view'] .pane-view, .panes[data-pane='chat'] .pane-chat { display: flex; }
    .pane-job, .pane-chat { border: 0; }
    .switch { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--line); background: var(--panel); padding-bottom: env(safe-area-inset-bottom); flex: none; }
    .switch button { border: 0; background: none; padding: 12px 0; font-weight: 600; color: var(--ink-3); border-top: 2px solid transparent; margin-top: -1px; }
    .switch button.on { color: var(--ink); border-top-color: var(--accent); }
  }
  @media (max-width: 560px) {
    .top { gap: 8px; padding: 8px 10px; }
    .name { width: 10ch; padding: 4px; }
    .brand { font-size: 0; gap: 0; }
    .facts { font-size: 12px; flex: 0 1 auto; min-width: 0; }
    .grow { display: none; }
    .btn.ghost { padding: 5px 9px; }
  }
</style>
