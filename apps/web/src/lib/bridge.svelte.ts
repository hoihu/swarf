/**
 * Connects the tab to the local swarf server, so Claude Code (through MCP) can build the job
 * here. The app link carries `#connect=<key>@<port>`; it is remembered, so a reload reconnects.
 * Each tool call runs against the store like an edit by hand (one undo step per call).
 */
import { SERVER_PROTOCOL, parseConnect, runTabTool, type ServerToTab, type TabToServer } from '@swarf/agent';
import type { Job } from '@swarf/cam';
import { store } from './store.svelte.ts';

const KEY = 'swarf.connect';

export type BridgeStatus = 'off' | 'connecting' | 'connected' | 'offline' | 'denied';

class Bridge {
  status = $state<BridgeStatus>('off');
  agent = $state<string | null>(null);
  /** The last tool call, for the header (e.g. "add · op3"). */
  last = $state<string | null>(null);
  reason = $state('');
  #target: { accessKey: string; port: number } | null = null;
  #ws: WebSocket | null = null;
  #retry = 0;
  #timer = 0;

  start(): void {
    const fromLink = parseConnect(location.hash);
    if (fromLink) {
      try {
        localStorage.setItem(KEY, JSON.stringify(fromLink));
      } catch {
        // not remembered; this session still connects
      }
      history.replaceState(null, '', location.pathname + location.search);
    }
    this.#target = fromLink ?? this.#saved();
    if (this.#target) this.#connect();
  }

  /** Forget the server (the header's disconnect). */
  forget(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // nothing to forget
    }
    this.#target = null;
    clearTimeout(this.#timer);
    this.#ws?.close();
    this.status = 'off';
  }

  #saved(): { accessKey: string; port: number } | null {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { accessKey?: unknown; port?: unknown } | null;
      return v && typeof v.accessKey === 'string' && typeof v.port === 'number' ? { accessKey: v.accessKey, port: v.port } : null;
    } catch {
      return null;
    }
  }

  #connect(): void {
    const t = this.#target;
    if (!t) return;
    this.status = this.status === 'offline' ? 'offline' : 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${t.port}`);
    } catch {
      return this.#later();
    }
    this.#ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: t.accessKey, client: 'swarf web' } satisfies TabToServer));
    ws.onmessage = (ev) => {
      let msg: ServerToTab;
      try {
        msg = JSON.parse(String(ev.data)) as ServerToTab;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'welcome':
          this.status = 'connected';
          this.agent = msg.agent;
          this.#retry = 0;
          break;
        case 'denied':
          this.status = 'denied';
          this.reason = msg.reason;
          this.#target = null;
          break;
        case 'agent':
          this.agent = msg.name;
          break;
        case 'call': {
          const r = runTabTool(
            { get: () => $state.snapshot(store.job) as Job, set: (j: Job) => store.set(j) },
            msg.tool,
            msg.input,
          );
          this.last = r.isError ? `${r.label} failed` : r.label;
          ws.send(JSON.stringify({ type: 'result', id: msg.id, isError: r.isError, text: r.content } satisfies TabToServer));
          break;
        }
      }
    };
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.status === 'denied' || !this.#target) return;
      // replaced by another tab: stay quiet rather than fight over the connection
      if (ev.code === 4000) {
        this.status = 'off';
        this.reason = 'Another tab took over the connection.';
        return;
      }
      this.status = 'offline';
      this.#later();
    };
  }

  #later(): void {
    clearTimeout(this.#timer);
    const ms = Math.min(15000, 1000 * 2 ** Math.min(this.#retry++, 4));
    this.#timer = window.setTimeout(() => this.#connect(), ms);
  }
}

export const bridge = new Bridge();
