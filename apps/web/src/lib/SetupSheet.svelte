<script lang="ts">
  /**
   * The setup sheet: one page to print and take to the machine. What to clamp, where the zero is,
   * which tools in which order and how far out, what each operation does and how long it takes.
   */
  import { cutLines, setupSheet } from '@swarf/cam';
  import { store } from './store.svelte.ts';
  import { minutes } from './ops.ts';

  let { onClose }: { onClose: () => void } = $props();

  const job = $derived(store.job);
  const sheet = $derived(setupSheet(job, store.analysis));
  const errors = $derived(sheet.problems.filter((p) => p.severity === 'error'));
  const notes = $derived(sheet.problems.filter((p) => p.severity !== 'error'));
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

  /** The drawing: the mill from above, the lathe from the side (chuck on the left), in mm. */
  const drawing = $derived.by(() => {
    const st = job.stock;
    const lines = cutLines(store.analysis.program);
    let x0: number, x1: number, y0: number, y1: number;
    const paths: string[] = [];
    if (st.kind === 'block') {
      x0 = 0; x1 = st.x; y0 = 0; y1 = st.y;
      for (const o of job.obstacles) {
        x0 = Math.min(x0, o.x0, o.x1); x1 = Math.max(x1, o.x0, o.x1);
        y0 = Math.min(y0, o.y0, o.y1); y1 = Math.max(y1, o.y0, o.y1);
      }
      for (const l of lines) {
        for (const q of l) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
        paths.push('M' + l.map((q) => `${q.x.toFixed(2)} ${(-q.y).toFixed(2)}`).join('L'));
      }
    } else {
      const r = st.diameter / 2;
      x0 = st.front - st.stickout - 14; x1 = Math.max(st.front, 0) + 4; y0 = -r - 3; y1 = r + 3;
      for (const l of lines) {
        for (const q of l) { x0 = Math.min(x0, q.z); x1 = Math.max(x1, q.z); y1 = Math.max(y1, q.x); }
        paths.push('M' + l.map((q) => `${q.z.toFixed(2)} ${(-q.x).toFixed(2)}`).join('L'));
      }
    }
    const pad = Math.max(x1 - x0, y1 - y0) * 0.06 + 2;
    const w = x1 - x0 + 2 * pad;
    const h = y1 - y0 + 2 * pad;
    // one unit of line width, whatever the size of the job
    return { box: `${(x0 - pad).toFixed(2)} ${(-y1 - pad).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`, u: Math.max(w, h) / 420, d: paths.join(''), ratio: w / h };
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="sheet-overlay" role="dialog" aria-modal="true" aria-label="Setup sheet">
  <div class="bar">
    <strong>Setup sheet</strong>
    <span class="hint">One page for the machine. Printing uses the browser's dialog (it can also save a PDF).</span>
    <span class="grow"></span>
    <button class="btn pri" onclick={() => window.print()}>Print</button>
    <button class="btn" onclick={onClose}>Close</button>
  </div>

  <article class="sheet">
    <header>
      <div>
        <h1>{sheet.name}</h1>
        <p class="sub">{sheet.machine} · {sheet.material} · {today}</p>
      </div>
      <div class="time">
        <span class="big">{minutes(sheet.seconds)}</span>
        <span class="sub">cutting and moving{sheet.stops ? `, plus ${sheet.stops} stop${sheet.stops === 1 ? '' : 's'} for a tool` : ''}</span>
      </div>
    </header>

    {#if errors.length}
      <div class="warn err">
        <strong>Do not run this job: the checks found {errors.length} error{errors.length === 1 ? '' : 's'}.</strong>
        {#each errors as p, i (i)}<p>{p.message}</p>{/each}
      </div>
    {/if}

    <div class="two">
      <div>
        <h2>Stock</h2>
        <ul>{#each sheet.stock as l, i (i)}<li>{l}</li>{/each}<li>{sheet.material}</li></ul>
        <h2>Zero</h2>
        <ul>{#each sheet.zero as l, i (i)}<li>{l}</li>{/each}</ul>
        <h2>Holding</h2>
        <ul>{#each sheet.holding as l, i (i)}<li>{l}</li>{/each}</ul>
        {#if sheet.notes}
          <h2>Notes</h2>
          <p class="notes">{sheet.notes}</p>
        {/if}
      </div>
      <figure style:--ratio={drawing.ratio}>
        <svg viewBox={drawing.box} role="img" aria-label={sheet.kind === 'mill' ? 'The job from above' : 'The job from the side'}>
          {#if job.stock.kind === 'block'}
            <rect class="stock" x="0" y={-job.stock.y} width={job.stock.x} height={job.stock.y} stroke-width={drawing.u * 1.6} />
            {#each job.obstacles as o, i (i)}
              <rect class="clamp" x={Math.min(o.x0, o.x1)} y={-Math.max(o.y0, o.y1)} width={Math.abs(o.x1 - o.x0)} height={Math.abs(o.y1 - o.y0)} stroke-width={drawing.u} />
              <text class="tag" x={(o.x0 + o.x1) / 2} y={-(o.y0 + o.y1) / 2} font-size={drawing.u * 11} text-anchor="middle" dominant-baseline="central">{o.name}</text>
            {/each}
          {:else}
            {@const r = job.stock.diameter / 2}
            {@const jaws = job.stock.front - job.stock.stickout}
            <rect class="clamp" x={jaws - 12} y={-r - 2.5} width="12" height={2 * r + 5} stroke-width={drawing.u} />
            <text class="tag" x={jaws - 6} y="0" font-size={drawing.u * 11} text-anchor="middle" dominant-baseline="central" transform="rotate(-90 {jaws - 6} 0)">chuck</text>
            <rect class="stock" x={jaws} y={-r} width={job.stock.stickout} height={2 * r} stroke-width={drawing.u * 1.6} />
            <line class="axis" x1={jaws - 14} y1="0" x2={Math.max(job.stock.front, 0) + 4} y2="0" stroke-width={drawing.u * 0.8} stroke-dasharray="{drawing.u * 8} {drawing.u * 3} {drawing.u * 1.5} {drawing.u * 3}" />
          {/if}
          <path class="cuts" d={drawing.d} stroke-width={drawing.u * 0.9} />
          <!-- the zero -->
          <g class="zero" stroke-width={drawing.u * 1.6}>
            <circle cx="0" cy="0" r={drawing.u * 7} />
            <line x1={-drawing.u * 11} y1="0" x2={drawing.u * 11} y2="0" />
            <line x1="0" y1={-drawing.u * 11} x2="0" y2={drawing.u * 11} />
          </g>
        </svg>
        <figcaption>
          {sheet.kind === 'mill' ? 'From above: X to the right, Y away from you.' : 'From the side: the chuck on the left, Z to the right.'}
          The cross is the zero; the thin lines are the cuts.
          {#if sheet.travel}
            {#if sheet.kind === 'mill'}
              The tool moves within X {n1(sheet.travel.min.x)} to {n1(sheet.travel.max.x)}, Y {n1(sheet.travel.min.y)} to {n1(sheet.travel.max.y)}, Z {n1(sheet.travel.min.z)} to {n1(sheet.travel.max.z)}.
            {:else}
              The tool moves within Z {n1(sheet.travel.min.z)} to {n1(sheet.travel.max.z)}, out to Ø{n1(sheet.travel.max.x * 2)}.
            {/if}
          {/if}
        </figcaption>
      </figure>
    </div>

    <h2>Tools, in the order the program asks for them</h2>
    {#if sheet.tools.length}
      <table>
        <thead><tr><th class="box"></th><th>Tool</th><th>What</th><th>Reach</th>{#if sheet.tools.some((t) => t.offset)}<th>Stored offset</th>{/if}<th>For</th><th class="r">Time</th></tr></thead>
        <tbody>
          {#each sheet.tools as t (t.id)}
            <tr>
              <td class="box"><i></i></td>
              <td><strong>T{t.id}</strong> {t.name}</td>
              <td>{t.what}</td>
              <td>{t.reach || '–'}</td>
              {#if sheet.tools.some((x) => x.offset)}<td>{t.offset || 'touch off'}</td>{/if}
              <td>{t.ops.map((n) => `#${n}`).join(' ')}</td>
              <td class="r">{minutes(t.seconds)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="sub">No operations yet: nothing to set up.</p>
    {/if}

    {#if sheet.ops.length}
      <h2>Operations</h2>
      <table>
        <thead><tr><th class="r">#</th><th>Operation</th><th>Tool</th><th class="r">rpm</th><th class="r">Feed, mm/min</th><th>Deepest</th><th class="r">Time</th></tr></thead>
        <tbody>
          {#each sheet.ops as o, i (i)}
            <tr><td class="r">{o.n}</td><td>{o.label}</td><td>T{o.tool}</td><td class="r">{Math.round(o.rpm)}</td><td class="r">{o.feed ? Math.round(o.feed) : '–'}</td><td>{o.deepest || '–'}</td><td class="r">{minutes(o.seconds)}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if notes.length}
      <h2>The checks note</h2>
      <ul>{#each notes as p, i (i)}<li>{p.message}</li>{/each}</ul>
    {/if}

    <footer>
      The program stops before the first move and at every tool change, and goes on with Resume. Times are an estimate from the controller's acceleration; pauses are not counted. Made with swarf from the job as it was on {today}: if the job changes, print again.
    </footer>
  </article>
</div>

<style>
  .sheet-overlay { position: fixed; inset: 0; z-index: 50; background: rgba(20, 26, 23, 0.6); overflow: auto; padding: 0 12px 32px; }
  .bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px; max-width: 210mm; margin: 0 auto 10px; padding: 8px 12px; color: #f3f4f1; background: #1f2623; border-radius: 0 0 8px 8px; }
  .bar .btn:not(.pri) { background: transparent; color: inherit; border-color: rgba(255, 255, 255, 0.3); }
  .bar .hint { font-size: 12.5px; opacity: 0.8; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grow { flex: 1; }
  /* paper: black on white whatever the app's theme */
  .sheet { max-width: 210mm; margin: 0 auto; background: #fff; color: #16191a; padding: 14mm 14mm 10mm; border-radius: 3px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4); font-size: 12.5px; line-height: 1.4; }
  header { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; border-bottom: 2px solid #16191a; padding-bottom: 8px; margin-bottom: 4px; }
  h1 { margin: 0; font-size: 24px; line-height: 1.15; }
  .sub { margin: 2px 0 0; color: #565d5f; font-size: 12px; }
  .time { text-align: right; display: flex; flex-direction: column; flex: none; }
  .big { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin: 14px 0 4px; color: #565d5f; }
  ul { margin: 0; padding-left: 16px; }
  li { margin: 1px 0; }
  .notes { margin: 0; white-space: pre-wrap; }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 18px; align-items: start; }
  figure { margin: 14px 0 0; }
  svg { display: block; width: 100%; max-height: 78mm; aspect-ratio: var(--ratio); border: 1px solid #c9cdca; border-radius: 3px; background: #fafaf8; }
  .stock { fill: #e9ebe6; stroke: #16191a; }
  .clamp { fill: #c6cbc8; stroke: #565d5f; }
  .tag { fill: #2d3334; font-family: inherit; }
  .axis { stroke: #565d5f; fill: none; }
  .cuts { fill: none; stroke: #b4530a; stroke-linejoin: round; stroke-linecap: round; }
  .zero { fill: none; stroke: #16191a; }
  figcaption { font-size: 11px; color: #565d5f; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-size: 11px; font-weight: 600; color: #565d5f; border-bottom: 1px solid #16191a; padding: 3px 12px 3px 0; }
  td { border-bottom: 1px solid #d9dcd9; padding: 4px 12px 4px 0; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  th:last-child, td:last-child { padding-right: 0; }
  .box { width: 18px; }
  .box i { display: block; width: 11px; height: 11px; border: 1.2px solid #16191a; border-radius: 2px; margin-top: 2px; }
  .warn { border: 1.5px solid #b3261e; color: #8c1d18; border-radius: 4px; padding: 6px 10px; margin-top: 10px; }
  .warn p { margin: 2px 0 0; }
  footer { margin-top: 16px; padding-top: 6px; border-top: 1px solid #c9cdca; font-size: 10.5px; color: #565d5f; }
  @media (max-width: 640px) {
    .two { grid-template-columns: 1fr; }
    .sheet { padding: 18px 14px; }
    .bar .hint { display: none; }
    header { flex-direction: column; align-items: flex-start; }
    .time { text-align: left; }
    table { display: block; overflow-x: auto; }
  }
  @media print {
    :global(.app) { display: none !important; }
    :global(html), :global(body) { background: #fff !important; height: auto !important; overflow: visible !important; }
    .sheet-overlay { position: static; background: none; padding: 0; overflow: visible; }
    .bar { display: none; }
    .sheet { box-shadow: none; padding: 0; max-width: none; border-radius: 0; }
    tr, figure, .warn { break-inside: avoid; }
    @page { size: A4; margin: 14mm; }
  }
</style>
