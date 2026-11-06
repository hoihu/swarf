<script lang="ts">
  import { tick } from 'svelte';
  import { machine } from './machine.svelte.ts';
  import { store } from './store.svelte.ts';
  import { simWorld } from './simworld.ts';
  import { SETUPS, type SetupName } from './sim/setups.ts';

  let mdi = $state('');
  // what the simulated mill has on its table (the probe touches it, the simulated camera sees it)
  let simSetup = $state<SetupName>(simWorld.setup);
  const setSimSetup = (v: SetupName) => {
    simSetup = v;
    simWorld.setup = v;
  };
  let log: HTMLDivElement | undefined = $state();

  const errors = $derived(store.analysis.diagnostics.some((d) => d.severity === 'error'));
  const st = $derived(machine.status?.state ?? 'Unknown');
  const busy = $derived(machine.job === 'running' || machine.job === 'paused');
  const canStart = $derived(machine.connected && !busy && !errors && st === 'Idle');
  const lathe = $derived(store.job.machine.kind === 'lathe');
  const pct = $derived(machine.total ? Math.round((machine.acked / machine.total) * 100) : 0);
  const fmt = (n: number | undefined) => (n === undefined ? '–' : n.toFixed(3));

  async function start(): Promise<void> {
    const ok = confirm(
      `Run "${store.job.name}" on the machine?\n\nCheck first: work zero set, first tool loaded and touched off, the path clear. The program pauses (M0) at every tool change.`,
    );
    if (ok) await machine.run(store.gcode.text);
  }

  async function sendMdi(e: Event): Promise<void> {
    e.preventDefault();
    const line = mdi.trim();
    if (!line) return;
    mdi = '';
    await machine.send(line);
  }

  $effect(() => {
    void machine.console.length;
    void tick().then(() => log?.scrollTo({ top: log.scrollHeight }));
  });
</script>

{#if !machine.connected}
  <div class="empty">
    <p>Connect the grblHAL controller to run the job from here.</p>
    {#if machine.supported}
      <button class="btn pri" onclick={() => machine.connect()}>Connect over USB</button>
      <p class="muted small">The browser asks which port to use. 115200 baud.</p>
    {:else}
      <p class="muted small">USB needs a browser with Web Serial (Chrome or Edge on a computer).</p>
    {/if}
    <form class="mdi" onsubmit={(e) => { e.preventDefault(); void machine.connect(true); }}>
      <input bind:value={machine.url} placeholder="ws://192.168.1.50:81" aria-label="Controller address" spellcheck="false" autocomplete="off" />
      <button class="btn" type="submit" disabled={!machine.url.trim()}>Connect over network</button>
    </form>
    <p class="muted small">Networked grblHAL boards: the WebSocket server ($307, usually port 81). If yours wants a subprotocol, add it after a space, e.g. <code>ws://192.168.1.50:81 arduino</code>.</p>
    <p class="muted small">Or download the .nc file from the G-code tab and run it with your usual sender.</p>
    <p class="muted small">No machine at hand? <button class="link" onclick={() => machine.connect('sim', store.job.machine.kind)}>Connect a simulated {store.job.machine.kind}</button>: it moves in real time, for trying things out.</p>
    {#if machine.message}<p class="diag error">{machine.message}</p>{/if}
  </div>
{:else}
  <div class="state">
    <span class="badge s-{st.toLowerCase()}">{st}{machine.status?.sub !== undefined ? `:${machine.status.sub}` : ''}</span>
    <span class="muted">{machine.label}</span>
    <span class="grow"></span>
    <button class="btn" onclick={() => machine.disconnect()} disabled={busy}>Disconnect</button>
  </div>
  {#if machine.simulated && !lathe}
    <div class="simsetup">
      <label>On the simulated table
        <select value={simSetup} onchange={(e) => setSimSetup(e.currentTarget.value as SetupName)} disabled={busy}>
          {#each SETUPS as s (s.name)}<option value={s.name}>{s.label}</option>{/each}
        </select>
      </label>
      <p class="muted small">{SETUPS.find((s) => s.name === simSetup)?.about} The block itself sits a little off from the job, turned and tilted a touch, as a real one would.</p>
    </div>
  {/if}

  <div class="dro" aria-label="Work position">
    {#each lathe ? [['X', 0], ['Z', 2]] : [['X', 0], ['Y', 1], ['Z', 2]] as [axis, i] (axis)}
      <div><span class="ax">{axis}</span><span class="v">{fmt(machine.status?.wpos?.[i as number])}</span></div>
    {/each}
    <div class="small"><span class="ax">F</span>{machine.status?.feed ?? '–'} <span class="ax">S</span>{machine.status?.spindle ?? '–'}{#if machine.status?.ov} · feed {machine.status.ov[0]}%{/if}</div>
  </div>

  <div class="row">
    <button class="btn pri" onclick={start} disabled={!canStart} title={errors ? 'The job has errors' : st !== 'Idle' ? 'The controller must be idle' : ''}>Run program</button>
    {#if machine.job === 'paused'}
      <button class="btn" onclick={() => machine.resume()}>Resume</button>
    {:else}
      <button class="btn" onclick={() => machine.hold()} disabled={!busy}>Hold</button>
    {/if}
    <button class="btn danger" onclick={() => machine.stop()}>Stop (reset)</button>
  </div>
  {#if busy || machine.job === 'done' || machine.job === 'failed' || machine.job === 'stopped'}
    <div class="progress"><i style="width: {pct}%"></i></div>
    <p class="muted small">{machine.acked} / {machine.total} blocks{machine.line >= 0 ? ` · line ${machine.line + 1}` : ''}</p>
  {/if}
  {#if machine.message}<p class="diag {machine.job === 'failed' || st === 'Alarm' ? 'error' : machine.job === 'done' ? 'ok' : 'warning'}">{machine.message}</p>{/if}

  <div class="row">
    <button class="btn" onclick={() => machine.feed('feedMinus10')}>Feed −10%</button>
    <button class="btn" onclick={() => machine.feed('feed100')}>100%</button>
    <button class="btn" onclick={() => machine.feed('feedPlus10')}>Feed +10%</button>
  </div>
  <div class="row">
    <button class="btn" onclick={() => machine.send('$X')} disabled={busy}>Unlock</button>
    <button class="btn" onclick={() => machine.send('$H')} disabled={busy}>Home</button>
  </div>

  <div class="console" bind:this={log}>
    {#each machine.console as l, i (i)}<div class={l.dir}>{l.dir === 'out' ? '> ' : ''}{l.text}</div>{/each}
  </div>
  <form class="mdi" onsubmit={sendMdi}>
    <input bind:value={mdi} placeholder="Command, e.g. G0 X0 Z5" aria-label="Command" disabled={busy} spellcheck="false" autocomplete="off" />
    <button class="btn" type="submit" disabled={busy || !mdi.trim()}>Send</button>
  </form>
{/if}

<style>
  .empty p { margin: 0 0 8px; }
  .empty .mdi { margin: 14px 0 6px; }
  .empty code { font-family: var(--mono); font-size: 11.5px; }
  .muted { color: var(--ink-3); }
  .small { font-size: 12px; }
  .grow { flex: 1; }
  .simsetup { margin-bottom: 10px; }
  .simsetup label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .simsetup p { margin: 4px 0 0; }
  .state { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .badge { font-weight: 700; padding: 2px 10px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--line); }
  .s-idle { color: var(--ok); }
  .s-run, .s-jog, .s-home { color: var(--link); }
  .s-hold, .s-door, .s-tool { color: var(--warn); background: var(--warn-soft); }
  .s-alarm { color: var(--err); background: var(--err-soft); }
  .dro { background: var(--iron); color: var(--on-iron); border-radius: 8px; padding: 10px 14px; font-family: var(--mono); display: flex; flex-direction: column; gap: 2px; }
  .dro div { display: flex; align-items: baseline; gap: 12px; }
  .dro .v { font-size: 22px; font-variant-numeric: tabular-nums; margin-left: auto; color: #f2d16b; }
  .dro .ax { color: var(--on-iron-2); font-weight: 600; }
  .dro .small { color: var(--on-iron-2); gap: 6px; margin-top: 4px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
  .progress { height: 6px; background: var(--panel-2); border-radius: 3px; overflow: hidden; }
  .progress i { display: block; height: 100%; background: var(--accent); }
  .diag { margin: 6px 0; padding: 6px 9px; border-radius: 6px; font-size: 12.5px; }
  .diag.error { background: var(--err-soft); color: var(--err); }
  .diag.warning { background: var(--warn-soft); color: var(--warn); }
  .diag.ok { background: var(--panel-2); color: var(--ok); }
  .console { height: 160px; overflow: auto; font-family: var(--mono); font-size: 11.5px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
  .console .out { color: var(--ink-3); }
  .console .note { color: var(--warn); }
  .mdi { display: flex; gap: 6px; margin-top: 6px; }
  .mdi input { flex: 1; min-width: 0; border: 1px solid var(--line-2); border-radius: 6px; padding: 5px 8px; font-family: var(--mono); font-size: 12.5px; background: var(--panel); }
</style>
