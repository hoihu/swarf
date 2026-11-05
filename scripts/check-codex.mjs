// What the real Codex CLI makes of the settings the server gives it for the app's chat, which the tests with a
// stand-in cannot tell. Codex has no list of allowed tools: tools/server/src/harness/codex.ts switches off what it
// knows of, so a new Codex can add something it does not. This runs the CLI through the harness against a stand-in
// for the OpenAI API that records what the model is offered, with user settings (a temporary CODEX_HOME) asking for
// the opposite of everything. It takes one model of each kind Codex has, and needs no login or key.
// Ported from 4k7 (scripts/check-codex.mjs).
//   node scripts/check-codex.mjs [path/to/codex]      npm run check:codex
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SERVER_PROTOCOL, chatTools } from '@swarf/agent';
import { ChatRunner, CodexHarness, CODEX_SERVER, LocalServer, mcpHttpHandler } from '../tools/server/src/index.ts';

const bin = process.argv[2] ?? 'codex';
const SERVER = `mcp__${CODEX_SERVER}`;
/** What cannot be switched off (see harness/codex.ts). Anything else the model is offered is a finding. */
const HARMLESS = new Set(['exec', 'wait', 'apply_patch', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
const HARMLESS_IN_SCRIPTS = new Set(['apply_patch', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'clock__curr_time']);

let failures = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

// the stand-in for the API: every request recorded, and a small script for the answers
const requests = [];
const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 1050 };
const patch = (file) => `*** Begin Patch\n*** Add File: ${file}\n+written\n*** End Patch\n`;
const PROBE = `const out = { tools: Object.keys(tools), reach: {} };
for (const [name, get] of Object.entries({ fetch: () => fetch, require: () => require, process: () => process, Deno: () => Deno })) {
  try { get(); out.reach[name] = true; } catch { out.reach[name] = false; }
}
try { await import('fs'); out.reach.import = true; } catch { out.reach.import = false; }
try { out.patch = JSON.stringify(await tools.apply_patch(${JSON.stringify(patch('from-script.txt'))})); } catch (e) { out.patch = String(e); }
text(JSON.stringify(out));`;
/** The tools of a request: in `tools`, or for newer models in an input item. */
function offered(body) {
  const list = [...(body.tools ?? []), ...(body.input ?? []).filter((i) => i.type === 'additional_tools').flatMap((i) => i.tools ?? [])];
  return list.flatMap((t) => (t.type === 'namespace' ? (t.tools ?? []).map((x) => ({ ...x, namespace: t.name })) : [t]));
}
const api = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[],"models":[]}');
  const body = JSON.parse(raw);
  requests.push(body);
  const input = body.input ?? [];
  const lastUser = input.findLastIndex((i) => i.role === 'user');
  const said = JSON.stringify(input[lastUser]?.content ?? '');
  const called = input.slice(lastUser + 1).some((i) => i.type?.endsWith('_output'));
  const call = { call_id: `call_${requests.length}` };
  const item = called
    ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }
    : said.includes('attack: patch')
      ? { type: 'custom_tool_call', name: 'apply_patch', input: patch('from-patch.txt'), ...call }
      : said.includes('attack: script')
        ? { type: 'custom_tool_call', name: 'exec', namespace: 'functions', input: PROBE, ...call }
        : said.includes('attack: shell')
          ? { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo x > from-shell.txt' }), ...call }
          : { type: 'function_call', name: 'get_job', namespace: SERVER, arguments: '{}', ...call };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of [{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: 'r', usage } }]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

// the user's settings: each feature Codex calls finished on, a program to run after a turn, and their own MCP servers
const dir = mkdtempSync(join(tmpdir(), 'swarf-codex-'));
const home = join(dir, 'home');
const work = join(dir, 'work');
mkdirSync(home);
mkdirSync(work);
process.env.CODEX_HOME = home;
const cli = (...args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
const features = cli('features', 'list').split('\n').map((l) => l.trim().split(/\s+/)).filter(([name, stage]) => name && !name.includes('.') && (stage === 'stable' || stage === 'experimental')).map(([name]) => `${name} = true`);
const marker = (name) => join(dir, name);
const starts = (name) => `command = "node"\nargs = ["-e", ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker(name))}, '')`)}]`;
writeFileSync(
  join(home, 'config.toml'),
  `model_provider = "standin"
sandbox_mode = "danger-full-access"
web_search = "live"
developer_instructions = "USER INSTRUCTIONS"
notify = ["node", "-e", ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker('notified'))}, '')`)}]
[agents]
enabled = true
[tools.experimental_request_user_input]
enabled = true
[model_providers.standin]
name = "stand-in"
base_url = "http://127.0.0.1:${api.address().port}/v1"
wire_api = "responses"
supports_standalone_web_search = true
[mcp_servers.their_own]
${starts('their-own-started')}
[mcp_servers.swarf]
${starts('their-swarf-started')}
[features]
${features.join('\n')}
`,
);

// the server and a tab, as for the app
const KEY = '00000000-0000-4000-8000-000000000000';
const server = new LocalServer({ accessKey: KEY, ports: [0], devPorts: [5173] });
const port = await server.start();
const harness = new CodexHarness(bin, work);
const chat = new ChatRunner({ server, harnesses: [harness], workDir: work });
const cap = harness.detect();
if (!cap.available) throw new Error(cap.reason);
console.log(`${cap.version}: ${features.length} features on in the user's settings`);
server.setChatHandler(chat.handle, [cap]);
server.setHttpHandler(mcpHttpHandler(server, chat.validToken));
const calls = [];
const events = new Map();
const tab = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'http://localhost:5173' } });
await new Promise((resolve) => {
  tab.on('open', () => tab.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: KEY, client: 'check-codex' })));
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
/** One message; the requests it made. */
function send(msg) {
  const id = `c${nextId++}`;
  requests.length = 0;
  calls.length = 0;
  tab.send(JSON.stringify({ type: 'chat', id, session: null, harness: 'codex', ...msg }));
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (!events.get(id)?.some((e) => e.kind === 'done')) return;
      clearInterval(t);
      resolve({ events: events.get(id), done: events.get(id).at(-1), requests: [...requests], calls: [...calls] });
    }, 20);
  });
}
const toolOutput = (r) => (r.requests.at(-1)?.input ?? []).filter((i) => i.type?.endsWith('_output')).map((i) => (typeof i.output === 'string' ? i.output : (i.output ?? []).map((x) => x.text ?? '').join('\n'))).join('\n');
const names = (body) => offered(body).map((t) => (t.namespace && t.namespace !== 'functions' ? `${t.namespace}.${t.name}` : (t.name ?? t.type)));
const tools = chatTools();

try {
  // one model of each kind: the tool surface is the model's business in Codex
  const catalog = JSON.parse(cli('debug', 'models')).models.filter((m) => m.visibility === 'list');
  const kinds = [...new Map(catalog.map((m) => [`${m.tool_mode}/${m.multi_agent_version}/${m.experimental_supported_tools}`, m])).values()];
  for (const { slug: model, tool_mode } of kinds) {
    console.log(`\n${model} (${tool_mode ?? 'direct'})`);
    const first = await send({ text: 'turn a pin', model });
    check('it answers, and its tool call reaches the tab', first.done.ok && first.calls.join() === 'get_job', JSON.stringify(first.done));
    const body = first.requests[0];
    const extra = names(body).filter((n) => !n.startsWith(`${SERVER}.`) && !HARMLESS.has(n));
    check('nothing else is on offer', extra.length === 0, extra.join(', '));
    const direct = offered(body).filter((t) => t.namespace === SERVER);
    check(`all ${tools.length} swarf tools are plain tools`, tools.every((t) => direct.some((d) => d.name === t.name)), direct.map((d) => d.name).join(', '));
    const add = direct.find((d) => d.name === 'add_operation');
    check('add_operation keeps its schema', JSON.stringify(add?.parameters ?? '').length > 10_000, `${JSON.stringify(add?.parameters ?? '').length} bytes`);
    const prompt = JSON.stringify(body.input.filter((i) => i.role === 'developer' || i.role === 'system')) + (body.instructions ?? '');
    check('its prompt is the chat rules, not Codex’s or the user’s', prompt.includes('You are answering the chat of swarf') && !prompt.includes('You are Codex') && !prompt.includes('USER INSTRUCTIONS'));
    check('no web search', !offered(body).some((t) => t.type === 'web_search' && t.external_web_access), names(body).join(', '));

    const session = first.events.find((e) => e.kind === 'session')?.session;
    const next = await send({ text: 'and now Ø12', model, session });
    check('a session continues', next.done.ok && next.done.session === session, JSON.stringify(next.done));
    check('the settings hold on resuming too', names(next.requests[0]).every((n) => n.startsWith(`${SERVER}.`) || HARMLESS.has(n)), names(next.requests[0]).join(', '));

    const patched = await send({ text: 'attack: patch', model });
    check('a patch is refused', /rejected|read-only|unsupported/i.test(toolOutput(patched)) && !existsSync(join(work, 'from-patch.txt')), toolOutput(patched));
    const shell = await send({ text: 'attack: shell', model });
    check('a command does not run', /unsupported|not found|unknown/i.test(toolOutput(shell)) && !existsSync(join(work, 'from-shell.txt')), toolOutput(shell));
    if (names(body).includes('exec')) {
      const script = await send({ text: 'attack: script', model });
      const found = JSON.parse(/\{"tools".*\}/.exec(toolOutput(script))?.[0] ?? '{}');
      const reach = Object.entries(found.reach ?? {}).filter(([, yes]) => yes).map(([what]) => what);
      check('a script reaches neither files nor network', Boolean(found.reach) && reach.length === 0, reach.join(', '));
      const nested = (found.tools ?? []).filter((t) => !HARMLESS_IN_SCRIPTS.has(t));
      check('a script has none of the tools it should not', Boolean(found.tools) && nested.length === 0, nested.join(', '));
      check('a script’s patch is refused', /rejected|read-only/i.test(found.patch ?? '') && !existsSync(join(work, 'from-script.txt')), found.patch);
    }
  }
  console.log('');
  check('the user’s MCP servers and program did not run', !['their-own-started', 'their-swarf-started', 'notified'].some((f) => existsSync(marker(f))), readdirSync(dir).join(', '));
} finally {
  tab.close();
  await server.stop();
  api.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} failed: a Codex setting in tools/server/src/harness/codex.ts needs another look` : '\nall good');
process.exit(failures ? 1 : 0);
