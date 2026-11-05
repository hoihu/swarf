/**
 * The MCP side: lists swarf's tools and forwards calls to the app tab through the relay.
 * save_gcode runs here instead (it writes a file): it reads the job from the tab, checks it,
 * and writes the same G-code the app shows.
 */
import { writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_INSTRUCTIONS, MCP_TOOL_NAMES, mcpTools } from '@swarf/agent';
import { Job, analyze, emit, hasErrors } from '@swarf/cam';
import type { CallResult, LocalServer } from './server.ts';

export const VERSION = '0.1.0';

export function createMcpServer(relay: LocalServer, opts: { cwd?: string } = {}): Server {
  const tools = mcpTools();
  const mcp = new Server({ name: 'swarf', version: VERSION }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });

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
    return { isError: r.isError, content: [{ type: 'text' as const, text: r.text }] };
  });

  mcp.oninitialized = () => {
    const client = mcp.getClientVersion();
    relay.setAgent(client ? prettyAgent(client.name) : null);
  };
  return mcp;
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
