<script lang="ts">
  import { tick } from 'svelte';
  import { reviewJob } from '@swarf/cam';
  import { Agent, DEMO_FALLBACK, HARNESSES, DEMO_SCRIPTS, ScriptedProvider, apiProblem, apiProvider, formatDiagnostics, formatJobContext, type AgentEvent, type ChatEvent, type HarnessId, type Provider } from '@swarf/agent';
  import { diffJobs, isEmptyDiff, type Job, type JobDiff } from '@swarf/cam';
  import { store } from './store.svelte.ts';
  import { bridge } from './bridge.svelte.ts';
  import { miniMarkdown } from './markdown.ts';

  let { onSettings }: { onSettings: () => void } = $props();

  interface Activity {
    label: string;
    ok: boolean;
    detail: string;
  }
  interface Item {
    role: 'user' | 'assistant';
    text: string;
    activity: Activity[];
    notes: string[];
    question?: { question: string; options: string[] };
    error?: string;
    /** What the turn changed, to keep or revert. */
    review?: { before: Job; after: Job; diff: JobDiff; state: 'open' | 'kept' | 'reverted' };
  }

  /** After a turn: show what changed. Earlier open reviews count as kept. */
  function review(cur: Item, before: Job): void {
    if (store.epoch !== epoch) return;
    const after = $state.snapshot(store.job) as Job;
    const diff = diffJobs(before, after);
    if (isEmptyDiff(diff)) return;
    for (const it of items) if (it.review?.state === 'open') it.review.state = 'kept';
    cur.review = { before, after, diff, state: 'open' };
  }

  function revert(it: Item): void {
    if (!it.review || JSON.stringify(store.job) !== JSON.stringify(it.review.after)) return;
    store.set(it.review.before);
    it.review.state = 'reverted';
  }

  let items = $state<Item[]>([]);
  let input = $state('');
  let busy = $state(false);
  let controller: AbortController | null = null;
  let log: HTMLDivElement;

  /** A coding agent on this computer answers (through the local swarf server). */
  const agentName = $derived(HARNESSES[store.harness]);
  const localReady = $derived(bridge.status === 'connected' && !!bridge.harness(store.harness)?.available);
  const useLocal = $derived(store.engine === 'local' || (store.engine === 'auto' && localReady));
  const demo = $derived(!useLocal && apiProblem(store.api) !== null);
  const engineLabel = $derived(useLocal ? (store.model ? `${agentName} · ${store.model}` : agentName) : demo ? 'offline demo' : store.api.model);

  /** The coding agent's conversation, continued with its session id (only with the agent that started it); and the run in progress. */
  let ccSession: { harness: HarnessId; id: string } | null = null;
  let ccRun: string | null = null;
  let ccStopped = false;

  function provider(): Provider {
    if (apiProblem(store.api)) return new ScriptedProvider(DEMO_SCRIPTS, { fallback: DEMO_FALLBACK, streamDelayMs: 12 });
    return apiProvider(store.api);
  }

  /** The job this turn works on; edits stop if the user switches to another job meanwhile. */
  let epoch = 0;
  const agent = new Agent({
    provider: new ScriptedProvider(DEMO_SCRIPTS),
    job: {
      get: () => $state.snapshot(store.job) as Job,
      set: (j: Job) => {
        if (store.epoch !== epoch) {
          controller?.abort();
          throw new Error('The job was switched; this edit was not applied.');
        }
        store.set(j, false);
      },
    },
  });

  // another job was loaded: the conversation was about the old one
  let seenEpoch = store.epoch;
  $effect(() => {
    if (store.epoch !== seenEpoch) {
      seenEpoch = store.epoch;
      if (ccRun) bridge.cancelChat(ccRun);
      if (!busy) clear();
    }
  });

  const REVIEW = 'Review this job before I run it: what would you change, and why?';

  async function scroll(): Promise<void> {
    await tick();
    log?.scrollTo({ top: log.scrollHeight });
  }

  async function send(text = input): Promise<void> {
    text = text.trim();
    if (!text || busy) return;
    input = '';
    busy = true;
    items.push({ role: 'user', text, activity: [], notes: [] });
    items.push({ role: 'assistant', text: '', activity: [], notes: [] });
    const cur = items[items.length - 1]!;
    void scroll();

    // without a model, a review is the computed list as it stands
    if (demo && text === REVIEW) {
      const look = reviewJob($state.snapshot(store.job) as Job, store.analysis);
      const warn = store.analysis.diagnostics.filter((d) => d.severity !== 'error').length;
      cur.text = look.length
        ? `No model is connected, so this is the computed list, unweighed:\n\n${look.map((f) => `- ${f.opId ? `**${f.opId}**: ` : ''}${f.text}`).join('\n')}\n\nWith an assistant connected (settings), Review weighs these for this part and adds what a list cannot see.`
        : `No model is connected, and the computed list has nothing: the order, the tools' reach and the holding raise no flags${warn ? `; the checks left ${warn} note${warn === 1 ? '' : 's'} in the Operations tab` : ''}. With an assistant connected (settings), Review also looks at what a list cannot see.`;
      busy = false;
      void scroll();
      return;
    }
    const before = JSON.stringify(store.job);
    const beforeJob = $state.snapshot(store.job) as Job;
    epoch = store.epoch;
    store.checkpoint();
    if (useLocal) {
      try {
        await viaLocal(text, cur);
      } finally {
        busy = false;
        if (store.epoch === epoch && JSON.stringify(store.job) === before) store.history = store.history.slice(0, -1);
        review(cur, beforeJob);
        void scroll();
      }
      return;
    }
    let lastWasText = false;
    agent.setProvider(provider());
    controller = new AbortController();
    const on = (e: AgentEvent) => {
      switch (e.type) {
        case 'text':
          // a new text block after tool calls starts a new paragraph
          if (!lastWasText && cur.text) cur.text += '\n\n';
          cur.text += e.delta;
          break;
        case 'tool':
          cur.activity.push({ label: e.label, ok: e.ok, detail: e.detail });
          break;
        case 'verify':
          cur.notes.push(`Checks found ${e.errors} error${e.errors === 1 ? '' : 's'}; asked the model to fix ${e.errors === 1 ? 'it' : 'them'}.`);
          break;
        case 'question':
          cur.question = { question: e.question, options: e.options };
          break;
        case 'thinking':
        case 'usage':
          return;
        case 'done':
          if (e.reason === 'error' || e.reason === 'refusal' || e.reason === 'max_tokens' || e.reason === 'budget') cur.error = e.message ?? e.reason;
          else if (e.message) cur.notes.push(e.message);
          break;
      }
      lastWasText = e.type === 'text';
      void scroll();
    };
    try {
      await agent.run(text, on, controller.signal);
    } finally {
      busy = false;
      controller = null;
      // nothing changed: no undo point needed
      if (store.epoch === epoch && JSON.stringify(store.job) === before) store.history = store.history.slice(0, -1);
      review(cur, beforeJob);
      void scroll();
    }
  }

  /** One turn answered by a coding agent on this computer; sent back once or twice to fix errors the checks still find. */
  async function viaLocal(text: string, cur: Item): Promise<void> {
    const harness = store.harness;
    const name = HARNESSES[harness];
    if (!localReady) {
      cur.error =
        bridge.status !== 'connected'
          ? `${name} answers through the swarf server on this computer: start it with npm run server and open the link it prints.`
          : (bridge.harness(harness)?.reason ?? `The swarf server cannot run ${name}.`);
      return;
    }
    if (ccSession?.harness !== harness) ccSession = null;
    ccStopped = false;
    bridge.batch = true;
    bridge.onCall = (label, ok, detail) => {
      cur.activity.push({ label, ok, detail });
      void scroll();
    };
    try {
      for (let round = 0; ; round++) {
        const message =
          round === 0
            ? `${formatJobContext($state.snapshot(store.job) as Job)}

${text}`
            : `[job verification] The job still has errors. Fix them (or remove the operation and say why), then finish:
${formatDiagnostics(store.analysis.diagnostics.filter((d) => d.severity === 'error'))}`;
        const done = await new Promise<Extract<ChatEvent, { kind: 'done' }>>((resolve) => {
          const id = crypto.randomUUID();
          ccRun = id;
          const sent = bridge.sendChat({ id, text: message, session: ccSession?.id ?? null, harness, ...(store.model ? { model: store.model } : {}) }, (e) => {
            if (e.kind === 'session') ccSession = { harness, id: e.session };
            else if (e.kind === 'text') cur.text += e.text;
            else if (e.kind === 'status') cur.notes.push(e.text);
            else if (e.kind === 'done') {
              if (e.session) ccSession = { harness, id: e.session };
              resolve(e);
            }
            void scroll();
          });
          if (!sent) resolve({ kind: 'done', ok: false, error: 'Not connected to the swarf server.' });
        });
        ccRun = null;
        cur.text = cur.text.trim();
        if (!done.ok) {
          cur.error = done.error ?? `${name} stopped.`;
          return;
        }
        const errors = store.analysis.diagnostics.filter((d) => d.severity === 'error').length;
        if (!errors || round >= 2 || ccStopped) {
          if (errors) cur.notes.push(`${errors} error${errors === 1 ? '' : 's'} remain.`);
          return;
        }
        cur.notes.push(`Checks found ${errors} error${errors === 1 ? '' : 's'}; asked ${name} to fix ${errors === 1 ? 'it' : 'them'}.`);
        cur.text += '\n\n';
      }
    } finally {
      bridge.batch = false;
      bridge.onCall = null;
    }
  }

  function stop(): void {
    controller?.abort();
    if (ccRun) {
      ccStopped = true;
      bridge.cancelChat(ccRun);
    }
  }

  function clear(): void {
    agent.reset();
    ccSession = null;
    items = [];
  }

  function key(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const examples = $derived(
    store.job.machine.kind === 'lathe'
      ? ['Turn a pin Ø16 × 25 with a 0.5 mm chamfer and part it off', 'Add a 2 mm wide groove for a circlip, Ø14, 3 mm from the face', 'Drill a Ø6 hole 15 deep on centre']
      : ['Mill a 30 × 20 pocket 5 deep in the middle', 'Four Ø5 holes 6 mm in from each corner, through', 'Cut the outside contour 2 mm in from the edges'],
  );
</script>

<section class="chat">
  <header>
    <b>Assistant</b>
    <button class="model" title={demo ? 'No API key set and no coding agent: scripted demo answers. Change in settings.' : 'Who answers: change in settings'} onclick={onSettings}>{engineLabel}</button>
    <span class="grow"></span>
    {#if items.length}<button class="link" onclick={clear}>New conversation</button>{/if}
  </header>

  <div class="log" bind:this={log}>
    {#if !items.length}
      <div class="intro">
        <p>Describe the part in your own words: sizes, which faces, what is already done. The assistant builds the operations, the checks verify them, and you review the toolpath before running anything.</p>
        {#if demo}
          <p class="muted">No model is connected, so only two scripted examples work. Start the swarf server (<code>npm run server</code>) to use Claude Code, GitHub Copilot, Codex or OpenCode on this computer, or <button class="link" onclick={onSettings}>add an API key</button>.</p>
        {:else if useLocal}
          <p class="muted">{agentName} on this computer answers, with your own login. It only gets swarf's tools.</p>
        {/if}
        <div class="examples">
          {#each examples as ex (ex)}
            <button onclick={() => send(ex)}>{ex}</button>
          {/each}
        </div>
      </div>
    {/if}
    {#each items as it, i (i)}
      {#if it.role === 'user'}
        <div class="msg user">{it.text}</div>
      {:else}
        <div class="msg bot">
          {#if it.activity.length}
            <ul class="activity">
              {#each it.activity as a, k (k)}
                <li class:bad={!a.ok}><span class="mark">{a.ok ? '✓' : '✕'}</span>{a.ok ? a.detail : a.label}{#if !a.ok}<span class="why">{a.detail}</span>{/if}</li>
              {/each}
            </ul>
          {/if}
          {#each it.notes as n, k (k)}<p class="note">{n}</p>{/each}
          {#if it.text}<div class="text">{@html miniMarkdown(it.text)}</div>{:else if busy && i === items.length - 1}<p class="thinking">Working…</p>{/if}
          {#if it.question}
            <p class="text">{it.question.question}</p>
            <div class="options">
              {#each it.question.options as o (o)}
                <button class="btn" disabled={busy || i !== items.length - 1} onclick={() => send(o)}>{o}</button>
              {/each}
            </div>
          {/if}
          {#if it.error}<p class="error">{it.error}</p>{/if}
          {#if it.review}
            {@const r = it.review}
            {@const current = JSON.stringify(store.job) === JSON.stringify(r.after)}
            <div class="review" class:done={r.state !== 'open'}>
              <p class="rh">{r.state === 'reverted' ? 'Reverted' : 'Changes'}</p>
              <ul>
                {#each r.diff.added as a (a.id)}<li class="add">Added {a.label}</li>{/each}
                {#each r.diff.changed as c (c.id)}<li class="chg">Changed {c.label}<span>{c.fields.join(', ')}</span></li>{/each}
                {#each r.diff.removed as a (a.id)}<li class="del">Removed {a.label}</li>{/each}
                {#if r.diff.reordered}<li class="chg">Reordered the operations</li>{/if}
                {#each r.diff.other as o (o)}<li class="chg">Changed {o}</li>{/each}
              </ul>
              {#if r.state === 'open'}
                <div class="options">
                  <button class="btn" onclick={() => (r.state = 'kept')}>Keep</button>
                  <button class="btn danger" disabled={!current || busy} title={current ? '' : 'The job has changed since; use Undo instead'} onclick={() => revert(it)}>Revert this turn</button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <form class="compose" onsubmit={(e) => { e.preventDefault(); void send(); }}>
    <textarea rows="2" bind:value={input} onkeydown={key} placeholder="e.g. face, then turn Ø20 over 30 mm" aria-label="Message"></textarea>
    {#if busy}
      <button type="button" class="btn" onclick={stop}>Stop</button>
    {:else}
      <div class="sendcol">
        <button type="submit" class="btn pri" disabled={!input.trim()}>Send</button>
        <button type="button" class="btn" disabled={!store.job.operations.length} title="The assistant goes through the job as a machinist would before pressing start: holding, order, tools, speeds. It changes nothing." onclick={() => send(REVIEW)}>Review</button>
      </div>
    {/if}
  </form>
</section>

<style>
  .sendcol { display: flex; flex-direction: column; gap: 4px; }
  .chat { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--panel); }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); flex: none; }
  .model { font: inherit; font-size: 12px; color: var(--ink-3); background: var(--panel-2); border: 1px solid var(--line); padding: 1px 8px; border-radius: 10px; cursor: pointer; }
  .model:hover { color: var(--ink); border-color: var(--line-2); }
  .grow { flex: 1; }
  .link { border: 0; background: none; color: var(--link); padding: 0; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
  .log { flex: 1; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .intro p { margin: 0 0 10px; color: var(--ink-2); max-width: 60ch; }
  .muted { color: var(--ink-3); }
  .muted code { font-family: var(--mono); font-size: 12px; }
  .examples { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .examples button { text-align: left; border: 1px dashed var(--line-2); background: var(--panel-2); border-radius: 8px; padding: 8px 10px; color: var(--ink-2); }
  .examples button:hover { border-style: solid; color: var(--ink); }
  .msg { max-width: 92%; }
  .msg.user { align-self: flex-end; background: var(--iron); color: var(--on-iron); padding: 8px 12px; border-radius: 12px 12px 3px 12px; white-space: pre-wrap; }
  .msg.bot { align-self: flex-start; }
  .text { margin: 4px 0; line-height: 1.5; }
  .text :global(p) { margin: 0 0 8px; }
  .text :global(ul) { margin: 0 0 8px; padding-left: 18px; }
  .text :global(code) { font-family: var(--mono); font-size: 12px; }
  .thinking { margin: 4px 0; color: var(--ink-3); }
  .activity { list-style: none; margin: 0 0 6px; padding: 6px 10px; border-left: 2px solid var(--line-2); display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; color: var(--ink-2); }
  .activity .mark { display: inline-block; width: 16px; color: var(--ok); }
  .activity .bad .mark { color: var(--err); }
  .activity .why { display: block; padding-left: 16px; color: var(--err); }
  .note { margin: 4px 0; font-size: 12.5px; color: var(--warn); }
  .error { margin: 6px 0; padding: 6px 9px; border-radius: 6px; background: var(--err-soft); color: var(--err); }
  .options { display: flex; flex-wrap: wrap; gap: 6px; }
  .review { margin-top: 8px; border: 1px solid var(--line-2); border-radius: 8px; padding: 8px 10px; background: var(--panel-2); }
  .review.done { opacity: 0.7; }
  .review .rh { margin: 0 0 4px; font-weight: 700; font-size: 12.5px; }
  .review ul { list-style: none; margin: 0 0 6px; padding: 0; font-size: 12.5px; display: flex; flex-direction: column; gap: 2px; }
  .review li::before { display: inline-block; width: 14px; font-weight: 700; }
  .review li.add::before { content: '+'; color: var(--ok); }
  .review li.del::before { content: '−'; color: var(--err); }
  .review li.chg::before { content: '~'; color: var(--warn); }
  .review li span { display: block; padding-left: 14px; color: var(--ink-3); }
  .compose { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); flex: none; }
  .compose textarea { flex: 1; resize: none; border: 1px solid var(--line-2); border-radius: 8px; padding: 8px 10px; background: var(--panel); line-height: 1.4; }
</style>
