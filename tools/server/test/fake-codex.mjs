#!/usr/bin/env node
// A stand-in for `codex exec --json` in tests: reads its -c settings, uses the swarf MCP endpoint
// from them (token from the environment variable they name) and prints Codex's JSON events.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(process.env.FAKE_CODEX_VERSION ?? 'codex-cli 0.166.0');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  console.log(JSON.stringify([{ name: 'their_own' }, { name: 'swarf' }]));
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// -c key=value, the value TOML that here is written as JSON (tables as {"k"=v})
const cfg = {};
for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
  const [k, ...v] = args[++i].split('=');
  cfg[k] = v.join('=');
}
let text = '';
for await (const c of process.stdin) text += c;
const resumed = args[1] === 'resume';
const thread = resumed ? args.at(-2) : 'thread-77';
out({ type: 'thread.started', thread_id: thread });
out({ type: 'turn.started' });
if (text.includes('fail')) {
  out({ type: 'error', message: 'Reconnecting... 1/5' });
  out({ type: 'error', message: 'unexpected status 401 Unauthorized' });
  process.exit(1);
}
const servers = cfg.mcp_servers;
const url = /"swarf_chat"=\{"url"="([^"]+)"/.exec(servers)[1];
const tokenVar = /"bearer_token_env_var"="([^"]+)"/.exec(servers)[1];
const client = new Client({ name: 'codex', version: '9.9.9' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${process.env[tokenVar]}` } } }));
if (text.includes('pin')) {
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'Adding the pin.' } });
  const r = await client.callTool({ name: 'add_operation', arguments: { operation: { type: 'lathe_turn', tool: 1, diameter: 17, zEnd: -20 } } });
  out({ type: 'item.completed', item: { type: 'agent_message', text: r.isError ? 'That failed.' : 'Done: turned Ø17.' } });
} else {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const rules = readFileSync(JSON.parse(cfg.model_instructions_file), 'utf8');
  const info = `tools: ${tools.join(',')}; theirs off: ${servers.includes('"their_own"={"enabled"=false}') && servers.includes('"swarf"={"enabled"=false}')}; sandbox: ${cfg.sandbox_mode}; rules ok: ${rules.startsWith('You are answering')}; resumed: ${resumed}`;
  out({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking it over' } });
  out({ type: 'item.completed', item: { type: 'agent_message', text: info } });
}
await client.close();
out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
