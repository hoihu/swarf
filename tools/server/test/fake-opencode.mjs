#!/usr/bin/env node
// A stand-in for OpenCode in tests: `run --format json` reads its agent and the swarf MCP endpoint
// from OPENCODE_CONFIG_CONTENT; `export` returns the session (with a last text the stream left out);
// `debug config` names the user's MCP servers.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args[0] === '--version') {
  console.log('9.9.9');
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'config') {
  console.log(JSON.stringify({ mcp: { their_own: { type: 'local' }, swarf: { type: 'local' } } }));
  process.exit(0);
}
if (args[0] === 'export') {
  // the stream lost the last part of the answer
  console.log('Exporting session...');
  console.log(JSON.stringify({ messages: [{ info: { role: 'user' }, parts: [] }, { info: { role: 'assistant' }, parts: [{ id: 'p1', type: 'text', text: 'Adding the pin.' }, { id: 'p9', type: 'text', text: 'Exported tail.' }] }] }));
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let text = '';
for await (const c of process.stdin) text += c;
const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const agent = cfg.agent[arg('--agent')];
const rules = readFileSync(/^\{file:(.*)\}$/.exec(agent.prompt)[1], 'utf8');
const server = cfg.mcp.swarf;
const session = arg('--session') ?? 'ses_fake1';
const client = new Client({ name: 'opencode', version: '9.9.9' });
await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
if (text.includes('pin')) {
  out({ type: 'text', sessionID: session, part: { id: 'p1', type: 'text', text: 'Adding the pin.' } });
  await client.callTool({ name: 'add_operation', arguments: { operation: { type: 'lathe_turn', tool: 1, diameter: 15, zEnd: -20 } } });
} else {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const info = `tools: ${tools.join(',')}; agent tools: ${JSON.stringify(agent.tools)}; bash: ${agent.permission.bash}; theirs: ${JSON.stringify(cfg.mcp.their_own)}; rules ok: ${rules.startsWith('You are answering')}; project config off: ${process.env.OPENCODE_DISABLE_PROJECT_CONFIG}; resumed: ${args.includes('--session')}`;
  out({ type: 'text', sessionID: session, part: { id: 'p1', type: 'text', text: info } });
}
await client.close();
if (text.includes('fail')) out({ type: 'error', sessionID: session, error: { name: 'APIError', data: { message: 'model not found' } } });
process.exit(text.includes('fail') ? 1 : 0);
