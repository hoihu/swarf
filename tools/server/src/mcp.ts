/**
 * The MCP side: lists swarf's tools and forwards calls to the app tab through the relay.
 * save_gcode runs here instead (it writes a file): the tab checks the job and writes the G-code
 * (the same the app shows); this side only refuses on check errors or writes the file.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_INSTRUCTIONS, MCP_TOOL_NAMES, TAB_GCODE_FILE, chatTools, mcpTools, type GcodeForFile } from '@swarf/agent';
import type { CallResult, LocalServer } from './server.ts';

/** The relay's version, from its package.json. */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

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
  const got = await relay.call(TAB_GCODE_FILE, {});
  if (got.isError) return got;
  const g = JSON.parse(got.text) as GcodeForFile;
  if (g.errors.length || !g.text) return { isError: true, text: `Not saved: the job has errors.\n${g.errors.map((e) => `- ${e}`).join('\n')}` };
  const path = resolve(cwd, extname(raw) ? raw : `${raw}.nc`);
  await writeFile(path, g.text);
  return { isError: false, text: `Wrote ${g.text.split('\n').length} lines to ${path} (${g.name}, ${g.operations} operations, about ${Math.round(g.seconds / 60)} min).` };
}

function prettyAgent(name: string): string {
  if (/claude[-_ ]?code/i.test(name)) return 'Claude Code';
  if (/cursor/i.test(name)) return 'Cursor';
  if (/codex/i.test(name)) return 'Codex';
  return name;
}
