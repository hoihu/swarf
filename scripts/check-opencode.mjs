// What the real OpenCode CLI makes of the run's config for the app's chat, which the tests with a stand-in CLI cannot
// tell. Runs the CLI through the harness against a stand-in for an OpenAI-compatible API that records what the model
// is offered, with user settings (temporary XDG folders) asking for the opposite: their own MCP server, a default
// agent with every tool. Needs no login or key (OpenCode fetches its provider package from npm on the first run).
//   node scripts/check-opencode.mjs [path/to/opencode]      npm run check:opencode
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SERVER_PROTOCOL, chatTools } from '@swarf/agent';
import { ChatRunner, LocalServer, OpenCodeHarness, OPENCODE_SERVER, mcpHttpHandler } from '../tools/server/src/index.ts';

const bin = process.argv[2] ?? 'opencode';
let failures = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

// the stand-in for the API (chat completions, streamed): every request with tools recorded, a small script for the answers
const requests = [];
const api = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"standin-model","object":"model"}]}');
  const body = JSON.parse(raw);
  const msgs = body.messages ?? [];
  const lastUser = msgs.findLastIndex((m) => m.role === 'user');
  const said = JSON.stringify(msgs[lastUser]?.content ?? '');
  const answered = msgs.slice(lastUser + 1).some((m) => m.role === 'tool');
  let delta;
  if (!body.tools?.length) delta = { role: 'assistant', content: 'A title' }; // the title of the session
  else {
    requests.push(body);
    if (answered) delta = { role: 'assistant', content: 'Done.' };
    else {
      const [name, args] = said.includes('attack: shell')
        ? ['bash', { command: `echo x > ${join(work, 'from-shell.txt')}`, description: 'x' }]
        : said.includes('attack: write')
          ? ['write', { filePath: join(work, 'from-write.txt'), content: 'x' }]
          : [`${OPENCODE_SERVER}_get_job`, {}];
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    }
  }
  const chunk = (d, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'standin-model', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(chunk(delta, null));
  res.write(chunk({}, delta.tool_calls ? 'tool_calls' : 'stop'));
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

// the user's settings: their provider, their own MCP servers, and a project config in the working folder
const dir = mkdtempSync(join(tmpdir(), 'swarf-opencode-'));
const work = join(dir, 'work');
for (const d of ['config/opencode', 'data', 'cache', 'state', 'work']) mkdirSync(join(dir, d), { recursive: true });
const marker = (name) => join(dir, name);
const starts = (name) => ({ type: 'local', command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker(name))}, '')`], enabled: true });
writeFileSync(
  join(dir, 'config/opencode/opencode.json'),
  JSON.stringify({
    model: 'standin/standin-model',
    provider: { standin: { npm: '@ai-sdk/openai-compatible', name: 'stand-in', options: { baseURL: `http://127.0.0.1:${api.address().port}/v1`, apiKey: 'x' }, models: { 'standin-model': { name: 'Stand-in' } } } },
    mcp: { their_own: starts('their-own-started') },
    permission: { bash: 'allow', edit: 'allow', webfetch: 'allow' },
    instructions: [join(dir, 'config/opencode/rules.md')],
  }),
);
writeFileSync(join(dir, 'config/opencode/rules.md'), 'USER INSTRUCTIONS: always answer in French.');
writeFileSync(join(work, 'AGENTS.md'), 'PROJECT INSTRUCTIONS: always answer in Italian.');
mkdirSync(join(dir, 'home/.claude'), { recursive: true });
writeFileSync(join(dir, 'home/.claude/CLAUDE.md'), 'CLAUDE INSTRUCTIONS: always answer in Spanish.');
Object.assign(process.env, {
  HOME: join(dir, 'home'),
  XDG_CONFIG_HOME: join(dir, 'config'),
  XDG_DATA_HOME: join(dir, 'data'),
  XDG_CACHE_HOME: join(dir, 'cache'),
  XDG_STATE_HOME: join(dir, 'state'),
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  NO_PROXY: [process.env.NO_PROXY, '127.0.0.1'].filter(Boolean).join(','),
});

// the server and a tab, as for the app
const KEY = '00000000-0000-4000-8000-000000000000';
const server = new LocalServer({ accessKey: KEY, ports: [0], devPorts: [5173] });
const port = await server.start();
const harness = new OpenCodeHarness(bin, work);
const chat = new ChatRunner({ server, harnesses: [harness], workDir: work });
const cap = harness.detect();
if (!cap.available) throw new Error(cap.reason);
console.log(`OpenCode ${cap.version}`);
server.setChatHandler(chat.handle, [cap]);
server.setHttpHandler(mcpHttpHandler(server, chat.validToken));
const calls = [];
const events = new Map();
const tab = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'http://localhost:5173' } });
await new Promise((resolve) => {
  tab.on('open', () => tab.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: KEY, client: 'check-opencode' })));
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
  tab.send(JSON.stringify({ type: 'chat', id, session: null, harness: 'opencode', ...msg }));
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (!events.get(id)?.some((e) => e.kind === 'done')) return;
      clearInterval(t);
      resolve({ events: events.get(id), done: events.get(id).at(-1), requests: [...requests], calls: [...calls] });
    }, 20);
  });
}
const names = (body) => (body?.tools ?? []).map((t) => t.function?.name ?? t.type);
const tools = chatTools();

try {
  const first = await send({ text: 'turn a pin' });
  check('it answers, and its tool call reaches the tab', first.done.ok && first.calls.join() === 'get_job', JSON.stringify({ done: first.done, calls: first.calls }));
  const body = first.requests[0];
  const offered = names(body);
  const extra = offered.filter((n) => !n.startsWith(`${OPENCODE_SERVER}_`));
  check('nothing else is on offer', extra.length === 0, extra.join(', '));
  check(`all ${tools.length} swarf tools are offered`, tools.every((t) => offered.includes(`${OPENCODE_SERVER}_${t.name}`)), offered.join(', '));
  const add = body?.tools?.find((t) => t.function?.name === `${OPENCODE_SERVER}_add_operation`);
  check('add_operation keeps its schema', JSON.stringify(add?.function?.parameters ?? '').length > 10_000, `${JSON.stringify(add?.function?.parameters ?? '').length} bytes`);
  const system = JSON.stringify((body?.messages ?? []).filter((m) => m.role === 'system'));
  check('its prompt is the chat rules', system.includes('You are answering the chat of swarf'));
  // the user's own global instructions are theirs to give (OpenCode appends config instruction lists, it cannot be told to drop them)
  check('the project’s and Claude Code’s instructions stay out', !system.includes('PROJECT INSTRUCTIONS') && !system.includes('CLAUDE INSTRUCTIONS'), system.slice(0, 300));

  const session = first.events.find((e) => e.kind === 'session')?.session;
  const next = await send({ text: 'and now Ø12', session });
  check('a session continues', next.done.ok && next.done.session === session && JSON.stringify(next.requests[0]?.messages).includes('turn a pin'), JSON.stringify(next.done));

  await send({ text: 'attack: shell' });
  check('a command does not run', !existsSync(join(work, 'from-shell.txt')));
  await send({ text: 'attack: write' });
  check('a file is not written', !existsSync(join(work, 'from-write.txt')));
  check('the user’s MCP servers did not start', !existsSync(marker('their-own-started')), readdirSync(dir).join(', '));
} finally {
  tab.close();
  await server.stop();
  api.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} failed: a setting in tools/server/src/harness/opencode.ts needs another look` : '\nall good');
process.exit(failures ? 1 : 0);
