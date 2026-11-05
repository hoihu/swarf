#!/usr/bin/env node
// A stand-in for the GitHub Copilot CLI in tests: checks the arguments it should get, uses the swarf
// MCP endpoint from --additional-mcp-config and prints the CLI's JSONL events.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args[0] === '--version') {
  console.log('GitHub Copilot CLI 9.9.9 (fake)');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  console.log(JSON.stringify({ mcpServers: { their_own: { type: 'local' }, swarf: { type: 'local' } } }));
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let text = '';
for await (const c of process.stdin) text += c;
/** What the user typed (after the rules, in a new conversation). */
const said = text.split("The user's message:").at(-1);

const session = args.find((a) => a.startsWith('--session-id='))?.slice('--session-id='.length);
const cfg = JSON.parse(arg('--additional-mcp-config')).mcpServers.swarf;
const client = new Client({ name: 'copilot', version: '9.9.9' });
await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
const id = 'm1';
out({ type: 'assistant.message_start', data: { messageId: id } });
if (said.includes('pin')) {
  out({ type: 'assistant.message_delta', data: { messageId: id, deltaContent: 'Adding the pin.' } });
  out({ type: 'assistant.message', data: { messageId: id, content: 'Adding the pin.' } });
  const r = await client.callTool({ name: 'add_operation', arguments: { operation: { type: 'lathe_turn', tool: 1, diameter: 18, zEnd: -20 } } });
  out({ type: 'assistant.message_start', data: { messageId: 'm2' } });
  out({ type: 'assistant.message', data: { messageId: 'm2', content: r.isError ? 'That failed.' : 'Done: turned Ø18.' } });
} else {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const info = `tools: ${tools.join(',')}; available: ${arg('--available-tools')}; allowed: ${arg('--allow-tool')}; rules first: ${text.startsWith('You are answering')}; rules in: ${text.includes("The user's message:")}; no-ask: ${args.includes('--no-ask-user')}; disabled: ${args.filter((_, i) => args[i - 1] === '--disable-mcp-server').join(',')}`;
  out({ type: 'assistant.message_delta', data: { messageId: id, deltaContent: info } });
}
await client.close();
if (said.includes('fail')) out({ type: 'session.error', data: { message: 'quota exceeded' } });
out({ type: 'result', sessionId: session, exitCode: 0 });
