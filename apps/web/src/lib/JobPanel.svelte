<script lang="ts">
  import { EXAMPLES, Job, MATERIALS, Machine, OP_TOOLS, cuttingData, defaultToolMaterial, type MaterialId, Operation, Tool, bbox, emptyJob, importDrawing, opLabel, withIds, type OpType, type Stock } from '@swarf/cam';
  import SchemaForm from './SchemaForm.svelte';
  import MachinePanel from './MachinePanel.svelte';
  import CameraPanel from './camera/CameraPanel.svelte';
  import ProbePanel from './ProbePanel.svelte';
  import { machine } from './machine.svelte.ts';
  import { issuesByField, machineFields, opFields, toolFieldsFor } from './form.ts';
  import { store } from './store.svelte.ts';
  import { OP_TEMPLATES } from './ops.ts';
  import { download as saveAs, fileName, files } from './files.svelte.ts';
  import { inLibrary, toolSummary } from '@swarf/cam';

  type Tab = 'ops' | 'stock' | 'tools' | 'gcode' | 'machine';
  let tab = $state<Tab>('ops');

  const job = $derived(store.job);
  const diags = $derived(store.analysis.diagnostics);
  const errorsByOp = $derived(new Map(job.operations.map((o) => [o.id!, diags.filter((d) => d.opId === o.id)])));
  const jobLevel = $derived(diags.filter((d) => !d.opId));

  // ---- operation editing: a form per operation, applied as soon as it is valid
  /** The selected operation's values while they do not validate yet. */
  let draft = $state<{ id: string; value: Record<string, unknown>; errors: Record<string, string> } | null>(null);
  const selectedOp = $derived(job.operations.find((o) => o.id === store.selected) ?? null);

  function editOp(id: string, value: Record<string, unknown>): void {
    const op = Operation.safeParse({ ...value, id });
    if (!op.success) {
      draft = { id, value, errors: issuesByField(op.error) };
      return;
    }
    draft = null;
    store.set({ ...job, operations: job.operations.map((o) => (o.id === id ? op.data : o)) });
  }

  const toolsFor = (type: OpType) => job.tools.filter((t) => OP_TOOLS[type].includes(t.type));

  function addOp(make: (job: Job) => unknown): void {
    const op = Operation.parse(make(job));
    const ops = withIds([...job.operations, op]);
    store.set({ ...job, operations: ops });
    const id = ops.at(-1)!.id!;
    store.selected = id;
    draft = null;
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
    draft = null;
  }

  // ---- drawings (mill)
  let importNotes = $state<string[]>([]);
  let importError = $state('');
  async function importFile(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    importError = '';
    try {
      const { shape, notes } = importDrawing(file.name, await file.text(), job);
      store.set({ ...job, shapes: [...job.shapes, shape] });
      importNotes = [`${shape.id}: ${file.name}`, ...notes];
    } catch (err) {
      importError = err instanceof Error ? err.message : String(err);
    }
  }
  const sizeOf = (sh: (typeof job.shapes)[number]) => {
    const b = bbox(sh.paths.map((p) => p.pts))!;
    return { w: b.maxX - b.minX, h: b.maxY - b.minY, x: b.minX + sh.at.x, y: b.minY + sh.at.y };
  };
  function moveShape(id: string, axis: 'x' | 'y', e: Event): void {
    const v = Number((e.currentTarget as HTMLInputElement).value.replace(',', '.'));
    if (!Number.isFinite(v)) return;
    const shapes = job.shapes.map((sh) => {
      if (sh.id !== id) return sh;
      // the field shows where the drawing's lower-left corner sits; move by the difference
      const s0 = sizeOf(sh);
      return { ...sh, at: { ...sh.at, [axis]: sh.at[axis] + v - s0[axis] } };
    });
    store.set({ ...job, shapes });
  }
  const shapeUsed = (id: string) => job.operations.some((o) => 'shape' in o && o.shape === id);

  // ---- stock
  function setStock(patch: Partial<Record<string, number>>): void {
    const next = { ...job.stock, ...patch } as Stock;
    const parsed = Job.safeParse({ ...job, stock: next });
    if (parsed.success) store.set(parsed.data);
  }
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);

  function start(kind: 'lathe' | 'mill', example: boolean): void {
    store.replace(example ? EXAMPLES[kind]() : emptyJob(kind));
    draft = null;
  }

  // ---- machine settings
  let machineDraft = $state<{ value: Record<string, unknown>; errors: Record<string, string> } | null>(null);
  function editMachine(value: Record<string, unknown>): void {
    const m = Machine.safeParse({ ...value, kind: job.machine.kind, envelope: job.machine.envelope });
    if (!m.success) {
      machineDraft = { value, errors: issuesByField(m.error) };
      return;
    }
    machineDraft = null;
    store.set({ ...job, machine: m.data });
  }

  // ---- tools: the same forms
  let toolOpen = $state<number | null>(null);
  let toolDraft = $state<{ id: number; value: Record<string, unknown>; errors: Record<string, string> } | null>(null);

  function editTool(oldId: number, value: Record<string, unknown>): void {
    const t = Tool.safeParse(value);
    const clash = t.success && t.data.id !== oldId && job.tools.some((x) => x.id === t.data.id);
    if (!t.success || clash) {
      toolDraft = { id: oldId, value, errors: t.success ? { id: `T${t.data.id} is taken` } : issuesByField(t.error) };
      return;
    }
    toolDraft = null;
    const tools = job.tools.map((x) => (x.id === oldId ? t.data : x)).sort((a, b) => a.id - b.id);
    // operations follow a renumbered tool
    const operations = t.data.id === oldId ? job.operations : job.operations.map((o) => (o.tool === oldId ? { ...o, tool: t.data.id } : o));
    store.set({ ...job, tools, operations });
    toolOpen = t.data.id;
  }

  function cutText(t: Tool): string {
    const c = cuttingData(t, job.workMaterial);
    const feed = t.type === 'endmill' || t.type === 'chamfer' || t.type === 'threadmill' ? `${c.feed} mm/tooth` : t.type === 'threading' ? '' : `${c.feed} mm/rev`;
    return [`vc ${c.vc} m/min`, feed].filter(Boolean).join(', ');
  }

  /** What the empty cutting-data fields mean for this tool in the job's material. */
  function toolPlaceholders(t: Tool): Record<string, string> {
    const c = cuttingData({ ...t, vc: undefined, chipload: undefined, feedPerRev: undefined, maxDoc: undefined }, job.workMaterial);
    const p: Record<string, string> = { vc: String(c.vc), toolMaterial: defaultToolMaterial(t.type) === 'hss' ? 'HSS' : 'carbide' };
    if (t.type === 'endmill' || t.type === 'chamfer' || t.type === 'threadmill') p.chipload = String(c.feed);
    else if (t.type !== 'threading') p.feedPerRev = String(c.feed);
    if (t.type !== 'drill' && t.type !== 'threading') p.maxDoc = String(c.doc);
    return p;
  }

  function addTool(): void {
    const id = Math.max(0, ...job.tools.map((t) => t.id)) + 1;
    const t: Tool =
      job.machine.kind === 'lathe'
        ? { id, name: 'Turning tool', type: 'turning', edgeLength: 3 }
        : { id, name: `Endmill Ø6`, type: 'endmill', diameter: 6, flutes: 2, fluteLength: 15, centerCutting: true };
    store.set({ ...job, tools: [...job.tools, t] });
    toolOpen = id;
  }

  function removeTool(id: number): void {
    store.set({ ...job, tools: job.tools.filter((t) => t.id !== id) });
    toolOpen = null;
  }
  const usedBy = (id: number) => job.operations.filter((o) => o.tool === id).length;

  // ---- the tool library
  const libTools = $derived(files.toolsFor(job.machine.kind));
  /** 'new': not in the library; 'same': as kept; 'changed': kept, but different now (the number aside). */
  function kept(t: Tool): 'new' | 'same' | 'changed' {
    const e = inLibrary(files.library, job.machine.kind, t.name);
    if (!e) return 'new';
    return JSON.stringify({ ...e.tool, id: 0 }) === JSON.stringify({ ...t, id: 0 }) ? 'same' : 'changed';
  }
  const inJob = (name: string) => job.tools.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());

  // ---- G-code
  function download(): void {
    saveAs(fileName(job.name, '.nc'), store.gcode.text, 'text/plain');
  }
  const gcodeLines = $derived(store.gcode.text.split('\n'));
  const toolName = (id: number) => job.tools.find((t) => t.id === id)?.name ?? `T${id} (missing)`;
</script>

<section class="panel">
  <div class="tabs" role="tablist">
    {#each [['ops', 'Operations'], ['stock', 'Stock'], ['tools', 'Tools'], ['gcode', 'G-code'], ['machine', 'Machine']] as [id, name] (id)}
      <button role="tab" aria-selected={tab === id} class:on={tab === id} onclick={() => (tab = id as Tab)}>
        {name}
        {#if id === 'ops' && diags.some((d) => d.severity === 'error')}<span class="dot err" title="Has errors"></span>{/if}
        {#if id === 'machine' && machine.connected}<span class="dot on" title="Controller connected"></span>{/if}
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
      <div class="drawings">
          {#each job.shapes as sh (sh.id)}
            {@const z = sizeOf(sh)}
            <div class="drawing">
              <span class="what"><span class="label">{sh.id} · {sh.name}</span><span class="sub">{z.w.toFixed(1)} × {z.h.toFixed(1)} mm, {sh.paths.length} path{sh.paths.length === 1 ? '' : 's'}</span></span>
              {#if job.machine.kind === 'mill'}
                <label class="at">X <input value={z.x.toFixed(2)} onchange={(e) => moveShape(sh.id, 'x', e)} aria-label="{sh.id} left edge X" /></label>
                <label class="at">Y <input value={z.y.toFixed(2)} onchange={(e) => moveShape(sh.id, 'y', e)} aria-label="{sh.id} bottom edge Y" /></label>
              {/if}
              <button class="ib" aria-label="Remove {sh.id}" disabled={shapeUsed(sh.id)} title={shapeUsed(sh.id) ? 'Operations use this drawing' : 'Remove'} onclick={() => store.set({ ...job, shapes: job.shapes.filter((x) => x.id !== sh.id) })}>×</button>
            </div>
          {/each}
          <label class="btn import">Import DXF or SVG<input type="file" accept=".dxf,.svg,image/svg+xml" onchange={importFile} hidden /></label>
          {#if importError}<p class="diag error">{importError}</p>{/if}
          {#each importNotes as n, k (k)}<p class="muted small">{n}</p>{/each}
          {#if job.machine.kind === 'lathe' && !job.shapes.length}<p class="muted small">A drawing of the part from the side (axis horizontal, face on the right) can be turned with "Profile from a drawing".</p>{/if}
        </div>
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
                <SchemaForm
                  fields={opFields(op.type)}
                  value={draft?.id === op.id ? draft.value : (op as Record<string, unknown>)}
                  errors={draft?.id === op.id ? draft.errors : {}}
                  tools={toolsFor(op.type)}
                  shapes={job.shapes}
                  onchange={(v) => editOp(op.id!, v)}
                />
                <div class="row">
                  <button class="btn" disabled={i === 0} onclick={() => move(op.id!, -1)}>Move up</button>
                  <button class="btn" disabled={i === job.operations.length - 1} onclick={() => move(op.id!, 1)}>Move down</button>
                  <button class="btn danger" onclick={() => remove(op.id!)}>Remove</button>
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ol>
      <details class="add">
        <summary>Add an operation</summary>
        <div class="grid">
          {#each OP_TEMPLATES[job.machine.kind] as t (t.name)}
            <button class="btn" onclick={() => addOp(t.make)} disabled={t.needsShape && !job.shapes.length} title={t.needsShape && !job.shapes.length ? 'Import a DXF or SVG first' : ''}>{t.name}</button>
          {/each}
        </div>
      </details>
    {:else if tab === 'stock'}
      <h3>Machine</h3>
      <p class="muted">{job.machine.name}: {job.machine.kind}, {job.machine.minRpm}–{job.machine.maxRpm} rpm, feed up to {job.machine.maxFeed} mm/min.</p>
      <details class="add">
        <summary>Machine settings</summary>
        <SchemaForm fields={machineFields(job.machine.kind)} value={machineDraft?.value ?? (job.machine as Record<string, unknown>)} errors={machineDraft?.errors ?? {}} onchange={editMachine} />
      </details>
      <div class="grid">
        <button class="btn" onclick={() => start('lathe', true)}>Lathe example</button>
        <button class="btn" onclick={() => start('mill', true)}>Mill example</button>
        <button class="btn" onclick={() => start('lathe', false)}>Empty lathe job</button>
        <button class="btn" onclick={() => start('mill', false)}>Empty mill job</button>
      </div>
      <h3>Job file</h3>
      <div class="row">
        <label class="btn">Open a job<input type="file" accept=".json,application/json" onchange={(e) => files.openJobFrom(e)} hidden /></label>
        <button class="btn" onclick={() => files.saveJob()}>Save this job</button>
      </div>
      <p class="muted small">The job is kept in this browser as you work. A file ({fileName(job.name, '.swarf.json')}) keeps it for later, or for another computer: machine, stock, tools, operations and drawings.</p>
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
      <label class="wide">Material
        <select value={job.workMaterial} onchange={(e) => store.set({ ...job, workMaterial: (e.currentTarget as HTMLSelectElement).value as MaterialId })}>
          {#each Object.entries(MATERIALS) as [id, m] (id)}<option value={id}>{m.name}</option>{/each}
        </select>
      </label>
      <label class="wide">Grade <input type="text" value={job.material ?? ''} placeholder={MATERIALS[job.workMaterial].examples.split(',')[0]} onchange={(e) => store.set({ ...job, material: (e.currentTarget as HTMLInputElement).value || undefined })} /></label>
      <p class="muted">The material sets cutting speed, feed and depth per pass for every tool ({MATERIALS[job.workMaterial].examples}). Values set on a tool override it.</p>
      <h3>Setup notes</h3>
      <textarea rows="3" aria-label="Setup notes" placeholder={job.machine.kind === 'lathe' ? 'How the bar is held: three-jaw, soft jaws, tailstock centre…' : 'How the block is held: vise on 10 mm parallels, stop on the left…'} value={job.notes ?? ''} onchange={(e) => store.set({ ...job, notes: (e.currentTarget as HTMLTextAreaElement).value.trim() || undefined })}></textarea>
      <p class="muted small">Printed on the setup sheet (G-code tab).</p>
    {:else if tab === 'tools'}
      <ol class="ops">
        {#each job.tools as t (t.id)}
          <li class:sel={toolOpen === t.id}>
            <button class="op" onclick={() => { toolOpen = toolOpen === t.id ? null : t.id; toolDraft = null; }}>
              <span class="n">{t.id}</span>
              <span class="what">
                <span class="label">{t.name}</span>
                <span class="sub">{t.type}{t.diameter ? `, Ø${t.diameter}` : ''}{t.width ? `, ${t.width} mm wide` : ''} · {cutText(t)}{usedBy(t.id) ? ` · used ${usedBy(t.id)}×` : ''}</span>
              </span>
            </button>
            {#if toolOpen === t.id}
              <div class="detail">
                <SchemaForm
                  fields={toolFieldsFor(toolDraft?.id === t.id ? toolDraft.value : (t as Record<string, unknown>))}
                  value={toolDraft?.id === t.id ? toolDraft.value : (t as Record<string, unknown>)}
                  errors={toolDraft?.id === t.id ? toolDraft.errors : {}}
                  placeholders={toolPlaceholders(t)}
                  onchange={(v) => editTool(t.id, v)}
                />
                <div class="row">
                  {#if kept(t) === 'same'}
                    <span class="muted small">In your library</span>
                  {:else}
                    <button class="btn" onclick={() => files.keepTool(job.machine.kind, t)} title="Your library keeps tools for every job, in this browser">{kept(t) === 'changed' ? 'Update in the library' : 'Keep in the library'}</button>
                  {/if}
                  <button class="btn danger" disabled={usedBy(t.id) > 0} title={usedBy(t.id) ? 'Operations use this tool' : ''} onclick={() => removeTool(t.id)}>Remove tool</button>
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ol>
      <div class="row"><button class="btn" onclick={addTool}>Add a tool</button></div>
      <h3>Your tool library</h3>
      {#if !libTools.length}
        <p class="muted small">Empty for the {job.machine.kind}. Open a tool above and choose "Keep in the library": it is then there for every job{job.machine.kind === 'lathe' ? ', with its stored offset in the tool post' : ''}.</p>
      {/if}
      <ul class="lib">
        {#each libTools as t (t.name)}
          {@const here = inJob(t.name)}
          <li>
            <span class="what"><span class="label">{t.name}</span><span class="sub">{toolSummary(t)}{t.offset ? ' · offset stored' : ''}</span></span>
            {#if here}
              <span class="muted small">T{here.id} in this job</span>
            {:else}
              <button class="btn" aria-label="Add {t.name} to the job" onclick={() => (toolOpen = files.takeTool(t))}>Add to the job</button>
            {/if}
            <button class="ib" aria-label="Remove {t.name} from the library" title="Remove from the library" onclick={() => files.dropTool(job.machine.kind, t.name)}>×</button>
          </li>
        {/each}
      </ul>
      <div class="row">
        <button class="btn" disabled={!files.library.length} onclick={() => files.saveLibrary()}>Save the library as a file</button>
        <label class="btn">Add tools from a file<input type="file" accept=".json,application/json" onchange={(e) => files.importLibraryFrom(e)} hidden /></label>
      </div>
    {:else if tab === 'gcode'}
      <div class="row">
        <button class="btn pri" onclick={download} disabled={store.analysis.diagnostics.some((d) => d.severity === 'error')} title="Fix errors before downloading">Download .nc</button>
        <button class="btn" onclick={() => (files.sheet = true)} title="One page for the machine: stock, zero, tools, operations">Setup sheet</button>
        <span class="muted">{gcodeLines.length} lines</span>
      </div>
      {#if store.analysis.diagnostics.some((d) => d.severity === 'error')}
        <p class="diag error">The job has errors; fix them before running this on the machine.</p>
      {/if}
      <pre class="gcode">{#each gcodeLines as line, i (i)}<span class="ln">{i + 1}</span><span class:cm={line.startsWith('(')}>{line}</span>
{/each}</pre>
    {:else}
      <MachinePanel />
      {#if machine.connected && job.machine.kind === 'mill'}<ProbePanel />{/if}
      <CameraPanel />
    {/if}
  </div>
</section>

<style>
  .panel { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--panel); }
  .tabs { display: flex; gap: 0; padding: 8px 6px 0; overflow-x: auto; border-bottom: 1px solid var(--line); flex: none; }
  .tabs button { border: 0; background: none; padding: 8px 8px; white-space: nowrap; font-weight: 600; color: var(--ink-3); border-bottom: 2px solid transparent; margin-bottom: -1px; display: inline-flex; align-items: center; gap: 6px; }
  .tabs button.on { color: var(--ink); border-bottom-color: var(--accent); }
  .tabs button:hover { color: var(--ink); }
  .dot { width: 7px; height: 7px; border-radius: 50%; }
  .dot.err { background: var(--err); }
  .dot.on { background: var(--ok); }
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
  .add { margin-top: 12px; }
  .drawings { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .drawing { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; border: 1px dashed var(--line-2); border-radius: 8px; padding: 6px 8px; }
  .drawing .what { flex: 1 1 100%; }
  .drawing .at { display: inline-flex; grid-template-columns: none; gap: 4px; margin: 0; font-size: 12px; color: var(--ink-3); }
  .drawing .at input { width: 62px; padding: 3px 5px; }
  .import { align-self: flex-start; display: inline-block; }
  .ib { border: 0; background: none; color: var(--ink-3); font-size: 18px; padding: 0 4px; }
  .ib:hover:not(:disabled) { color: var(--err); }
  .small { font-size: 12px; margin: 0; }
  label.btn { display: inline-block; margin: 0; cursor: pointer; color: inherit; }
  textarea { width: 100%; border: 1px solid var(--line-2); border-radius: 6px; padding: 6px 8px; background: var(--panel); font: inherit; resize: vertical; }
  .lib { list-style: none; margin: 6px 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .lib li { display: flex; align-items: center; gap: 8px; border: 1px dashed var(--line-2); border-radius: 8px; padding: 5px 8px; }
  .add summary { cursor: pointer; color: var(--ink-2); font-weight: 600; padding: 4px 0; }
  label { display: grid; grid-template-columns: 1fr 110px auto; align-items: center; gap: 8px; margin: 6px 0; color: var(--ink-2); }
  label.wide { grid-template-columns: 1fr 2fr; margin-top: 14px; }
  label.wide + label.wide { margin-top: 8px; }
  label select { border: 1px solid var(--line-2); border-radius: 6px; padding: 5px 8px; background: var(--panel); min-width: 0; }
  label input { border: 1px solid var(--line-2); border-radius: 6px; padding: 5px 8px; background: var(--panel); text-align: right; font-variant-numeric: tabular-nums; }
  label.wide input { text-align: left; }
  .gcode { margin: 0; font-family: var(--mono); font-size: 12px; line-height: 1.55; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 0; overflow: auto; }
  .gcode .ln { display: inline-block; width: 44px; padding-right: 12px; text-align: right; color: var(--ink-3); user-select: none; }
  .gcode .cm { color: var(--ink-3); }
</style>
