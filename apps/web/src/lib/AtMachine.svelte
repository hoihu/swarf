<script lang="ts">
  /** Getting the machine ready for the job: the tool, the zero, a look and a listen. Each part folds away and says where it stands. */
  import Section from './Section.svelte';
  import ToolPanel from './ToolPanel.svelte';
  import ProbePanel from './ProbePanel.svelte';
  import CameraPanel from './camera/CameraPanel.svelte';
  import ListenPanel from './listen/ListenPanel.svelte';
  import { camera } from './camera/camera.svelte.ts';
  import { listening } from './listen/listen.svelte.ts';
  import { machine } from './machine.svelte.ts';
  import { probe } from './probe.svelte.ts';
  import { store } from './store.svelte.ts';
  import { tooling } from './tooling.svelte.ts';

  const mill = $derived(store.job.machine.kind === 'mill');
  const tool = $derived(
    !machine.connected ? '' : tooling.pending !== null ? `changing to T${tooling.pending}` : tooling.active !== null ? `T${tooling.active} is in` : 'which tool is in?',
  );
</script>

<section class="side">
  <header><h2>Setting up</h2></header>
  <div class="body">
    <Section id="tools" title="Tool changes" status={tool} tone={tooling.pending !== null ? 'warn' : ''} force={tooling.pending !== null}>
      {#if machine.connected}<ToolPanel />{:else}<p class="muted">Connect the machine first: a tool change carries the work zero over to the new tool.</p>{/if}
    </Section>
    {#if mill}
      <Section id="probe" title="Zero by touching" status={!machine.connected ? '' : probe.busy ? probe.step : probe.touching ? 'input closed' : machine.probeTested ? 'circuit tested' : 'not tested yet'} tone={probe.busy ? 'warn' : ''}>
        {#if machine.connected}<ProbePanel />{:else}<p class="muted">Connect the machine first: the cutter touches a plate or the stock, and the controller stops at the touch.</p>{/if}
      </Section>
    {/if}
    <Section id="camera" title="Camera" status={camera.running ? (camera.ready ? 'on, calibrated' : 'on, not calibrated') : 'off'} tone={camera.running && camera.ready ? 'ok' : ''}>
      <CameraPanel />
    </Section>
    <Section id="listen" title="Listen to the cut" status={listening.on ? (listening.state === 'chatter' ? 'chatter' : listening.state) : 'off'} tone={listening.on && listening.state === 'chatter' ? 'err' : ''}>
      <ListenPanel />
    </Section>
  </div>
</section>

<style>
  .side { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--panel); }
  header { padding: 10px 14px; flex: none; }
  h2 { margin: 0; font-size: 14px; }
  .body { flex: 1; overflow: auto; }
  .muted { color: var(--ink-3); font-size: 12.5px; margin: 0; }
</style>
