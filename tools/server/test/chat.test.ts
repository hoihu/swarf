import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SERVER_PROTOCOL, runTabTool, type ChatEvent, type ServerToTab, type TabToServer } from '@swarf/agent';
import { emptyJob, type Job } from '@swarf/cam';
import { ChatRunner, ClaudeHarness, LocalServer, mcpHttpHandler, streamReader } from '../src/index.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const KEY = 'chat-test-key-0123456789';
let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function setup() {
  const server = new LocalServer({ accessKey: KEY, ports: [0], devPorts: [5173] });
  const claude = new ClaudeHarness(FAKE);
  const chat = new ChatRunner({ server, claude, workDir: mkdtempSync(join(tmpdir(), 'swarf-cc-')) });
  server.setChatHandler(chat.handle, claude.detect());
  server.setHttpHandler(mcpHttpHandler(server, chat.validToken));
  await server.start();
  cleanup.push(() => server.stop());

  // the tab: runs tool calls against its job, collects chat events
  let job = emptyJob('lathe');
  const events = new Map<string, ChatEvent[]>();
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: 'http://localhost:5173' });
  cleanup.push(() => ws.close());
  const welcome = await new Promise<ServerToTab>((resolve) => {
    ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: KEY, client: 'test' } satisfies TabToServer)));
    ws.once('message', (raw) => resolve(JSON.parse(String(raw))));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as ServerToTab;
    if (m.type === 'call') {
      const r = runTabTool({ get: () => job, set: (j: Job) => (job = j) }, m.tool, m.input);
      ws.send(JSON.stringify({ type: 'result', id: m.id, isError: r.isError, text: r.content } satisfies TabToServer));
    } else if (m.type === 'chat_event') events.set(m.id, [...(events.get(m.id) ?? []), m.event]);
  });
  const send = (id: string, text: string, session: string | null = null) => {
    ws.send(JSON.stringify({ type: 'chat', id, text, session } satisfies TabToServer));
    return new Promise<ChatEvent[]>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer: ${JSON.stringify(events.get(id))}`)), 15000);
      const check = setInterval(() => {
        const ev = events.get(id) ?? [];
        if (ev.some((e) => e.kind === 'done')) {
          clearTimeout(t);
          clearInterval(check);
          resolve(ev);
        }
      }, 10);
    });
  };
  return { server, chat, ws, welcome, send, job: () => job };
}

const textOf = (ev: ChatEvent[]) => ev.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('');

describe('chat via Claude Code', () => {
  it('tells the tab that Claude Code is there', async () => {
    const { welcome } = await setup();
    expect(welcome).toMatchObject({ type: 'welcome', chat: { available: true, version: '9.9.9 (Claude Code, fake)' } });
  });

  it('runs claude headless with only the swarf tools, and its edits reach the tab', async () => {
    const s = await setup();
    const ev = await s.send('c1', 'turn a pin');
    expect(ev[0]).toEqual({ kind: 'session', session: 'sess-1234' });
    expect(textOf(ev)).toBe('Adding the pin. \n\nDone: turned Ø16.');
    expect(ev.at(-1)).toMatchObject({ kind: 'done', ok: true, costUsd: 0.0123, session: 'sess-1234' });
    expect(s.job().operations).toMatchObject([{ type: 'lathe_turn', diameter: 16 }]);
  });

  it('passes the session on, and gives the run no other tools', async () => {
    const s = await setup();
    const ev = await s.send('c2', 'what can you do', 'sess-abcd');
    const t = textOf(ev);
    expect(t).toContain('tools flag: []');
    expect(t).toContain('allowed: mcp__swarf');
    expect(t).toContain('rules ok: true');
    expect(t).toContain('resumed: true');
    expect(t).toContain('add_operation');
    expect(t).not.toContain('save_gcode');
    expect(ev.at(-1)).toMatchObject({ session: 'sess-abcd' });
  });

  it('stops a run on cancel, and its token stops working', async () => {
    const s = await setup();
    const p = s.send('c3', 'wait');
    await new Promise((r) => setTimeout(r, 400));
    s.ws.send(JSON.stringify({ type: 'chat_cancel', id: 'c3' } satisfies TabToServer));
    const ev = await p;
    expect(ev.at(-1)).toMatchObject({ kind: 'done', ok: false, error: 'Stopped.' });
    const r = await fetch(`http://127.0.0.1:${s.server.port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('refuses the MCP endpoint from a browser', async () => {
    const s = await setup();
    const r = await fetch(`http://127.0.0.1:${s.server.port}/mcp`, { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: '{}' });
    expect(r.status).toBe(403);
  });

  it('reads stream-json, including an error result', () => {
    const got: ChatEvent[] = [];
    let done: unknown = null;
    const read = streamReader({ emit: (e) => got.push(e), finish: (d) => (done ??= d), log: () => {} });
    read('not json');
    read(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole text' }] } }));
    read(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }));
    expect(got).toEqual([{ kind: 'text', text: 'whole text' }]);
    expect(done).toEqual({ kind: 'done', ok: false, error: 'error_max_turns' });
  });
});
