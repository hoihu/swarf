<script lang="ts">
  import { API_SERVICES, apiProblem, apiService, type ApiChoice, type ApiServiceId } from '@swarf/agent';
  import { store } from './store.svelte.ts';

  let { onClose }: { onClose: () => void } = $props();

  let draft = $state<ApiChoice>({ ...store.api });
  const service = $derived(apiService(draft.service));
  const problem = $derived(apiProblem(draft));

  function pick(id: ApiServiceId): void {
    const s = apiService(id);
    draft = { ...draft, service: id, baseURL: '', model: s.models[0] ?? '' };
  }

  function save(): void {
    store.setApi({ ...draft });
    onClose();
  }

  let dialog: HTMLDialogElement;
  $effect(() => {
    dialog.showModal();
  });
</script>

<dialog bind:this={dialog} onclose={onClose} aria-labelledby="settings-title">
  <form method="dialog" onsubmit={(e) => { e.preventDefault(); save(); }}>
    <h2 id="settings-title">Model connection</h2>
    <p class="muted">The app talks to the model straight from this browser with your own key. The key is kept in this browser's storage only.</p>

    <label>
      <span>Service</span>
      <select value={draft.service} onchange={(e) => pick((e.currentTarget as HTMLSelectElement).value as ApiServiceId)}>
        {#each API_SERVICES as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
      </select>
    </label>
    {#if service.note}<p class="note">{service.note}</p>{/if}

    {#if !service.baseURL || draft.baseURL}
      <label>
        <span>Address</span>
        <input type="url" bind:value={draft.baseURL} placeholder={service.baseURL || 'https://…'} />
      </label>
    {/if}

    {#if service.keyHint}
      <label>
        <span>API key</span>
        <input type="password" autocomplete="off" bind:value={draft.apiKey} placeholder={service.keyHint} />
      </label>
      {#if service.keysUrl}<p class="muted small">Get one at <a href={service.keysUrl} target="_blank" rel="noreferrer">{new URL(service.keysUrl).host}</a>.</p>{/if}
    {/if}

    <label>
      <span>Model</span>
      {#if service.models.length}
        <select bind:value={draft.model}>
          {#each service.models as m (m)}<option value={m}>{m}</option>{/each}
        </select>
      {:else}
        <input type="text" bind:value={draft.model} placeholder="model id, e.g. gpt-5" />
      {/if}
    </label>

    <div class="row">
      <span class="status">{problem ? `Without a ${problem.replace('no ', '')}, the chat runs the offline demo.` : 'Ready.'}</span>
      <button type="button" class="btn" onclick={() => dialog.close()}>Cancel</button>
      <button type="submit" class="btn pri">Save</button>
    </div>
  </form>
</dialog>

<style>
  dialog { border: 1px solid var(--line-2); border-radius: 12px; padding: 0; width: min(460px, calc(100vw - 24px)); background: var(--panel); color: var(--ink); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35); }
  dialog::backdrop { background: rgba(20, 26, 23, 0.55); }
  form { padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; }
  h2 { margin: 0; font-size: 18px; }
  .muted { margin: 0; color: var(--ink-3); }
  .small { font-size: 12px; }
  .note { margin: 0; font-size: 12.5px; color: var(--ink-2); background: var(--panel-2); padding: 6px 9px; border-radius: 6px; }
  label { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 10px; }
  label span { color: var(--ink-2); font-weight: 600; }
  input, select { border: 1px solid var(--line-2); border-radius: 6px; padding: 6px 8px; background: var(--panel); min-width: 0; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .status { flex: 1; font-size: 12.5px; color: var(--ink-3); }
  a { color: var(--link); }
</style>
