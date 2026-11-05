#!/usr/bin/env node
// A stand-in for `claude -p` in tests: checks the arguments it should get, uses the swarf MCP
// endpoint from --mcp-config like Claude Code would, and prints stream-json.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code, fake)');
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let text = '';
for await (const c of process.stdin) text += c;

const cfg = JSON.parse(arg('--mcp-config')).mcpServers.swarf;
const rules = readFileSync(arg('--append-system-prompt-file'), 'utf8');
const session = arg('--resume') ?? 'sess-1234';
out({ type: 'system', subtype: 'init', session_id: session, mcp_servers: [{ name: 'swarf', status: 'connected' }] });

if (text.includes('wait')) await new Promise((r) => setTimeout(r, 30_000));

const client = new Client({ name: 'claude-code', version: '9.9.9' });
await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
const say = (t) => out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });

if (text.includes('pin')) {
  say('Adding the pin. ');
  const r = await client.callTool({ name: 'add_operation', arguments: { operation: { type: 'lathe_turn', tool: 1, diameter: 16, zEnd: -20 } } });
  out({ type: 'stream_event', event: { type: 'message_start' } });
  say(r.isError ? 'That failed.' : 'Done: turned Ø16.');
} else {
  say(`tools: ${tools.join(',')}; tools flag: [${arg('--tools')}]; allowed: ${arg('--allowedTools')}; rules ok: ${rules.includes('swarf')}; resumed: ${args.includes('--resume')}`);
}
await client.close();
out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.0123, session_id: session });
