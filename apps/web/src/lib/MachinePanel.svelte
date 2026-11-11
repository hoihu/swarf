<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { TURNS, emit, hasErrors, resumeFrom, setupList, switchSetup, walk, type Job } from '@swarf/cam';
  import JogPanel from './JogPanel.svelte';
  import Section from './Section.svelte';
  import { download } from './files.svelte.ts';
  import { tooling } from './tooling.svelte.ts';
  import { machine } from './machine.svelte.ts';
  import { store } from './store.svelte.ts';
  import { simWorld } from './simworld.ts';
  import { SETUPS, type SetupName } from './sim/setups.ts';

  let mdi = $state('');
  let savingLog = $state(false);
  async function saveLog(): Promise<void> {
    savingLog = true;
    try {
      const text = await machine.logText();
      download(`swarf-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`, text, 'text/plain');
    } finally {
      savingLog = false;
    }
  }
  // what the simulated mill has on its table (the probe touches it, the simulated camera sees it)
  let simSetup = $state<SetupName>(simWorld.setup);
  const setSimSetup = (v: SetupName) => {
    simSetup = v;
    simWorld.setup = v;
  };
  let log: HTMLDivElement | undefined = $state();

  const st = $derived(machine.status?.state ?? 'Unknown');
  // lines of the program are under way or held: nothing else may be sent
  const busy = $derived(machine.job === 'running' || machine.job === 'paused');
  // the program waits at a tool change: the machine is free for touching off
  const waiting = $derived(machine.job === 'waiting');

  // leaving the page while a program runs stops feeding it; the machine would run what it has and stand with the spindle on
  $effect(() => {
    if (!busy && !waiting) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  });

  // the simulator: which cutter is in the spindle (for what it runs into)
  $effect(() => {
    if (!machine.simulated || machine.job !== 'running' || machine.line < 0) return;
    const move = store.gcode.lineOfMove.findIndex((l) => l >= machine.line);
    let n = 0;
    for (const seg of store.analysis.program.segments) {
      n += seg.moves.length;
      if (move < n) {
        const d = store.job.tools.find((t) => t.id === seg.tool)?.diameter;
        if (d) simWorld.toolDiameter = d;
        break;
      }
    }
  });
  const lathe = $derived(store.job.machine.kind === 'lathe');
  const pct = $derived(machine.total ? Math.round((machine.acked / machine.total) * 100) : 0);
  const fmt = (n: number | undefined) => (n === undefined ? '–' : n.toFixed(3));

  // ---- starting in the middle: after a stop or a broken tool, from an operation on ----
  /** The operations of the program in order, each with its first segment. */
  const starts = $derived.by(() => {
    const out: { seg: number; opId: string; label: string; tool: number }[] = [];
    store.analysis.program.segments.forEach((s, i) => {
      if (out.at(-1)?.opId !== s.opId) out.push({ seg: i, opId: s.opId, label: s.label, tool: s.tool });
    });
    return out;
  });
  /** The operation to start at (its id; '': the whole program). */
  let startAt = $state('');
  $effect(() => {
    // the job changed under it
    if (startAt && !starts.some((s) => s.opId === startAt)) startAt = '';
  });
  const startSeg = $derived(starts.find((s) => s.opId === startAt)?.seg ?? 0);
  const resume = $derived(startSeg > 0 ? resumeFrom(store.job, store.analysis.program, startSeg) : null);
  // what will be run must be free of errors (errors of operations already done do not hold a restart up)
  const errors = $derived(hasErrors(resume ? resume.diagnostics : store.analysis.diagnostics));
  const canStart = $derived(machine.connected && !busy && !waiting && !errors && st === 'Idle' && !machine.lost);
  // the program waits at a tool change: which tool it wants next (the first segment after the line it stopped at)
  $effect(() => {
    if (machine.job !== 'waiting') return;
    const whole = store.gcode.lineOfMove;
    let n = 0;
    for (const seg of store.analysis.program.segments) {
      const firstLine = whole[n] ?? -1;
      n += seg.moves.length;
      if (firstLine > machine.line) {
        const id = seg.tool;
        untrack(() => {
          tooling.begin(id);
          // the simulated mill: the new tool sits differently in its collet
          if (machine.simulated && !lathe) {
            const before = simWorld.stickout;
            const d = simWorld.loadTool(id) - before;
            machine.note(`Simulated tool change: T${id} sticks out ${Math.abs(d).toFixed(1)} mm ${d >= 0 ? 'more' : 'less'} than the tool before. Until its Z is set, everything is off by that.`);
          }
        });
        return;
      }
    }
  });
  // nothing is known about the tools once the controller is gone or has lost its place
  $effect(() => {
    if (!machine.connected || st === 'Alarm') untrack(() => tooling.forget());
  });
  /**
   * The operation the program was in when it last stopped short (offered as the place to start
   * again). The line last acknowledged is ahead of the machine by whatever the controller had
   * buffered, so: of the moves in the last 150 lines up to it, the one the machine stands nearest to.
   */
  let stoppedIn = $state('');
  $effect(() => {
    if (machine.job !== 'stopped' && machine.job !== 'failed') return;
    const w = machine.status?.wpos;
    const line = machine.line;
    if (!w || line < 0) return;
    untrack(() => {
      const at = { x: lathe && store.job.machine.xMode === 'diameter' ? w[0]! / 2 : w[0]!, y: lathe ? 0 : w[1]!, z: w[2]! };
      const lines = store.gcode.lineOfMove;
      let best = { d: Infinity, op: '' };
      for (const m of walk(store.analysis.program)) {
        const l = lines[m.index] ?? -1;
        if (l < line - 150 || l > line) continue;
        // distance from where it stands to this move's straight line
        const [ax, ay, az] = [m.from.x, m.from.y, m.from.z];
        const [bx, by, bz] = [m.move.to.x - ax, m.move.to.y - ay, m.move.to.z - az];
        const len2 = bx * bx + by * by + bz * bz;
        const t = len2 > 1e-12 ? Math.min(1, Math.max(0, ((at.x - ax) * bx + (at.y - ay) * by + (at.z - az) * bz) / len2)) : 0;
        const d = Math.hypot(at.x - ax - t * bx, at.y - ay - t * by, at.z - az - t * bz);
        if (d < best.d - 1e-6) best = { d, op: store.analysis.program.segments[m.seg]!.opId };
      }
      if (best.op) stoppedIn = best.op;
    });
  });

  async function start(): Promise<void> {
    const program = resume ? resume.program : store.analysis.program;
    const first = store.job.tools.find((t) => t.id === program.segments[startSeg]?.tool);
    const diags = resume ? resume.diagnostics : store.analysis.diagnostics;
    const warnings = diags.filter((d) => d.severity === 'warning').length;
    const from = starts.find((s) => s.seg === startSeg);
    const ok = confirm(
      (resume && from ? `Run "${store.job.name}" from ${from.opId} (${from.label}) on?\n\nEverything before it is taken as done: the checks assume that material is gone.\n\n` : `Run "${store.job.name}" on the machine?\n\n`) +
        `Check first:\n• work zero set where the job has it${resume ? ' (still: a reset keeps it, a power cycle without homing does not)' : ''}\n• ${first ? `T${first.id} (${first.name})` : 'the first tool'} loaded and its Z touched off\n• clamps and everything else clear of the path${store.job.obstacles.length ? '' : ' (the job knows of no obstacles: nothing is checked against clamps)'}\n• a hand on the emergency stop\n\n` +
        `${lathe ? 'The tool first goes along Z, away from the chuck, then out in X.' : 'The tool first rises straight up to the travel height, then goes to X0 Y0.'} The program waits at every later tool change.` +
        (warnings ? `\n\nThe checks have ${warnings} warning${warnings > 1 ? 's' : ''}.` : ''),
    );
    if (!ok) return;
    // the program as checked just now, not as it was when the tab was opened
    if (errors) return;
    machine.crash = '';
    simWorld.crashes = [];
    // the user has just said so: the zero is right for the tool the program starts with
    if (first) tooling.setActive(first.id);
    if (!resume) {
      await machine.run(store.gcode.text, true);
      return;
    }
    // the rest of the program; its lines numbered as in the whole one, for the G-code tab and the preview
    const part = emit(store.job, resume.program, { fromSegment: startSeg });
    const whole = store.gcode.lineOfMove;
    const map: number[] = [];
    let last = whole[resume.firstMove - resume.added] ?? 0;
    part.lineOfMove.forEach((line, k) => {
      if (line < 0) return;
      // (the way home put in before the start has no line in the whole program)
      const w = k >= resume.firstMove ? whole[k - resume.added] : undefined;
      if (w !== undefined && w >= 0) last = w;
      map[line] = last;
    });
    for (let i = 0, cur = map.find((x) => x !== undefined) ?? 0; i < part.text.split('\n').length; i++) {
      if (map[i] === undefined) map[i] = cur;
      else cur = map[i]!;
    }
    await machine.run(part.text, true, map);
  }

  async function resumeProgram(): Promise<void> {
    if (!waiting) return void machine.resume();
    // at a tool change: has the zero been carried over to the new tool?
    if (tooling.pending !== null) {
      if (!confirm(`The zero has not been carried over to T${tooling.pending} yet (see "Tool changes" under Setting up): its length is not accounted for.\n\nGo on anyway?`)) return;
      tooling.touchedOff(false);
    }
    // The program goes on with "Z to the travel height, then across". From below that is straight
    // up; from above (after the tool setter, or jogged up high) it would come down where the tool
    // stands, perhaps onto the setter. So from above: across first, at the height it is at.
    const home = store.analysis.program.home;
    const w = machine.status?.wpos;
    if (w && w[2]! > home.z + 0.01) {
      const x = lathe && store.job.machine.xMode === 'diameter' ? home.x * 2 : home.x;
      const r = await machine.request(lathe ? `G90 G0 X${x.toFixed(3)}` : `G90 G0 X${x.toFixed(3)} Y${home.y.toFixed(3)}`);
      if (!r.ok) return;
      await new Promise((res) => setTimeout(res, 300));
      for (let i = 0; i < 1500 && machine.status?.state !== 'Idle'; i++) await new Promise((res) => setTimeout(res, 40));
      await new Promise((res) => setTimeout(res, 450));
    }
    void machine.resume();
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
  <div class="empty pad">
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
    <p class="muted small">Something went wrong before the connection was lost? <button class="link" onclick={saveLog} disabled={savingLog}>Save the log</button> of this visit.</p>
    <p class="muted small">No machine at hand? <button class="link" onclick={() => machine.connect('sim', store.job.machine.kind)}>Connect a simulated {store.job.machine.kind}</button>: it moves in real time, for trying things out.</p>
    {#if machine.message}<p class="diag error">{machine.message}</p>{/if}
  </div>
{:else}
  <div class="pad">
  <div class="state">
    <span class="badge s-{st.toLowerCase()}">{st}{machine.status?.sub !== undefined ? `:${machine.status.sub}` : ''}</span>
    <span class="muted">{machine.label}</span>
    <span class="grow"></span>
    <button class="btn" onclick={() => machine.disconnect()} disabled={busy || waiting}>Disconnect</button>
  </div>
  {#if machine.simulated && !lathe}
    <div class="simsetup">
      <label>On the simulated table
        <select value={simSetup} onchange={(e) => setSimSetup(e.currentTarget.value as SetupName)} disabled={busy}>
          {#each SETUPS as s (s.name)}<option value={s.name}>{s.label}</option>{/each}
        </select>
      </label>
      <p class="muted small">{SETUPS.find((s) => s.name === simSetup)?.about}</p>
    </div>
  {/if}

  <div class="dro" aria-label="Work position">
    {#each lathe ? [['X', 0], ['Z', 2]] : [['X', 0], ['Y', 1], ['Z', 2]] as [axis, i] (axis)}
      <div><span class="ax">{axis}</span><span class="v">{fmt(machine.status?.wpos?.[i as number])}</span></div>
    {/each}
    <div class="small"><span class="ax">F</span>{machine.status?.feed ?? '–'} <span class="ax">S</span>{machine.status?.spindle ?? '–'}</div>
  </div>

  {#if starts.length > 1}
    <div class="row from">
      <label class="small">Start at
        <select bind:value={startAt} disabled={busy || waiting}>
          <option value="">the beginning</option>
          {#each starts.slice(1) as s (s.opId)}<option value={s.opId}>{s.opId}: {s.label} (T{s.tool})</option>{/each}
        </select>
      </label>
      {#if stoppedIn && stoppedIn !== startAt && starts.slice(1).some((s) => s.opId === stoppedIn) && !busy && !waiting && (machine.job === 'stopped' || machine.job === 'failed')}
        <button class="link" onclick={() => (startAt = stoppedIn)}>It stopped in {stoppedIn}: start there again</button>
      {/if}
      {#if resume}<span class="muted small">Everything before it is taken as done.</span>{/if}
    </div>
  {/if}
  {#if store.job.setups}
    {@const all = setupList(store.job)}
    <div class="which">
      <label class="small">Setup
        <select value={all.at} disabled={busy || waiting} onchange={(e) => store.setup(switchSetup($state.snapshot(store.job) as Job, Number((e.currentTarget as HTMLSelectElement).value)))}>
          {#each all.setups as s, i (i)}<option value={i}>{i + 1} of {all.setups.length}: {s.name}</option>{/each}
        </select>
      </label>
      <p class="muted small">
        {#if all.at > 0}{TURNS.find((t) => t.turn === store.job.setups?.turn)?.how}{' '}{/if}Each setup has its own zero: set X, Y and Z again on the block as it lies now, before this program runs.
      </p>
    </div>
  {/if}
  <div class="row">
    <button class="btn pri" onclick={start} disabled={!canStart} title={errors ? 'The job has errors' : st !== 'Idle' ? 'The controller must be idle' : ''}>{resume ? `Run from ${startAt}` : 'Run program'}</button>
    {#if machine.job === 'paused' || waiting}
      <button class="btn" class:pri={waiting && tooling.pending === null} onclick={resumeProgram} disabled={waiting && st !== 'Idle'}>Resume</button>
    {:else}
      <button class="btn" onclick={() => machine.hold()} disabled={!busy}>Hold</button>
    {/if}
    <button class="btn danger" onclick={() => machine.stop()} title="Nothing more is sent, motion is held, then the controller is reset: spindle off. Not an emergency stop.">Stop</button>
  </div>
  {#if machine.lost}<p class="diag error">The controller does not answer (cable, power, network?). Nothing can be stopped from here: if the machine is moving, use its emergency stop.</p>{/if}
  {#if machine.crash}<p class="diag error">{machine.crash} (The simulator goes on; a real machine would not.)</p>{/if}
  {#if busy || waiting || machine.job === 'done' || machine.job === 'failed' || machine.job === 'stopped'}
    <div class="progress"><i style="width: {pct}%"></i></div>
    <p class="muted small">{machine.acked} / {machine.total} blocks{machine.line >= 0 ? ` · line ${machine.line + 1}` : ''}</p>
  {/if}
  {#if machine.message}<p class="diag {machine.job === 'failed' || st === 'Alarm' ? 'error' : machine.job === 'done' ? 'ok' : 'warning'}">{machine.message}</p>{/if}

  <div class="ovs">
    <div class="ov" role="group" aria-label="Feed override">
      <span>Feed</span>
      <button class="btn" aria-label="Feed −10%" onclick={() => machine.feed('feedMinus10')}>−</button>
      <button class="btn val" title="Back to 100 %" aria-label="Feed 100%" onclick={() => machine.feed('feed100')}>{machine.status?.ov?.[0] ?? 100} %</button>
      <button class="btn" aria-label="Feed +10%" onclick={() => machine.feed('feedPlus10')}>+</button>
    </div>
    <div class="ov" role="group" aria-label="Spindle override">
      <span>Spindle</span>
      <button class="btn" aria-label="Spindle −10%" onclick={() => machine.spindleOv('spindleMinus10')}>−</button>
      <button class="btn val" title="Back to 100 %" aria-label="Spindle 100%" onclick={() => machine.spindleOv('spindle100')}>{machine.status?.ov?.[2] ?? 100} %</button>
      <button class="btn" aria-label="Spindle +10%" onclick={() => machine.spindleOv('spindlePlus10')}>+</button>
    </div>
  </div>
  </div>
  <Section id="jog" title="Move by hand" open>
    <JogPanel />
  </Section>
  <Section id="console" title="Console" status={st === 'Alarm' ? 'alarm: unlock or home' : ''} tone={st === 'Alarm' ? 'err' : ''} force={st === 'Alarm'}>
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
    <div class="row">
      <button class="btn" onclick={saveLog} disabled={savingLog}>Save a log</button>
    </div>
    <p class="muted small">Everything sent and received since the page was opened, with times, the controller's settings (asked for when it is idle) and the job. For when something does not go as it should: save it before closing or reloading the page, and send it along.</p>
  </Section>
{/if}

<style>
  .which { margin: 10px 0 2px; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 8px; display: flex; flex-direction: column; gap: 6px; }
  .which select { border: 1px solid var(--line-2); border-radius: 6px; padding: 3px 6px; background: var(--panel); margin-left: 6px; max-width: 100%; }
  .ovs { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 10px 0 0; }
  .ov { display: inline-flex; align-items: center; gap: 0; font-size: 12.5px; color: var(--ink-2); }
  .ov span { margin-right: 8px; }
  .ov .btn { border-radius: 0; margin-left: -1px; padding: 3px 9px; }
  .ov .btn:first-of-type { border-radius: 6px 0 0 6px; margin-left: 0; }
  .ov .btn:last-of-type { border-radius: 0 6px 6px 0; }
  .ov .val { min-width: 58px; font-variant-numeric: tabular-nums; font-weight: 600; }
  .pad { padding: 12px 14px 14px; }
  .empty p { margin: 0 0 8px; }
  .empty .mdi { margin: 14px 0 6px; }
  .empty code { font-family: var(--mono); font-size: 11.5px; }
  .muted { color: var(--ink-3); }
  .small { font-size: 12px; }
  .grow { flex: 1; }
  .from { gap: 10px; align-items: center; margin-bottom: 6px; }
  .from select { max-width: 260px; }
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
