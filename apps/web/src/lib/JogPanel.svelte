<script lang="ts">
  /**
   * Moving the machine by hand: steps or hold-to-move per axis (jog.ts), setting the work zero
   * where the tool is, and the spindle. Only while the controller is idle (or jogging) and no
   * program lines are under way: so also at a tool change, when the program waits.
   */
  import { onDestroy } from 'svelte';
  import { Jogger, type JogAxis } from './jog.ts';
  import { machine } from './machine.svelte.ts';
  import { probe } from './probe.svelte.ts';
  import { camera } from './camera/camera.svelte.ts';
  import { laserScan } from './camera/laserscan.svelte.ts';
  import { store } from './store.svelte.ts';

  const jog = new Jogger({ request: (l) => machine.request(l), cancel: () => machine.jogCancel() });
  const lathe = $derived(store.job.machine.kind === 'lathe');
  const dia = $derived(lathe && store.job.machine.xMode === 'diameter');
  const st = $derived(machine.status?.state ?? 'Unknown');
  // a routine that moves the machine itself is under way (touching, the camera's moves, the laser sweep)
  const routine = $derived(probe.busy || camera.busy || laserScan.busy);
  const free = $derived(machine.connected && !machine.lost && (st === 'Idle' || st === 'Jog') && machine.job !== 'running' && machine.job !== 'paused' && !routine);

  const STEPS = [0.01, 0.1, 1, 10] as const;
  /** A step length, or 0: move for as long as the button is held. */
  let step = $state<number>(1);
  const feeds = $derived([50, 200, 800, 2000].filter((f) => f <= store.job.machine.maxFeed));
  let feed = $state(800);
  let keys = $state(false);
  let error = $state('');
  let rpm = $state(0);
  $effect(() => {
    if (!rpm) rpm = Math.min(Math.max(1000, store.job.machine.minRpm), store.job.machine.maxRpm);
  });
  const spinning = $derived((machine.status?.spindle ?? 0) > 0);
  let setTo = $state<Record<JogAxis, number>>({ X: 0, Y: 0, Z: 0 });
  const axes = $derived<JogAxis[]>(lathe ? ['X', 'Z'] : ['X', 'Y', 'Z']);

  async function press(axis: JogAxis, dir: 1 | -1): Promise<void> {
    if (!free) return;
    error = '';
    const f = Math.min(feed, store.job.machine.maxFeed);
    if (step > 0) await jog.step(axis, dir, step, f);
    else await jog.hold(axis, dir, f);
    error = jog.error;
  }
  const release = () => jog.release();

  // whatever happens to the pointer, the key or the page: let go
  $effect(() => {
    const off = () => jog.release();
    window.addEventListener('blur', off);
    window.addEventListener('pointerup', off);
    window.addEventListener('pointercancel', off);
    document.addEventListener('visibilitychange', off);
    return () => {
      window.removeEventListener('blur', off);
      window.removeEventListener('pointerup', off);
      window.removeEventListener('pointercancel', off);
      document.removeEventListener('visibilitychange', off);
    };
  });
  onDestroy(() => jog.release());
  // the machine stopped being free under a held button (alarm, a program started): let go
  $effect(() => {
    if (!free) jog.release();
  });

  /** Arrow keys (and Page Up/Down): which axis and way. On the lathe ← → is Z, ↑ is X− (into the work with a front tool post). */
  const keymap = $derived<Record<string, [JogAxis, 1 | -1]>>(
    lathe
      ? { ArrowLeft: ['Z', -1], ArrowRight: ['Z', 1], ArrowUp: ['X', -1], ArrowDown: ['X', 1] }
      : { ArrowLeft: ['X', -1], ArrowRight: ['X', 1], ArrowUp: ['Y', 1], ArrowDown: ['Y', -1], PageUp: ['Z', 1], PageDown: ['Z', -1] },
  );
  let keyDown = '';
  $effect(() => {
    if (!keys) return;
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return jog.release();
      const k = keymap[e.key];
      if (!k || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      // a held key repeats: one step, or one hold, per press
      if (e.repeat || keyDown) return;
      keyDown = e.key;
      void press(k[0], k[1]);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== keyDown) return;
      keyDown = '';
      jog.release();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      keyDown = '';
      jog.release();
    };
  });

  async function setZero(axis: JogAxis): Promise<void> {
    const v = Number(setTo[axis]);
    if (!Number.isFinite(v)) return;
    const what = axis === 'X' && dia ? `Ø${v}` : `${v}`;
    if (!confirm(`Make this position ${axis} = ${what} of the work zero (G54)?\n\nEverything the program does moves with it.`)) return;
    error = '';
    const r = await machine.request(`G10 L20 P1 ${axis}${v.toFixed(3)}`);
    if (!r.ok) error = r.message ?? 'The controller refused it.';
  }

  async function spindle(on: boolean): Promise<void> {
    error = '';
    if (on) {
      const m = store.job.machine;
      const s = Math.round(Math.min(Math.max(Number(rpm) || 0, m.minRpm), m.maxRpm));
      if (!confirm(`Start the spindle at ${s} rpm?\n\nChuck key out, nothing loose, hands clear.`)) return;
      rpm = s;
      const r = await machine.request(`M3 S${s}`);
      if (!r.ok) error = r.message ?? 'The controller refused it.';
    } else {
      const r = await machine.request('M5');
      if (!r.ok) error = r.message ?? 'The controller refused it.';
    }
  }

  const label = (axis: JogAxis, dir: 1 | -1) => `${axis}${dir > 0 ? '+' : '−'}`;
</script>

{#snippet key(axis: JogAxis, dir: 1 | -1)}
  <button
    class="btn jog"
    disabled={!free}
    aria-label="Jog {axis} {dir > 0 ? 'plus' : 'minus'}"
    onpointerdown={(e) => { if (e.button === 0) void press(axis, dir); }}
    onpointerleave={() => { if (step === 0) release(); }}
    onkeydown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) void press(axis, dir); }}
    onkeyup={(e) => { if (e.key === ' ' || e.key === 'Enter') release(); }}
    oncontextmenu={(e) => e.preventDefault()}
  >{label(axis, dir)}</button>
{/snippet}

<section class="jogpanel" aria-label="Move by hand">
  <h4>Move by hand</h4>
  <div class="pads">
    {#if lathe}
      <div class="pad lathe">
        <span></span>{@render key('X', -1)}<span></span>
        {@render key('Z', -1)}<span class="mid">{step ? `${step} mm` : 'hold'}</span>{@render key('Z', 1)}
        <span></span>{@render key('X', 1)}<span></span>
      </div>
    {:else}
      <div class="pad">
        <span></span>{@render key('Y', 1)}<span></span>
        {@render key('X', -1)}<span class="mid">{step ? `${step} mm` : 'hold'}</span>{@render key('X', 1)}
        <span></span>{@render key('Y', -1)}<span></span>
      </div>
      <div class="zpad">{@render key('Z', 1)}{@render key('Z', -1)}</div>
    {/if}
    <div class="opts">
      <div class="seg" role="radiogroup" aria-label="Step">
        {#each STEPS as s (s)}<button class="btn" class:on={step === s} role="radio" aria-checked={step === s} onclick={() => (step = s)}>{s}</button>{/each}
        <button class="btn" class:on={step === 0} role="radio" aria-checked={step === 0} onclick={() => (step = 0)} title="Moves for as long as the button (or key) is held">Hold</button>
      </div>
      <label class="small">Feed
        <select bind:value={feed}>{#each feeds as f (f)}<option value={f}>{f} mm/min</option>{/each}</select>
      </label>
      <label class="small"><input type="checkbox" bind:checked={keys} /> Keyboard: {lathe ? '← → Z, ↑ X−, ↓ X+' : '← → X, ↑ ↓ Y, PgUp/PgDn Z'}; Esc lets go</label>
    </div>
  </div>
  {#if dia}<p class="muted small">X steps are on the diameter, as the controller counts them (G7): a step of 1 moves the tool 0.5 mm.</p>{/if}
  {#if !free && machine.connected}<p class="muted small">{machine.job === 'running' || machine.job === 'paused' ? 'Not while the program runs (at a tool change it waits: then yes).' : routine ? 'Not while a touching or camera routine moves the machine.' : `The controller must be idle (it is in ${st}).`}</p>{/if}

  <div class="zero">
    {#each axes as a (a)}
      <label class="small">{a}{a === 'X' && dia ? ' Ø' : ''} here is
        <input type="number" step="0.01" bind:value={setTo[a]} disabled={!free} />
        <button class="btn" disabled={!free || st !== 'Idle'} onclick={() => setZero(a)}>Set</button>
      </label>
    {/each}
  </div>

  <div class="spin">
    <label class="small">Spindle <input type="number" step="50" min={store.job.machine.minRpm} max={store.job.machine.maxRpm} bind:value={rpm} disabled={!free} /> rpm</label>
    <button class="btn" disabled={!free || st !== 'Idle' || spinning} onclick={() => spindle(true)}>On</button>
    <button class="btn" disabled={!machine.connected || machine.job === 'running' || machine.job === 'paused'} onclick={() => spindle(false)}>Off</button>
    {#if spinning}<span class="small warn">running, {machine.status?.spindle} rpm</span>{/if}
  </div>
  {#if error}<p class="diag error">{error}</p>{/if}
</section>

<style>
  .jogpanel { margin: 12px 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; }
  h4 { margin: 0 0 8px; font-size: 13px; }
  .pads { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
  .pad { display: grid; grid-template-columns: repeat(3, 46px); grid-auto-rows: 40px; gap: 4px; }
  .zpad { display: grid; grid-template-columns: 46px; grid-auto-rows: 40px; gap: 4px; align-content: space-between; height: 128px; }
  .jog { font-family: var(--mono); font-weight: 700; padding: 0; touch-action: none; user-select: none; }
  .jog:active:not(:disabled) { background: var(--accent); color: #fff; }
  .mid { display: grid; place-items: center; font-size: 11px; color: var(--ink-3); }
  .opts { display: flex; flex-direction: column; gap: 6px; min-width: 190px; flex: 1; }
  .seg { display: flex; gap: 0; }
  .seg .btn { border-radius: 0; margin-left: -1px; padding: 3px 9px; font-size: 12px; }
  .seg .btn:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
  .seg .btn:last-child { border-radius: 0 6px 6px 0; }
  .seg .btn.on { background: var(--accent); color: #fff; border-color: var(--accent); position: relative; }
  .small { font-size: 12px; }
  .muted { color: var(--ink-3); margin: 6px 0 0; }
  .warn { color: var(--warn); }
  .zero, .spin { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; margin-top: 10px; }
  .zero input, .spin input { width: 74px; border: 1px solid var(--line-2); border-radius: 6px; padding: 3px 6px; font-family: var(--mono); font-size: 12px; background: var(--panel); }
  select { border: 1px solid var(--line-2); border-radius: 6px; padding: 2px 4px; font-size: 12px; background: var(--panel); }
  .diag { margin: 8px 0 0; padding: 6px 9px; border-radius: 6px; font-size: 12.5px; }
  .diag.error { background: var(--err-soft); color: var(--err); }
</style>
