<script lang="ts">
  import { EXAMPLES, Job, Operation, Tool, emptyJob, opLabel, withIds, type Stock } from '@swarf/cam';
  import { z } from 'zod';
  import { store } from './store.svelte.ts';
  import { OP_TEMPLATES } from './ops.ts';

  type Tab = 'ops' | 'stock' | 'tools' | 'gcode';
  let tab = $state<Tab>('ops');

  const job = $derived(store.job);
  const diags = $derived(store.analysis.diagnostics);
  const errorsByOp = $derived(new Map(job.operations.map((o) => [o.id!, diags.filter((d) => d.opId === o.id)])));
  const jobLevel = $derived(diags.filter((d) => !d.opId));

  // ---- operation editing (JSON for now; forms are tier 2)
  let editing = $state<string | null>(null);
  let draft = $state('');
  let draftError = $state('');

  function edit(id: string): void {
    const op = job.operations.find((o) => o.id === id);
    if (!op) return;
    editing = id;
    draft = JSON.stringify(op, null, 2);
    draftError = '';
  }

  function saveEdit(): void {
    let value: unknown;
    try {
      value = JSON.parse(draft);
    } catch (e) {
      draftError = `Not valid JSON: ${(e as Error).message}`;
      return;
    }
    const op = Operation.safeParse(value);
    if (!op.success) {
      draftError = op.error.issues.map((i) => `${i.path.join('.') || 'operation'}: ${i.message}`).join('\n');
      return;
    }
    const ops = job.operations.map((o) => (o.id === editing ? { ...op.data, id: editing } : o));
    store.set({ ...job, operations: ops });
    editing = null;
  }

  function addOp(make: () => unknown): void {
    const op = Operation.parse(make());
    const ops = withIds([...job.operations, op]);
    store.set({ ...job, operations: ops });
    const id = ops.at(-1)!.id!;
    store.selected = id;
    edit(id);
  }

  function move(id: string, by: number): void {
    const ops = [...job.operations];
    const i = ops.findIndex((o) => o.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ops.length) return;
    [ops[i], ops[j]] = [ops[j]!, ops[i]!];
    store.set({ ...job, operations: ops });
  }

  function remove(id: string): void {
    store.set({ ...job, operations: job.operations.filter((o) => o.id !== id) });
    if (store.selected === id) store.selected = null;
    if (editing === id) editing = null;
  }

  // ---- stock
  function setStock(patch: Partial<Record<string, number>>): void {
    const next = { ...job.stock, ...patch } as Stock;
    const parsed = Job.safeParse({ ...job, stock: next });
    if (parsed.success) store.set(parsed.data);
  }
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);

  function start(kind: 'lathe' | 'mill', example: boolean): void {
    store.replace(example ? EXAMPLES[kind]() : emptyJob(kind));
    editing = null;
  }

  // ---- tools (JSON for now)
  let toolDraft = $state('');
  let toolError = $state('');
  let toolEditing = $state(false);
  function editTools(): void {
    toolDraft = JSON.stringify(job.tools, null, 2);
    toolError = '';
    toolEditing = true;
  }
  function saveTools(): void {
    try {
      const tools = z.array(Tool).safeParse(JSON.parse(toolDraft));
      if (!tools.success) {
        toolError = tools.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
        return;
      }
      store.set({ ...job, tools: tools.data });
      toolEditing = false;
    } catch (e) {
      toolError = `Not valid JSON: ${(e as Error).message}`;
    }
  }

  // ---- G-code
  function download(): void {
    const blob = new Blob([store.gcode.text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${job.name.replace(/[^\w.-]+/g, '_') || 'job'}.nc`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const gcodeLines = $derived(store.gcode.text.split('\n'));
  const toolName = (id: number) => job.tools.find((t) => t.id === id)?.name ?? `T${id} (missing)`;
</script>

<section class="panel">
  <div class="tabs" role="tablist">
    {#each [['ops', 'Operations'], ['stock', 'Stock'], ['tools', 'Tools'], ['gcode', 'G-code']] as [id, name] (id)}
      <button role="tab" aria-selected={tab === id} class:on={tab === id} onclick={() => (tab = id as Tab)}>
        {name}
        {#if id === 'ops' && diags.some((d) => d.severity === 'error')}<span class="dot err" title="Has errors"></span>{/if}
      </button>
    {/each}
  </div>

  <div class="body">
    {#if tab === 'ops'}
      {#each jobLevel as d, i (i)}
        <p class="diag {d.severity}">{d.message}</p>
      {/each}
      {#if !job.operations.length}
        <div class="empty">
          <p>No operations yet.</p>
          <p class="muted">Describe the part in the chat, or add an operation below.</p>
        </div>
      {/if}
      <ol class="ops">
        {#each job.operations as op, i (op.id)}
          {@const ds = errorsByOp.get(op.id!) ?? []}
          <li class:sel={store.selected === op.id}>
            <button class="op" onclick={() => (store.selected = store.selected === op.id ? null : op.id!)}>
              <span class="n">{i + 1}</span>
              <span class="what">
                <span class="label">{opLabel(op)}</span>
                <span class="sub">T{op.tool} · {toolName(op.tool)}</span>
              </span>
              {#if ds.some((d) => d.severity === 'error')}<span class="badge err">error</span>
              {:else if ds.length}<span class="badge warn">note</span>{/if}
            </button>
            {#if store.selected === op.id}
              <div class="detail">
                {#each ds as d, k (k)}<p class="diag {d.severity}">{d.message}</p>{/each}
                {#if editing === op.id}
                  <textarea class="code" rows="10" bind:value={draft} spellcheck="false"></textarea>
                  {#if draftError}<pre class="diag error">{draftError}</pre>{/if}
                  <div class="row">
                    <button class="btn pri" onclick={saveEdit}>Save</button>
                    <button class="btn" onclick={() => (editing = null)}>Cancel</button>
                  </div>
                {:else}
                  <div class="row">
                    <button class="btn" onclick={() => edit(op.id!)}>Edit values</button>
                    <button class="btn" disabled={i === 0} onclick={() => move(op.id!, -1)} aria-label="Move up">Up</button>
                    <button class="btn" disabled={i === job.operations.length - 1} onclick={() => move(op.id!, 1)} aria-label="Move down">Down</button>
                    <button class="btn danger" onclick={() => remove(op.id!)}>Remove</button>
                  </div>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
      <details class="add">
        <summary>Add an operation</summary>
        <div class="grid">
          {#each OP_TEMPLATES[job.machine.kind] as t (t.type)}
            <button class="btn" onclick={() => addOp(t.make)}>{t.name}</button>
          {/each}
        </div>
      </details>
    {:else if tab === 'stock'}
      <h3>Machine</h3>
      <p class="muted">{job.machine.name}: {job.machine.kind}, {job.machine.minRpm}–{job.machine.maxRpm} rpm, feed up to {job.machine.maxFeed} mm/min.</p>
      <div class="grid">
        <button class="btn" onclick={() => start('lathe', true)}>Lathe example</button>
        <button class="btn" onclick={() => start('mill', true)}>Mill example</button>
        <button class="btn" onclick={() => start('lathe', false)}>Empty lathe job</button>
        <button class="btn" onclick={() => start('mill', false)}>Empty mill job</button>
      </div>
      <h3>Stock</h3>
      {#if job.stock.kind === 'bar'}
        <label>Bar diameter <input type="number" step="0.5" min="1" value={job.stock.diameter} onchange={(e) => setStock({ diameter: num(e) })} /> mm</label>
        <label>Out of the chuck <input type="number" step="1" min="1" value={job.stock.stickout} onchange={(e) => setStock({ stickout: num(e) })} /> mm</label>
        <label>Raw face at Z <input type="number" step="0.1" value={job.stock.front} onchange={(e) => setStock({ front: num(e) })} /> mm</label>
        <p class="muted">Z0 is the finished front face; facing removes what sits in front of it.</p>
      {:else}
        <label>Length X <input type="number" step="1" min="1" value={job.stock.x} onchange={(e) => setStock({ x: num(e) })} /> mm</label>
        <label>Width Y <input type="number" step="1" min="1" value={job.stock.y} onchange={(e) => setStock({ y: num(e) })} /> mm</label>
        <label>Height Z <input type="number" step="0.5" min="0.5" value={job.stock.z} onchange={(e) => setStock({ z: num(e) })} /> mm</label>
        <label>Raw top at Z <input type="number" step="0.1" value={job.stock.top} onchange={(e) => setStock({ top: num(e) })} /> mm</label>
        <p class="muted">X0 Y0 is the front-left corner of the block, Z0 the top after facing.</p>
      {/if}
      <label class="wide">Material <input type="text" value={job.material ?? ''} placeholder="e.g. aluminium 6082" onchange={(e) => store.set({ ...job, material: (e.currentTarget as HTMLInputElement).value || undefined })} /></label>
    {:else if tab === 'tools'}
      {#if toolEditing}
        <textarea class="code" rows="18" bind:value={toolDraft} spellcheck="false"></textarea>
        {#if toolError}<pre class="diag error">{toolError}</pre>{/if}
        <div class="row">
          <button class="btn pri" onclick={saveTools}>Save tools</button>
          <button class="btn" onclick={() => (toolEditing = false)}>Cancel</button>
        </div>
      {:else}
        <table class="tools">
          <thead><tr><th>T</th><th>Tool</th><th>Cutting data</th></tr></thead>
          <tbody>
            {#each job.tools as t (t.id)}
              <tr>
                <td class="t">{t.id}</td>
                <td>{t.name}<span class="sub">{t.type}{t.diameter ? `, Ø${t.diameter}` : ''}{t.width ? `, ${t.width} mm wide` : ''}</span></td>
                <td class="data">vc {t.vc} m/min{t.chipload ? `, ${t.chipload} mm/tooth` : ''}{t.feedPerRev ? `, ${t.feedPerRev} mm/rev` : ''}{t.maxDoc ? `, ${t.maxDoc} mm/pass` : ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <button class="btn" onclick={editTools}>Edit tool table</button>
      {/if}
    {:else}
      <div class="row">
        <button class="btn pri" onclick={download} disabled={store.analysis.diagnostics.some((d) => d.severity === 'error')} title="Fix errors before downloading">Download .nc</button>
        <span class="muted">{gcodeLines.length} lines</span>
      </div>
      {#if store.analysis.diagnostics.some((d) => d.severity === 'error')}
        <p class="diag error">The job has errors; fix them before running this on the machine.</p>
      {/if}
      <pre class="gcode">{#each gcodeLines as line, i (i)}<span class="ln">{i + 1}</span><span class:cm={line.startsWith('(')}>{line}</span>
{/each}</pre>
    {/if}
  </div>
</section>

<style>
  .panel { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--panel); }
  .tabs { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid var(--line); flex: none; }
  .tabs button { border: 0; background: none; padding: 8px 10px; font-weight: 600; color: var(--ink-3); border-bottom: 2px solid transparent; margin-bottom: -1px; display: inline-flex; align-items: center; gap: 6px; }
  .tabs button.on { color: var(--ink); border-bottom-color: var(--accent); }
  .tabs button:hover { color: var(--ink); }
  .dot { width: 7px; height: 7px; border-radius: 50%; }
  .dot.err { background: var(--err); }
  .body { flex: 1; overflow: auto; padding: 12px 14px 20px; }
  h3 { font-size: 13px; font-weight: 700; margin: 16px 0 6px; }
  h3:first-child { margin-top: 0; }
  .muted { color: var(--ink-3); }
  .empty { padding: 18px 4px; }
  .empty p { margin: 0 0 4px; }
  .ops { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .ops li { border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
  .ops li.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .op { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 0; background: none; text-align: left; }
  .n { width: 22px; height: 22px; border-radius: 50%; background: var(--iron); color: var(--on-iron); display: grid; place-items: center; font-size: 12px; font-weight: 600; flex: none; font-variant-numeric: tabular-nums; }
  .what { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .label { font-weight: 600; }
  .sub { display: block; color: var(--ink-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px; }
  .badge.err { background: var(--err-soft); color: var(--err); }
  .badge.warn { background: var(--warn-soft); color: var(--warn); }
  .detail { padding: 0 10px 10px 42px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; margin: 8px 0; }
  .diag { margin: 4px 0; padding: 6px 9px; border-radius: 6px; font-size: 12.5px; white-space: pre-wrap; font-family: inherit; }
  .diag.error { background: var(--err-soft); color: var(--err); }
  .diag.warning { background: var(--warn-soft); color: var(--warn); }
  textarea.code { width: 100%; font-family: var(--mono); font-size: 12px; border: 1px solid var(--line-2); border-radius: 6px; padding: 8px; background: var(--panel); resize: vertical; }
  .add { margin-top: 12px; }
  .add summary { cursor: pointer; color: var(--ink-2); font-weight: 600; padding: 4px 0; }
  label { display: grid; grid-template-columns: 1fr 110px auto; align-items: center; gap: 8px; margin: 6px 0; color: var(--ink-2); }
  label.wide { grid-template-columns: 1fr 2fr; margin-top: 14px; }
  label input { border: 1px solid var(--line-2); border-radius: 6px; padding: 5px 8px; background: var(--panel); text-align: right; font-variant-numeric: tabular-nums; }
  label.wide input { text-align: left; }
  .tools { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  .tools th { text-align: left; font-size: 12px; color: var(--ink-3); font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--line); }
  .tools td { padding: 7px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .tools td.t { font-weight: 700; width: 24px; }
  .tools td.data { color: var(--ink-2); font-size: 12px; }
  .gcode { margin: 0; font-family: var(--mono); font-size: 12px; line-height: 1.55; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 0; overflow: auto; }
  .gcode .ln { display: inline-block; width: 44px; padding-right: 12px; text-align: right; color: var(--ink-3); user-select: none; }
  .gcode .cm { color: var(--ink-3); }
</style>
