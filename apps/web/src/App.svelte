<script lang="ts">
  import Viewer from './lib/Viewer.svelte';
  import JobPanel from './lib/JobPanel.svelte';
  import Chat from './lib/Chat.svelte';
  import Settings from './lib/Settings.svelte';
  import CameraView from './lib/camera/CameraView.svelte';
  import { camera } from './lib/camera/camera.svelte.ts';
  import { store } from './lib/store.svelte.ts';
  import { minutes } from './lib/ops.ts';
  import { bridge } from './lib/bridge.svelte.ts';
  import { machine } from './lib/machine.svelte.ts';
  import { files } from './lib/files.svelte.ts';
  import SetupSheet from './lib/SetupSheet.svelte';
  import FileMenu from './lib/FileMenu.svelte';
  import { ui, type Mode } from './lib/ui.svelte.ts';
  import MachinePanel from './lib/MachinePanel.svelte';
  import AtMachine from './lib/AtMachine.svelte';
  import { onMount } from 'svelte';

  onMount(() => bridge.start());

  let settings = $state(false);
  const mode = $derived(ui.mode);
  const go = (m: Mode) => ui.go(m);
  /** Which pane a phone shows: the left one, the preview, the right one. */
  let pane = $state<'left' | 'view' | 'right'>('view');
  const mst = $derived(machine.status?.state ?? '');
  const machineSays = $derived(
    !machine.connected ? '' : machine.job === 'running' ? 'running' : machine.job === 'waiting' ? 'tool change' : machine.job === 'paused' ? 'held' : mst === 'Alarm' ? 'alarm' : mst.toLowerCase(),
  );

  const errors = $derived(store.analysis.diagnostics.filter((d) => d.severity === 'error').length);
  const warnings = $derived(store.analysis.diagnostics.filter((d) => d.severity === 'warning').length);
  /** The controller's work position for the preview. grblHAL in lathe diameter mode (G7) reports X as a diameter. */
  const live = $derived.by(() => {
    const p = machine.status?.wpos;
    if (!p) return null;
    const lathe = store.job.machine.kind === 'lathe';
    return lathe ? { x: store.job.machine.xMode === 'diameter' ? p[0] / 2 : p[0], y: 0, z: p[2] } : { x: p[0], y: p[1], z: p[2] };
  });
  const tools = $derived(new Set(store.analysis.program.segments.map((s) => s.tool)).size);
</script>

<div class="app">
  <header class="top">
    <span class="brand">
      <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><path d="M6 21c4-1 5-6 9-6s4 5 8 5 3-4 3-4" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" /><path d="M8 25c3 0 4-2 7-2s4 2 8 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55" /></svg>
      swarf
    </span>
    <div class="modes" role="group" aria-label="Where you are working">
      <button class:on={mode === 'job'} aria-pressed={mode === 'job'} onclick={() => go('job')}>Job</button>
      <button class:on={mode === 'machine'} aria-pressed={mode === 'machine'} onclick={() => go('machine')}>
        Machine{#if machineSays}<i class="m-{machineSays.replace(' ', '-')}" title="The controller: {machineSays}"></i><span class="says">{machineSays}</span>{/if}
      </button>
    </div>
    <FileMenu />
    <input class="name" value={store.job.name} aria-label="Job name" onchange={(e) => store.set({ ...store.job, name: (e.currentTarget as HTMLInputElement).value || 'Job' })} />
    <span class="facts">
      <span>{store.job.machine.kind === 'lathe' ? 'Lathe' : 'Mill'}</span>
      {#if store.job.setups}<span>setup {store.job.setups.at + 1} of {store.job.setups.others.length + 1}</span>{/if}
      <span>{store.job.operations.length} operation{store.job.operations.length === 1 ? '' : 's'}</span>
      {#if tools > 1}<span>{tools} tools</span>{/if}
      <span>{minutes(store.analysis.seconds)}</span>
      {#if errors}<span class="st err">{errors} error{errors === 1 ? '' : 's'}</span>
      {:else if warnings}<span class="st warn">{warnings} note{warnings === 1 ? '' : 's'}</span>
      {:else}<span class="st ok">Checks pass</span>{/if}
    </span>
    <span class="grow"></span>
    {#if bridge.status !== 'off'}
      <span class="link-state {bridge.status}" title={bridge.status === 'denied' ? bridge.reason : bridge.last ? `Last: ${bridge.last}` : 'Connected to the local swarf server'}>
        <i></i>{bridge.status === 'connected' ? bridge.agent ? `${bridge.agent} connected` : 'swarf server connected' : bridge.status === 'denied' ? 'Server refused' : bridge.status === 'offline' ? 'Server offline' : 'Connecting…'}
      </span>
    {/if}
    <button class="btn ghost" onclick={() => store.undo()} disabled={!store.history.length}>Undo</button>
  </header>

  {#if files.message}
    <div class="said" class:bad={files.message.bad} role="status">
      <span>{files.message.text}</span>
      <button aria-label="Dismiss" onclick={() => (files.message = null)}>×</button>
    </div>
  {/if}

  <!-- both sets of side panes stay alive (a running program's bookkeeping lives in the machine's); the mode shows one -->
  <main class="panes" data-pane={pane} data-mode={mode}>
    <div class="pane-left for-job"><JobPanel /></div>
    <div class="pane-left for-machine"><div class="scroll"><MachinePanel /></div></div>
    <div class="pane-view">
      <Viewer job={store.job} program={store.analysis.program} selected={store.selected} {live} spindle={machine.status?.spindle ?? 0} />
      {#if camera.running && camera.view === 'camera'}<CameraView />{/if}
    </div>
    <div class="pane-right for-job"><Chat onSettings={() => (settings = true)} /></div>
    <div class="pane-right for-machine"><AtMachine /></div>
  </main>

  <nav class="switch" aria-label="Panes">
    <button class:on={pane === 'left'} onclick={() => (pane = 'left')}>{mode === 'job' ? 'Job' : 'Machine'}</button>
    <button class:on={pane === 'view'} onclick={() => (pane = 'view')}>Preview</button>
    <button class:on={pane === 'right'} onclick={() => (pane = 'right')}>{mode === 'job' ? 'Assistant' : 'Setting up'}</button>
  </nav>
</div>

{#if settings}<Settings onClose={() => (settings = false)} />{/if}
{#if files.sheet}<SetupSheet onClose={() => (files.sheet = false)} />{/if}

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
  .link-state { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--on-iron-2); white-space: nowrap; }
  .link-state i { width: 8px; height: 8px; border-radius: 50%; background: #8a958f; }
  .link-state.connected { color: var(--on-iron); }
  .link-state.connected i { background: #7fcf92; }
  .link-state.offline i, .link-state.denied i { background: #ff8f86; }
  .btn.ghost { background: transparent; color: var(--on-iron); border-color: rgba(255, 255, 255, 0.2); }
  .btn.ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
  .said { display: flex; align-items: center; gap: 10px; padding: 6px 14px; background: var(--panel-2); border-bottom: 1px solid var(--line); font-size: 13px; flex: none; }
  .said.bad { background: var(--err-soft); color: var(--err); }
  .said span { flex: 1; min-width: 0; }
  .said button { border: 0; background: none; color: inherit; font-size: 18px; line-height: 1; padding: 0 4px; }
  .modes { display: inline-flex; border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 7px; padding: 2px; gap: 2px; flex: none; }
  .modes button { border: 0; background: none; color: var(--on-iron-2); font-weight: 700; padding: 4px 13px; border-radius: 5px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .modes button:hover { color: var(--on-iron); }
  .modes button.on { background: var(--accent); color: var(--on-accent); }
  .modes i { width: 8px; height: 8px; border-radius: 50%; background: #7fcf92; box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.4); }
  .modes i.m-running, .modes i.m-run, .modes i.m-jog, .modes i.m-home { background: #7db7ff; }
  .modes i.m-tool-change, .modes i.m-held, .modes i.m-hold, .modes i.m-door { background: #f0c76a; }
  .modes i.m-alarm { background: #ff8f86; }
  .modes .says { font-weight: 500; font-size: 12px; }
  .modes button.on .says { color: inherit; }
  .panes { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(320px, 360px) 1fr minmax(320px, 380px); }
  .panes > div { min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .panes[data-mode='job'] > .for-machine, .panes[data-mode='machine'] > .for-job { display: none; }
  .pane-view { position: relative; }
  .pane-left { border-right: 1px solid var(--line); background: var(--panel); }
  .pane-right { border-left: 1px solid var(--line); }
  .scroll { flex: 1; overflow: auto; }
  .switch { display: none; }

  @media (max-width: 1100px) {
    .facts span:not(.st) { display: none; }
  }
  @media (max-width: 980px) {
    .link-state { font-size: 0; gap: 0; }
    .modes .says { display: none; }
    .panes { grid-template-columns: 1fr; }
    .panes > div { display: none; }
    .panes[data-mode='job'][data-pane='left'] > .pane-left.for-job, .panes[data-mode='machine'][data-pane='left'] > .pane-left.for-machine,
    .panes[data-pane='view'] > .pane-view,
    .panes[data-mode='job'][data-pane='right'] > .pane-right.for-job, .panes[data-mode='machine'][data-pane='right'] > .pane-right.for-machine { display: flex; }
    .pane-left, .pane-right { border: 0; }
    .switch { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--line); background: var(--panel); padding-bottom: env(safe-area-inset-bottom); flex: none; }
    .switch button { border: 0; background: none; padding: 12px 0; font-weight: 600; color: var(--ink-3); border-top: 2px solid transparent; margin-top: -1px; }
    .switch button.on { color: var(--ink); border-top-color: var(--accent); }
  }
  @media (max-width: 620px) {
    .top { gap: 8px; padding: 8px 10px; }
    .name { width: 9ch; padding: 4px; flex: 1 1 auto; }
    .brand { font-size: 0; gap: 0; }
    .facts { display: none; }
    .grow { display: none; }
    .btn.ghost { padding: 5px 9px; }
    .modes button { padding: 4px 9px; }
    .undo-word { display: none; }
  }
</style>
