/**
 * The MCP side: lists swarf's tools and forwards calls to the app tab through the relay.
 * save_gcode runs here instead (it writes a file): it reads the job from the tab, checks it,
 * and writes the same G-code the app shows.
 */
import { timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_INSTRUCTIONS, MCP_TOOL_NAMES, chatTools, mcpTools } from '@swarf/agent';
import { Job, analyze, emit, hasErrors } from '@swarf/cam';
import type { CallResult, LocalServer } from './server.ts';

export const VERSION = '0.1.0';

/** 'cli': Claude Code (or another client) drives the app; 'chat': a headless run answering the app's chat. */
export type McpMode = 'cli' | 'chat';

export function createMcpServer(relay: LocalServer, opts: { cwd?: string; mode?: McpMode } = {}): Server {
  const mode = opts.mode ?? 'cli';
  const tools = mode === 'chat' ? chatTools() : mcpTools();
  // chat runs get their rules appended to the system prompt; repeating them here would send them twice
  const instructions = mode === 'chat' ? 'swarf tools; how to use them is in your instructions.' : MCP_INSTRUCTIONS;
  const mcp = new Server({ name: 'swarf', version: VERSION }, { capabilities: { tools: {} }, instructions });

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema as { type: 'object' } })),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const input = req.params.arguments ?? {};
    let r: CallResult;
    if (!tools.some((t) => t.name === name)) r = { isError: true, text: `Unknown tool ${name}` };
    else if (name === MCP_TOOL_NAMES.save) r = await saveGcode(relay, input, opts.cwd ?? process.cwd());
    else r = await relay.call(name, input);
    return { isError: r.isError, content: [{ type: 'text' as const, text: r.text }, ...(r.images ?? []).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))] };
  });

  if (mode === 'cli') {
    mcp.oninitialized = () => {
      const client = mcp.getClientVersion();
      relay.setAgent(client ? prettyAgent(client.name) : null);
    };
  }
  return mcp;
}

/**
 * Streamable-HTTP endpoint (/mcp) for the headless Claude Code runs the server starts for the app's
 * chat. Stateless: one server and transport per request. Only bearer tokens of runs still going are
 * accepted, and never from a browser (any Origin header).
 */
export function mcpHttpHandler(relay: LocalServer, validToken: (token: string) => boolean) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.origin) {
      res.writeHead(403).end('browsers may not call this endpoint');
      return;
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!token || !validToken(token)) {
      res.writeHead(401).end('missing or invalid token');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const body = await readJson(req);
    const mcp = createMcpServer(relay, { mode: 'chat' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

export function tokensMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error('request too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

async function saveGcode(relay: LocalServer, input: Record<string, unknown>, cwd: string): Promise<CallResult> {
  const raw = typeof input.path === 'string' ? input.path.trim() : '';
  if (!raw) return { isError: true, text: 'path is required' };
  const got = await relay.call('get_job', {});
  if (got.isError) return got;
  const parsed = Job.safeParse((JSON.parse(got.text) as { job?: unknown }).job);
  if (!parsed.success) return { isError: true, text: `The app sent a job this server cannot read: ${parsed.error.message}` };
  const job = parsed.data;
  const a = analyze(job);
  if (hasErrors(a.diagnostics)) {
    return { isError: true, text: `Not saved: the job has errors.\n${a.diagnostics.filter((d) => d.severity === 'error').map((d) => `- ${d.code}${d.opId ? ` [${d.opId}]` : ''}: ${d.message}`).join('\n')}` };
  }
  const path = resolve(cwd, extname(raw) ? raw : `${raw}.nc`);
  const { text } = emit(job, a.program);
  await writeFile(path, text);
  return { isError: false, text: `Wrote ${text.split('\n').length} lines to ${path} (${job.name}, ${a.program.segments.length} operations, about ${Math.round(a.seconds / 60)} min).` };
}

function prettyAgent(name: string): string {
  if (/claude[-_ ]?code/i.test(name)) return 'Claude Code';
  if (/cursor/i.test(name)) return 'Cursor';
  if (/codex/i.test(name)) return 'Codex';
  return name;
}
