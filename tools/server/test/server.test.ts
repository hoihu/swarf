import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SERVER_PROTOCOL, runTabTool, type ServerToTab, type TabToServer } from '@swarf/agent';
import { emptyJob, type Job } from '@swarf/cam';
import { LocalServer, createMcpServer } from '../src/index.ts';

const KEY = 'test-key-0123456789abcdef';
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function startServer(): Promise<LocalServer> {
  const s = new LocalServer({ accessKey: KEY, ports: [0], devPorts: [5173], callTimeoutMs: 3000 });
  await s.start();
  cleanup.push(() => s.stop());
  return s;
}

/** A tab that runs tools against an in-memory job, like the app does. */
async function fakeTab(s: LocalServer, opts: { key?: string; origin?: string } = {}): Promise<{ ws: WebSocket; job: () => Job; first: ServerToTab }> {
  let job = emptyJob('lathe');
  const port = { get: () => job, set: (j: Job) => (job = j) };
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}`, { origin: opts.origin ?? 'http://localhost:5173' });
  cleanup.push(async () => ws.close());
  const first = await new Promise<ServerToTab>((resolve, reject) => {
    ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: opts.key ?? KEY, client: 'test' } satisfies TabToServer)));
    ws.once('message', (raw) => resolve(JSON.parse(String(raw)) as ServerToTab));
    ws.once('close', () => resolve({ type: 'denied', reason: 'closed' }));
    ws.once('error', reject);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as ServerToTab;
    if (msg.type !== 'call') return;
    const r = runTabTool(port, msg.tool, msg.input);
    ws.send(JSON.stringify({ type: 'result', id: msg.id, isError: r.isError, text: r.content } satisfies TabToServer));
  });
  return { ws, job: () => job, first };
}

async function mcpClient(s: LocalServer, cwd?: string): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(s, cwd ? { cwd } : {});
  await server.connect(a);
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe('relay', () => {
  it('accepts a tab with the key and refuses others', async () => {
    const s = await startServer();
    expect((await fakeTab(s, { key: 'wrong-key-0123456789' })).first).toEqual({ type: 'denied', reason: 'wrong access key' });
    expect((await fakeTab(s, { origin: 'https://evil.example' })).first.type).toBe('denied');
    const ok = await fakeTab(s);
    expect(ok.first).toMatchObject({ type: 'welcome', protocol: SERVER_PROTOCOL });
    expect(s.connected).toBe(true);
  });

  it('tells the model how to connect when no tab is open', async () => {
    const s = await startServer();
    const r = await s.call('get_context', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`#connect=${KEY}@${s.port}`);
  });
});

describe('MCP', () => {
  it('lists the tools with instructions', async () => {
    const s = await startServer();
    const c = await mcpClient(s);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_context');
    expect(names).toContain('add_operation');
    expect(names).toContain('save_gcode');
    expect(names).not.toContain('ask_user');
    expect(c.getInstructions()).toMatch(/Never write G-code by hand/);
  });

  it('edits the job in the tab and saves the G-code', async () => {
    const s = await startServer();
    const tab = await fakeTab(s);
    const c = await mcpClient(s, mkdtempSync(join(tmpdir(), 'swarf-')));

    expect(text(await c.callTool({ name: 'get_context', arguments: {} }))).toMatch(/operations: none yet/);
    const add = await c.callTool({ name: 'add_operation', arguments: { operation: { type: 'lathe_turn', tool: 1, diameter: 20, zEnd: -20 } } });
    expect(add.isError).toBeFalsy();
    expect(tab.job().operations).toHaveLength(1);

    const dir = mkdtempSync(join(tmpdir(), 'swarf-out-'));
    const saved = await c.callTool({ name: 'save_gcode', arguments: { path: join(dir, 'pin') } });
    expect(text(saved)).toMatch(/Wrote \d+ lines/);
    expect(readFileSync(join(dir, 'pin.nc'), 'utf8')).toMatch(/G18 G7/);

    await c.callTool({ name: 'update_operation', arguments: { id: 'op1', changes: { zEnd: -90 } } });
    const refused = await c.callTool({ name: 'save_gcode', arguments: { path: join(dir, 'bad.nc') } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/CHUCK/);
  });

  it('tells the tab which agent is driving', async () => {
    const s = await startServer();
    const tab = await fakeTab(s);
    const seen = new Promise<ServerToTab>((resolve) => tab.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerToTab;
      if (m.type === 'agent') resolve(m);
    }));
    await mcpClient(s);
    expect(await seen).toEqual({ type: 'agent', name: 'Claude Code' });
  });
});
