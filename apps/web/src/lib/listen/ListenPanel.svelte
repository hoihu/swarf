<script lang="ts">
  /** Listening to the cut with the microphone: is it chatter, and which spindle speed to try. */
  import { onDestroy } from 'svelte';
  import { listening } from './listen.svelte.ts';
  import { machine } from '../machine.svelte.ts';
  import { store } from '../store.svelte.ts';

  let canvas = $state<HTMLCanvasElement | null>(null);
  let raf = 0;
  const lathe = $derived(store.job.machine.kind === 'lathe');
  const ov = $derived(machine.status?.ov?.[2] ?? 100);
  const kHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`);
  const TOP = 6000;

  function draw(): void {
    raf = requestAnimationFrame(draw);
    const c = canvas;
    const s = listening.spectrum;
    const h = listening.heard;
    if (!c || !s || !h) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const ht = (c.height = c.clientHeight * devicePixelRatio);
    const g = c.getContext('2d')!;
    const css = getComputedStyle(c);
    g.clearRect(0, 0, w, ht);
    const x = (hz: number) => (hz / TOP) * w;
    const y = (db: number) => ht - Math.max(0, Math.min(1, (db - h.floor + 6) / 66)) * ht;
    // where the teeth's sound belongs
    if (h.turning) {
      g.strokeStyle = css.getPropertyValue('--line-2');
      g.lineWidth = devicePixelRatio;
      const tooth = h.turning * listening.teeth;
      for (let k = 1; k * tooth < TOP && k <= 40 && tooth > 40; k++) {
        g.beginPath();
        g.moveTo(x(k * tooth), 0);
        g.lineTo(x(k * tooth), ht);
        g.stroke();
      }
    }
    g.strokeStyle = css.getPropertyValue('--ink-2');
    g.lineWidth = 1.2 * devicePixelRatio;
    g.beginPath();
    const n = Math.min(s.db.length, Math.ceil(TOP / s.binHz));
    for (let i = 1; i < n; i++) {
      const px = x(i * s.binHz);
      const py = y(s.db[i] as number);
      if (i === 1) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
    if (h.stray && h.state === 'chatter') {
      g.fillStyle = css.getPropertyValue('--err');
      g.beginPath();
      g.arc(x(h.stray.hz), y(h.stray.db), 4 * devicePixelRatio, 0, 2 * Math.PI);
      g.fill();
    }
  }
  $effect(() => {
    cancelAnimationFrame(raf);
    if (listening.on && canvas) raf = requestAnimationFrame(draw);
  });
  onDestroy(() => cancelAnimationFrame(raf));
</script>

<section class="listen">
  <details class="how"><summary>How this works</summary><p class="muted small">A microphone near the machine (the laptop's will do) tells a clean cut from chatter: chatter rings at a pitch of its own, between the multiples of the rate the teeth meet the work. When it hears one, it works out the spindle speeds at which the teeth fall in step with the ring, where it usually dies down.</p></details>
  <div class="row">
    {#if listening.on}
      <button class="btn" onclick={() => listening.stop()}>Stop listening</button>
      <button class="btn" onclick={() => listening.learnAir()} title="With the spindle running and nothing cutting: what is heard now (the spindle, a pump, the drive's whine) is left out from then on">This is the machine in air</button>
      {#if listening.air.length}<button class="link" onclick={() => listening.forgetAir()}>forget ({listening.air.length} tones)</button>{/if}
    {:else}
      <button class="btn" onclick={() => listening.start()}>Listen</button>
    {/if}
    {#if !lathe}
      <label class="small">Teeth
        <select value={listening.teethSet ?? ''} onchange={(e) => (listening.teethSet = Number((e.currentTarget as HTMLSelectElement).value) || null)}>
          <option value="">from the tool ({listening.teeth})</option>
          {#each [1, 2, 3, 4, 5, 6] as z (z)}<option value={z}>{z}</option>{/each}
        </select>
      </label>
    {/if}
  </div>
  {#if listening.error}<p class="diag error">{listening.error}</p>{/if}
  {#if listening.on}
    <canvas bind:this={canvas} aria-label="What the microphone hears, 0 to 6 kHz; the lines are where the teeth's own sound lies"></canvas>
    <p class="small now" class:bad={listening.state === 'chatter'}>
      {#if listening.rpm <= 0}The spindle is not running (or the controller does not report its speed): nothing to judge against.
      {:else if listening.state === 'chatter' && listening.hz}<b>Chatter</b>, ringing at {kHz(listening.hz)}.
      {:else if listening.state === 'cutting'}Cutting; no ring.
      {:else}Quiet.{/if}
      {#if listening.heardRpm}<span class="muted"> The teeth sound like {listening.heardRpm} rpm, not the {listening.rpm} reported.</span>{/if}
    </p>
  {/if}
  {#if listening.last}
    {@const l = listening.last}
    {@const tries = listening.suggestions}
    <div class="ring">
      <p class="small"><b>A ring at {kHz(l.hz)}</b> was heard at {l.rpm} rpm with {l.teeth} {l.teeth === 1 ? 'cutting edge' : 'teeth'}.
        {#if tries.length}Speeds in step with it:{:else}No speed in step with it is within reach: change the speed by a tenth either way and listen again; if it stays, it is the depth of cut, the stick-out or the holding.{/if}
      </p>
      {#if tries.length}
        <div class="row">
          {#each tries as t (t.rpm)}
            <button class="btn" disabled={!machine.connected || t.percent < 10 || t.percent > 200} onclick={() => listening.setOverride(t.percent)} title="Sets the controller's spindle speed override; the feed stays, so the chip gets thicker when the spindle slows">{t.rpm} rpm ({t.percent} %)</button>
          {/each}
          <button class="link" onclick={() => (listening.last = null)}>dismiss</button>
        </div>
        <p class="muted small">The buttons set the spindle override (now {ov} %); it is back at 100 % after a reset. If the ring only moves to another pitch, the cut is too heavy for this setup: less depth or width, a shorter tool, better holding.</p>
      {/if}
    </div>
  {/if}
  {#if machine.connected && ov !== 100}
    <p class="small">Spindle override {ov} %. <button class="link" onclick={() => machine.spindleOv('spindle100')}>Back to 100 %</button></p>
  {/if}
</section>

<style>
  .how summary { cursor: pointer; color: var(--link); font-size: 12.5px; font-weight: 600; }
  .how p { margin-top: 6px; }
  .listen { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .small { font-size: 12.5px; margin: 0; }
  .muted { color: var(--ink-3); }
  canvas { width: 100%; height: 90px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; }
  .now.bad { color: var(--err); }
  .ring { border: 1px solid var(--warn); background: var(--warn-soft); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .link { border: 0; background: none; padding: 0; color: var(--link); font-weight: 600; text-decoration: underline; }
  select { border: 1px solid var(--line-2); border-radius: 6px; padding: 3px 6px; background: var(--panel); }
  .diag.error { background: var(--err-soft); color: var(--err); margin: 0; padding: 6px 9px; border-radius: 6px; font-size: 12.5px; }
</style>
