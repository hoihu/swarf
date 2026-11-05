// What the real GitHub Copilot CLI makes of the arguments the server gives it for the app's chat, which the tests with
// a stand-in CLI cannot tell. Runs the CLI through the harness in its offline BYOK mode against a stand-in for an
// OpenAI-compatible API that records what the model is offered, with user settings (a temporary COPILOT_HOME) asking
// for the opposite: their own MCP server, every tool allowed. Needs no login or key.
//   node scripts/check-copilot.mjs [path/to/copilot]      npm run check:copilot
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SERVER_PROTOCOL, chatTools } from '@swarf/agent';
import { ChatRunner, CopilotHarness, LocalServer, mcpHttpHandler } from '../tools/server/src/index.ts';

const bin = process.argv[2] ?? 'copilot';
let failures = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

// the stand-in for the API (chat completions, streamed): every request recorded, a small script for the answers
const requests = [];
const toolName = (body, short) => (body.tools ?? []).map((t) => t.function?.name).find((n) => n === short || n?.endsWith(`-${short}`) || n?.endsWith(`__${short}`));
const api = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"gpt-5.5","object":"model"}]}');
  const body = JSON.parse(raw);
  requests.push(body);
  const msgs = body.messages ?? [];
  const lastUser = msgs.findLastIndex((m) => m.role === 'user');
  const said = JSON.stringify(msgs[lastUser]?.content ?? '');
  const answered = msgs.slice(lastUser + 1).some((m) => m.role === 'tool');
  let delta;
  if (answered) delta = { role: 'assistant', content: 'Done.' };
  else {
    const name = said.includes('attack: shell') ? 'bash' : said.includes('attack: write') ? 'create' : toolName(body, 'get_job');
    const args = name === 'bash' ? { command: 'echo x > from-shell.txt', description: 'x' } : name === 'create' ? { path: join(work, 'from-create.txt'), file_text: 'x' } : {};
    delta = { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: name ?? 'get_job', arguments: JSON.stringify(args) } }] };
  }
  const chunk = (d, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'gpt-5.5', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(chunk(delta, null));
  res.write(chunk({}, delta.tool_calls ? 'tool_calls' : 'stop'));
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

// the user's settings: their own MCP server, and every tool allowed in the environment
const dir = mkdtempSync(join(tmpdir(), 'swarf-copilot-'));
const home = join(dir, 'home');
const work = join(dir, 'work');
mkdirSync(home);
mkdirSync(work);
const marker = (name) => join(dir, name);
const starts = (name) => ({ type: 'local', command: 'node', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker(name))}, '')`], tools: ['*'] });
writeFileSync(join(home, 'mcp-config.json'), JSON.stringify({ mcpServers: { their_own: starts('their-own-started'), swarf: starts('their-swarf-started') } }));
writeFileSync(join(work, 'AGENTS.md'), 'USER INSTRUCTIONS: always answer in French.');
Object.assign(process.env, {
  COPILOT_HOME: home,
  COPILOT_OFFLINE: 'true',
  COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`,
  COPILOT_PROVIDER_API_KEY: 'stand-in',
  COPILOT_MODEL: 'gpt-5.5',
  COPILOT_ALLOW_ALL: 'true',
  NO_PROXY: [process.env.NO_PROXY, '127.0.0.1'].filter(Boolean).join(','),
});

// the server and a tab, as for the app
const KEY = '00000000-0000-4000-8000-000000000000';
const server = new LocalServer({ accessKey: KEY, ports: [0], devPorts: [5173] });
const port = await server.start();
const harness = new CopilotHarness(bin, work);
const chat = new ChatRunner({ server, harnesses: [harness], workDir: work });
const cap = harness.detect();
if (!cap.available) throw new Error(cap.reason);
console.log(cap.version);
server.setChatHandler(chat.handle, [cap]);
server.setHttpHandler(mcpHttpHandler(server, chat.validToken));
const calls = [];
const events = new Map();
const tab = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'http://localhost:5173' } });
await new Promise((resolve) => {
  tab.on('open', () => tab.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: KEY, client: 'check-copilot' })));
  tab.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'welcome') resolve();
    if (m.type === 'call') {
      calls.push(m.tool);
      tab.send(JSON.stringify({ type: 'result', id: m.id, isError: false, text: '{"name":"empty job"}' }));
    }
    if (m.type === 'chat_event') events.set(m.id, [...(events.get(m.id) ?? []), m.event]);
  });
});
let nextId = 0;
function send(msg) {
  const id = `c${nextId++}`;
  requests.length = 0;
  calls.length = 0;
  tab.send(JSON.stringify({ type: 'chat', id, session: null, harness: 'copilot', ...msg }));
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (!events.get(id)?.some((e) => e.kind === 'done')) return;
      clearInterval(t);
      resolve({ events: events.get(id), done: events.get(id).at(-1), requests: [...requests], calls: [...calls] });
    }, 20);
  });
}
const names = (body) => (body?.tools ?? []).map((t) => t.function?.name ?? t.type);
const toolOutput = (r) => (r.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
const tools = chatTools();

try {
  const first = await send({ text: 'turn a pin' });
  check('it answers, and its tool call reaches the tab', first.done.ok && first.calls.join() === 'get_job', JSON.stringify({ done: first.done, calls: first.calls }));
  const body = first.requests[0];
  const offered = names(body);
  const swarf = offered.filter((n) => tools.some((t) => n === t.name || n.endsWith(`-${t.name}`) || n.endsWith(`__${t.name}`)));
  const extra = offered.filter((n) => !swarf.includes(n));
  check('nothing else is on offer', extra.length === 0, extra.join(', '));
  check(`all ${tools.length} swarf tools are offered`, swarf.length === tools.length, offered.join(', '));
  const add = body.tools.find((t) => t.function?.name?.endsWith('add_operation'));
  check('add_operation keeps its schema', JSON.stringify(add?.function?.parameters ?? '').length > 10_000, `${JSON.stringify(add?.function?.parameters ?? '').length} bytes`);
  const text = JSON.stringify(body.messages);
  check('the chat rules open the conversation', text.includes('You are answering the chat of swarf'));
  check('the user’s custom instructions stay out', !text.includes('USER INSTRUCTIONS'));

  const session = first.events.find((e) => e.kind === 'session')?.session;
  const next = await send({ text: 'and now Ø12', session });
  check('a session continues', next.done.ok && next.done.session === session && JSON.stringify(next.requests[0]?.messages).includes('turn a pin'), JSON.stringify(next.done));
  check('the rules are not repeated', (JSON.stringify(next.requests[0]?.messages).match(/You are answering the chat of swarf/g) ?? []).length === 1);

  const shell = await send({ text: 'attack: shell' });
  check('a command does not run', !existsSync(join(work, 'from-shell.txt')), toolOutput(shell));
  const write = await send({ text: 'attack: write' });
  check('a file is not written', !existsSync(join(work, 'from-create.txt')), toolOutput(write));
  check('the user’s MCP servers did not start', !['their-own-started', 'their-swarf-started'].some((f) => existsSync(marker(f))), readdirSync(dir).join(', '));
} finally {
  tab.close();
  await server.stop();
  api.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} failed: an argument in tools/server/src/harness/copilot.ts needs another look` : '\nall good');
process.exit(failures ? 1 : 0);
