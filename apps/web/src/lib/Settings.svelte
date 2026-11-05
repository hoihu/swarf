<script lang="ts">
  import { API_SERVICES, HARNESSES, apiProblem, apiService, type ApiChoice, type ApiServiceId, type HarnessId } from '@swarf/agent';
  import { store, type Engine } from './store.svelte.ts';
  import { bridge } from './bridge.svelte.ts';

  let { onClose }: { onClose: () => void } = $props();

  let draft = $state<ApiChoice>({ ...store.api });
  let engine = $state<Engine>(store.engine);
  let harness = $state<HarnessId>(store.harness);
  let models = $state({ ...store.models });
  const info = $derived(bridge.harness(harness));
  const HARNESS_IDS = Object.keys(HARNESSES) as HarnessId[];
  const service = $derived(apiService(draft.service));
  const problem = $derived(apiProblem(draft));

  function pick(id: ApiServiceId): void {
    const s = apiService(id);
    draft = { ...draft, service: id, baseURL: '', model: s.models[0] ?? '' };
  }

  function save(): void {
    store.setApi({ ...draft });
    store.setEngine(engine, harness, Object.fromEntries(Object.entries(models).map(([k, v]) => [k, (v ?? '').trim()]).filter(([, v]) => v)));
    onClose();
  }

  let dialog: HTMLDialogElement;
  $effect(() => {
    dialog.showModal();
  });
</script>

<dialog bind:this={dialog} onclose={onClose} aria-labelledby="settings-title">
  <form method="dialog" onsubmit={(e) => { e.preventDefault(); save(); }}>
    <h2 id="settings-title">Assistant</h2>
    <label>
      <span>Answered by</span>
      <select bind:value={engine}>
        <option value="auto">Automatic: a coding agent here, else the API</option>
        <option value="local">A coding agent on this computer</option>
        <option value="api">A model API with your key</option>
      </select>
    </label>
    {#if engine !== 'api'}
      <label>
        <span>Coding agent</span>
        <select bind:value={harness}>
          {#each HARNESS_IDS as id (id)}
            {@const h = bridge.harness(id)}
            <option value={id}>{HARNESSES[id]}{bridge.status === 'connected' ? (h?.available ? '' : ' (not found)') : ''}</option>
          {/each}
        </select>
      </label>
      <p class="muted small">
        {#if bridge.status === 'connected' && info?.available}
          {info.version} is ready on this computer; it uses your own login and plan, and only gets swarf's tools.
        {:else if bridge.status === 'connected'}
          {info?.reason ?? `The server cannot run ${HARNESSES[harness]}.`}
        {:else}
          Start the swarf server with <code class="inline">npm run server</code> and open the link it prints.
        {/if}
      </p>
      <label>
        <span>Model</span>
        <input type="text" value={models[harness] ?? ''} oninput={(e) => (models = { ...models, [harness]: (e.currentTarget as HTMLInputElement).value })} placeholder={harness === 'claude' ? "Claude Code's default (e.g. sonnet, opus)" : `${HARNESSES[harness]}'s default`} />
      </label>
    {/if}

    {#if engine !== 'local'}
    <h3>Model API</h3>
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
    {/if}

    <section class="cc">
      <h3>Or work from the Claude Code terminal</h3>
      <p class="muted">Add swarf as an MCP server, then ask Claude Code for the part in your terminal. It edits the job here while you watch.</p>
      <code>claude mcp add swarf -- node /path/to/swarf/tools/server/src/main.ts</code>
      <p class="muted small">
        {#if bridge.status === 'connected'}
          Connected{bridge.agent ? ` to ${bridge.agent}` : ''}. <button type="button" class="link" onclick={() => bridge.forget()}>Disconnect</button>
        {:else if bridge.status === 'offline'}
          Waiting for the server (it runs while Claude Code is open). <button type="button" class="link" onclick={() => bridge.forget()}>Forget it</button>
        {:else}
          Claude Code gives you a link that connects this page.
        {/if}
      </p>
    </section>

    <div class="row">
      <span class="status">{engine === 'local' ? '' : problem ? `Without a ${problem.replace('no ', '')}, the chat runs the offline demo when no coding agent is there.` : 'Ready.'}</span>
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
  .cc { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 4px; display: flex; flex-direction: column; gap: 6px; }
  h3 { margin: 0; font-size: 14px; }
  code.inline { display: inline; padding: 1px 4px; white-space: normal; }
  code { font-family: var(--mono); font-size: 12px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; overflow-x: auto; white-space: nowrap; }
  .link { border: 0; background: none; padding: 0; color: var(--link); font-weight: 600; text-decoration: underline; }
</style>
