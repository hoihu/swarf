<script lang="ts" module>
  /** Which sections the user has open, kept between visits ('all': every one, for the checks in scripts/). */
  const KEY = 'swarf.sections';
  function load(): Record<string, boolean> | 'all' {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === 'all') return 'all';
      return (JSON.parse(raw ?? '{}') as Record<string, boolean>) ?? {};
    } catch {
      return {};
    }
  }
  const kept = load();
</script>

<script lang="ts">
  /**
   * A part of a pane that folds away: its title, what state it is in (so that it says something
   * while shut), and its contents. Shut or open is remembered.
   */
  import type { Snippet } from 'svelte';

  let { id, title, status = '', tone = '', open: initial = false, force = false, children }: { id: string; title: string; status?: string; tone?: '' | 'ok' | 'warn' | 'err'; open?: boolean; force?: boolean; children: Snippet } = $props();
  // svelte-ignore state_referenced_locally
  let open = $state(kept === 'all' ? true : (kept[id] ?? initial));

  // something in it needs the user now
  $effect(() => {
    if (force) open = true;
  });

  function toggled(e: Event): void {
    open = (e.currentTarget as HTMLDetailsElement).open;
    if (kept === 'all') return;
    kept[id] = open;
    try {
      localStorage.setItem(KEY, JSON.stringify(kept));
    } catch {
      // not kept
    }
  }
</script>

<details class="sec" {open} ontoggle={toggled} data-section={id}>
  <summary>
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
    <span class="t">{title}</span>
    {#if status}<span class="st {tone}">{status}</span>{/if}
  </summary>
  <div class="in">{@render children()}</div>
</details>

<style>
  .sec { border-top: 1px solid var(--line); }
  .sec:last-child { border-bottom: 1px solid var(--line); }
  summary { display: flex; align-items: center; gap: 8px; padding: 11px 14px; cursor: pointer; list-style: none; user-select: none; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: var(--panel-2); }
  summary svg { color: var(--ink-3); flex: none; transition: transform 0.12s; }
  .sec[open] > summary svg { transform: rotate(90deg); }
  .t { font-weight: 700; font-size: 13.5px; }
  .st { margin-left: auto; font-size: 12px; color: var(--ink-3); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .st.ok { color: var(--ok); }
  .st.warn { color: var(--warn); font-weight: 600; }
  .st.err { color: var(--err); font-weight: 700; }
  .in { padding: 2px 14px 16px; }
  @media (prefers-reduced-motion: reduce) {
    summary svg { transition: none; }
  }
</style>
