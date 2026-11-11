<script lang="ts">
  /**
   * The clampings of the part (mill): which one is in hand, and adding one with the block turned.
   * Everything else in the job pane, the preview and the machine works on the one in hand.
   */
  import { TURNS, addSetup, faceAfter, leftBy, mapPoint, removeSetup, renameSetup, setupList, switchSetup, turnedSize, type Turn } from '@swarf/cam';
  import { files } from './files.svelte.ts';
  import { machine } from './machine.svelte.ts';
  import { store } from './store.svelte.ts';

  const job = $derived(store.job);
  const list = $derived(setupList(job));
  const many = $derived(list.setups.length > 1);
  const under = $derived(machine.job === 'running' || machine.job === 'paused' || machine.job === 'waiting');

  let adding = $state(false);
  let turn = $state<Turn>('over-y');
  let name = $state('');
  let editing = $state(false);
  const left = $derived(job.stock.kind === 'block' ? leftBy(job, store.analysis) : null);
  const lies = $derived(left ? turnedSize(turn, left) : null);
  const how = $derived(TURNS.find((t) => t.turn === turn)?.how ?? '');

  function busy(): boolean {
    if (under) files.say('A program is under way on the machine: finish or stop it before changing setups.', true);
    return under;
  }
  function pick(i: number): void {
    if (i === list.at || busy()) return;
    store.setup(switchSetup($state.snapshot(job) as typeof job, i));
    adding = editing = false;
  }
  function add(): void {
    if (!left || busy()) return;
    try {
      store.setup(addSetup($state.snapshot(job) as typeof job, turn, name, left));
      adding = false;
      name = '';
    } catch (e) {
      files.say(e instanceof Error ? e.message : String(e), true);
    }
  }
  function remove(): void {
    if (busy()) return;
    if (!confirm(`Remove the setup "${list.setups[list.at]!.name}" with its ${job.operations.length} operation${job.operations.length === 1 ? '' : 's'}? Undo brings it back.`)) return;
    store.setup(removeSetup($state.snapshot(job) as typeof job));
    editing = false;
  }

  // where a point of the setup before lies now
  const before = $derived(list.at > 0 ? list.setups[list.at - 1]! : null);
  let px = $state(0);
  let py = $state(0);
  let pz = $state(0);
  const carried = $derived.by(() => {
    if (!before || before.stock.kind !== 'block' || job.stock.kind !== 'block' || !job.setups) return null;
    // the block before, as large as this one lying the old way (what that setup left)
    const t = job.setups.turn;
    const back = turnedSize(t === 'front-up' ? 'back-up' : t === 'back-up' ? 'front-up' : t === 'left-up' ? 'right-up' : t === 'right-up' ? 'left-up' : t === 'quarter' ? 'quarter' : t, job.stock);
    const from = { kind: 'block' as const, x: back.x, y: back.y, z: back.z, top: 0 };
    const q = mapPoint(t, from, job.stock, { x: px || 0, y: py || 0, z: pz || 0 });
    return q;
  });
  const n2 = (v: number) => (Math.round(v * 100) / 100).toString();
</script>

{#if job.machine.kind === 'mill'}
  <div class="setups">
    <div class="chips" role="tablist" aria-label="Setups">
      {#each list.setups as s, i (i)}
        <button role="tab" aria-selected={i === list.at} class:on={i === list.at} onclick={() => pick(i)} title={i === list.at ? 'The setup in hand' : `Take setup ${i + 1} in hand`}>
          <b>{i + 1}</b>{#if many || s.name !== 'Setup 1'}<span>{s.name}</span>{:else}<span>One setup</span>{/if}
        </button>
      {/each}
      <button class="plus" aria-expanded={adding} onclick={() => ((adding = !adding), (editing = false))} title="Another clamping of the same part, with the block turned: for what the tool cannot reach from above">+ Setup</button>
      {#if many}<button class="plus" aria-expanded={editing} onclick={() => ((editing = !editing), (adding = false))} title="Rename or remove the setup in hand">Edit</button>{/if}
    </div>

    {#if adding && left && lies}
      <div class="box">
        <label>The block, after this setup
          <select bind:value={turn}>
            {#each TURNS as t (t.turn)}<option value={t.turn}>{t.label}</option>{/each}
          </select>
        </label>
        <p class="small">{how}</p>
        <p class="small muted">It will lie {lies.x} × {lies.y} × {lies.z} mm (X × Y × Z): what this setup leaves ({left.x} × {left.y} × {left.z}), turned. Its zero is the front-left corner as it then lies, Z0 on its top{turn !== 'none' && turn !== 'quarter' ? `; what is on top now will be the ${faceAfter(turn, 'top')}` : ''}.</p>
        <label>Name <input bind:value={name} placeholder={TURNS.find((t) => t.turn === turn)?.label} maxlength="60" /></label>
        <div class="row"><button class="btn pri" onclick={add}>Add the setup</button><button class="btn" onclick={() => (adding = false)}>Cancel</button></div>
      </div>
    {/if}

    {#if editing && many}
      <div class="box">
        <label>Name <input value={list.setups[list.at]!.name} maxlength="60" onchange={(e) => store.set(renameSetup($state.snapshot(job) as typeof job, (e.currentTarget as HTMLInputElement).value))} /></label>
        <div class="row"><button class="btn danger" onclick={remove}>Remove this setup</button><button class="btn" onclick={() => (editing = false)}>Done</button></div>
      </div>
    {/if}

    {#if job.setups && list.at > 0 && !adding && !editing}
      <details class="turned">
        <summary>{TURNS.find((t) => t.turn === job.setups?.turn)?.label ?? ''} from setup {list.at}: where is what?</summary>
        <p class="small">{TURNS.find((t) => t.turn === job.setups?.turn)?.how}</p>
        {#if carried}
          <p class="small muted">A point of setup {list.at} (measured from the part's front-left corner there, Z from its top), in this setup:</p>
          <div class="pt">
            <label>X <input type="number" step="0.1" bind:value={px} /></label>
            <label>Y <input type="number" step="0.1" bind:value={py} /></label>
            <label>Z <input type="number" step="0.1" bind:value={pz} /></label>
            <span class="is">is X {n2(carried.x)}  Y {n2(carried.y)}  Z {n2(carried.z)}</span>
          </div>
          <p class="small muted">Taking this block for what setup {list.at} left: if you changed its size since, the numbers are off by that.</p>
        {/if}
      </details>
    {/if}
  </div>
{/if}

<style>
  .setups { padding: 8px 12px 0; display: flex; flex-direction: column; gap: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chips button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line-2); background: var(--panel); border-radius: 999px; padding: 3px 10px 3px 4px; font-size: 12.5px; max-width: 100%; }
  .chips button b { display: inline-grid; place-items: center; width: 19px; height: 19px; border-radius: 50%; background: var(--panel-2); font-size: 11.5px; }
  .chips button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chips button.on { border-color: var(--ink); font-weight: 700; }
  .chips button.on b { background: var(--accent); color: var(--on-accent); }
  .chips .plus { padding: 3px 10px; border-style: dashed; color: var(--ink-2); }
  .box { border: 1px solid var(--line-2); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; background: var(--panel-2); }
  label { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); }
  select, input { border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 7px; background: var(--panel); min-width: 0; flex: 1; }
  .row { display: flex; gap: 8px; }
  .small { font-size: 12.5px; margin: 0; }
  .muted { color: var(--ink-3); }
  .turned { font-size: 12.5px; }
  .turned summary { cursor: pointer; color: var(--link); font-weight: 600; }
  .turned p { margin-top: 6px; }
  .pt { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin: 6px 0; }
  .pt label { gap: 4px; }
  .pt input { width: 62px; flex: none; }
  .is { font-weight: 700; font-variant-numeric: tabular-nums; white-space: pre; }
</style>
