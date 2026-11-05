<script lang="ts">
  import type { Shape, Tool } from '@swarf/cam';
  import type { Field } from './form.ts';

  let {
    fields,
    value,
    errors = {},
    tools = [],
    shapes = [],
    placeholders = {},
    onchange,
  }: {
    fields: Field[];
    value: Record<string, unknown>;
    errors?: Record<string, string>;
    /** Tools offered for a `tool` field (already filtered to the ones that fit). */
    tools?: Tool[];
    /** Drawings offered for a `shape` field. */
    shapes?: Shape[];
    /** What an empty optional field means, e.g. the value the material table gives. */
    placeholders?: Record<string, string>;
    onchange: (next: Record<string, unknown>) => void;
  } = $props();

  const main = $derived(fields.filter((f) => f.required || f.default !== undefined));
  const more = $derived(fields.filter((f) => !f.required && f.default === undefined));
  const moreSet = $derived(more.some((f) => value[f.key] !== undefined) || more.some((f) => errors[f.key]));

  function set(key: string, v: unknown): void {
    const next = { ...value };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    onchange(next);
  }

  function num(e: Event, integer = false): number | undefined {
    const s = (e.currentTarget as HTMLInputElement).value.trim().replace(',', '.');
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? (integer ? Math.round(n) : n) : undefined;
  }

  type Row = Record<string, number | undefined>;
  const rows = (key: string) => ((value[key] as Row[] | undefined) ?? []);
  function setCell(key: string, i: number, col: string, n: number | undefined): void {
    const next = rows(key).map((r) => ({ ...r }));
    if (n === undefined) delete next[i]![col];
    else next[i]![col] = n;
    set(key, next);
  }
  function addRow(f: Field): void {
    const last = rows(f.key).at(-1);
    const blank: Row = {};
    for (const c of f.columns ?? []) if (c.required) blank[c.key] = last?.[c.key] ?? 0;
    set(f.key, [...rows(f.key), blank]);
  }
</script>

{#snippet field(f: Field)}
  <div class="f" class:bad={errors[f.key]}>
    <label for="f-{f.key}">{f.label}{#if f.unit}<span class="unit">{f.unit}</span>{/if}</label>
    {#if f.kind === 'shape'}
      <select id="f-{f.key}" value={(value[f.key] as string) ?? ''} onchange={(e) => set(f.key, (e.currentTarget as HTMLSelectElement).value || undefined)}>
        {#if !f.required}<option value="">–</option>{/if}
        {#each shapes as sh (sh.id)}<option value={sh.id}>{sh.id} · {sh.name}</option>{/each}
        {#if value[f.key] && !shapes.some((sh) => sh.id === value[f.key])}<option value={value[f.key] as string}>{value[f.key] || 'none'} (missing)</option>{/if}
      </select>
    {:else if f.kind === 'tool'}
      <select id="f-{f.key}" value={value[f.key] as number} onchange={(e) => set(f.key, Number((e.currentTarget as HTMLSelectElement).value))}>
        {#each tools as t (t.id)}<option value={t.id}>T{t.id} · {t.name}</option>{/each}
        {#if !tools.some((t) => t.id === value[f.key])}<option value={value[f.key] as number}>T{value[f.key]} (does not fit)</option>{/if}
      </select>
    {:else if f.kind === 'select'}
      <select id="f-{f.key}" value={(value[f.key] as string) ?? f.default ?? ''} onchange={(e) => set(f.key, (e.currentTarget as HTMLSelectElement).value)}>
        {#if !f.required && f.default === undefined}<option value="">{placeholders[f.key] ? `${placeholders[f.key]} (auto)` : '–'}</option>{/if}
        {#each f.options ?? [] as o (o)}<option value={o}>{o}</option>{/each}
      </select>
    {:else if f.kind === 'checkbox'}
      <input id="f-{f.key}" type="checkbox" checked={!!value[f.key]} onchange={(e) => set(f.key, (e.currentTarget as HTMLInputElement).checked)} />
    {:else if f.kind === 'number' || f.kind === 'integer'}
      <input
        id="f-{f.key}"
        type="text"
        inputmode="decimal"
        value={value[f.key] ?? ''}
        placeholder={f.default !== undefined ? String(f.default) : f.required ? '' : (placeholders[f.key] ?? 'auto')}
        onchange={(e) => set(f.key, num(e, f.kind === 'integer'))}
      />
    {:else if f.kind === 'rows'}
      <div class="pts" style="--cols: {f.columns?.length ?? 2}">
        <div class="pt head">{#each f.columns ?? [] as c (c.key)}<span>{c.label}</span>{/each}<span></span></div>
        {#each rows(f.key) as row, i (i)}
          <div class="pt">
            {#each f.columns ?? [] as c (c.key)}
              <input type="text" inputmode="decimal" aria-label="Row {i + 1} {c.label}" value={row[c.key] ?? ''} placeholder={c.required ? '' : '–'} onchange={(e) => setCell(f.key, i, c.key, num(e))} />
            {/each}
            <button type="button" class="x" aria-label="Remove row {i + 1}" onclick={() => set(f.key, rows(f.key).filter((_, k) => k !== i))}>×</button>
          </div>
        {/each}
        <button type="button" class="btn" onclick={() => addRow(f)}>Add row</button>
      </div>
    {:else}
      <input id="f-{f.key}" type="text" value={(value[f.key] as string) ?? ''} onchange={(e) => set(f.key, (e.currentTarget as HTMLInputElement).value)} />
    {/if}
    {#if errors[f.key]}<p class="err">{errors[f.key]}</p>{:else if f.help && f.kind !== 'tool'}<p class="help">{f.help}</p>{/if}
  </div>
{/snippet}

<div class="form">
  {#each main as f (f.key)}{@render field(f)}{/each}
  {#if more.length}
    <details open={moreSet}>
      <summary>Overrides</summary>
      {#each more as f (f.key)}{@render field(f)}{/each}
    </details>
  {/if}
</div>

<style>
  .form { display: flex; flex-direction: column; gap: 8px; }
  .f { display: grid; grid-template-columns: 1fr 120px; gap: 2px 10px; align-items: center; }
  .f label { color: var(--ink-2); font-weight: 500; }
  .unit { color: var(--ink-3); font-weight: 400; margin-left: 5px; font-size: 12px; }
  .f input[type='text'], .f select { border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 7px; background: var(--panel); min-width: 0; font-variant-numeric: tabular-nums; }
  .f input[type='text'] { text-align: right; }
  .f select { grid-column: 2; }
  .f input[type='checkbox'] { justify-self: end; }
  .help, .err { grid-column: 1 / -1; margin: 0; font-size: 12px; color: var(--ink-3); }
  .err { color: var(--err); }
  .f.bad input, .f.bad select { border-color: var(--err); }
  .pts { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; }
  .pt { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)) 26px; gap: 6px; }
  .pt.head span { font-size: 11.5px; color: var(--ink-3); text-align: right; padding-right: 7px; }
  .pt input { border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 7px; background: var(--panel); text-align: right; min-width: 0; }
  .x { border: 0; background: none; color: var(--ink-3); font-size: 18px; padding: 0 6px; }
  .x:hover { color: var(--err); }
  .pts .btn { justify-self: start; }
  details summary { cursor: pointer; color: var(--ink-3); font-weight: 600; padding: 4px 0; }
  details .f { margin-top: 8px; }
</style>
