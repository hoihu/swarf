/**
 * The tools as an MCP client (Claude Code, Cursor, Codex…) sees them, and how the app tab runs
 * them. Same tools as the in-app agent, minus ask_user (the client asks its user itself), plus
 * get_context (the job state the in-app agent gets with every message) and save_gcode (run by
 * the local server, which can write files).
 */
import { formatJobContext, CAM_GUIDE } from './prompt.ts';
import { CAM_TOOLS, TOOL_NAMES, runCamTool, type JobPort, type ToolOutcome } from './tools.ts';
import type { ToolDefinition } from './types.ts';

export const MCP_TOOL_NAMES = { context: 'get_context', save: 'save_gcode' } as const;

export const MCP_INSTRUCTIONS = `swarf: CAM for a hobby CNC lathe or mill (grblHAL), open in the user's browser. You build the job from parametric operations with these tools; swarf generates the toolpaths, checks them and writes simple G-code, and the user watches the 3D preview update as you work. Never write G-code by hand.

Call get_context first: it has the machine, stock, tool table, operations and check results.

${CAM_GUIDE}

When the job is clean, save_gcode writes the program to a file if the user wants one; otherwise they download it from the app.`;

/**
 * Appended to Claude Code's system prompt when it answers the app's chat (claude -p): the user
 * types in the app and watches the preview; there is no file system or shell in these runs.
 */
export const CHAT_RULES = `You are answering the chat of swarf, a browser app for hobby CNC (lathe or mill, grblHAL). The user types in the app and watches the 3D preview update as you use the swarf tools; your reply text appears in the app's chat. You only have the swarf tools: no files, no shell, no web. You never write G-code yourself; swarf generates it from the operations you build.

Every message starts with the current job state (machine, stock, tools, operations, checks); call get_context only if you need it again after edits.

${CAM_GUIDE}
- If you need an answer from the user (a missing dimension, a choice with a real trade-off), ask it in your reply, with the options, and stop; the user answers in the next message.

Finish with a short reply (2–4 sentences): what the job does now, and anything the user should know before running it. The user sees the operation list and the G-code; do not repeat every value.`;

/** The tools a chat run gets: no save_gcode (the user downloads or streams from the app). */
export function chatTools(): ToolDefinition[] {
  return mcpTools().filter((t) => t.name !== MCP_TOOL_NAMES.save);
}

export function mcpTools(): ToolDefinition[] {
  return [
    {
      name: MCP_TOOL_NAMES.context,
      description: 'The job as the user sees it in swarf: machine, stock, tool table, operations (with ids and values) and the check results. Call this first.',
      input_schema: { type: 'object', properties: {} },
    },
    ...CAM_TOOLS.filter((t) => t.name !== TOOL_NAMES.ask),
    {
      name: MCP_TOOL_NAMES.save,
      description: 'Write the generated G-code to a file on this computer (refused while the job has errors). path: absolute, or relative to the directory the server was started in; .nc is added when there is no extension.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ];
}

/** Run a tool in the app tab (everything except save_gcode, which the server runs itself). */
export function runTabTool(port: JobPort, name: string, input: unknown): ToolOutcome {
  if (name === MCP_TOOL_NAMES.context) {
    return { content: formatJobContext(port.get()), isError: false, label: 'read job', detail: 'job state' };
  }
  if (name === TOOL_NAMES.ask) return { content: 'ask_user is not available here; ask your user directly.', isError: true, label: name, detail: 'not available' };
  return runCamTool(port, name, input) ?? { content: `Unknown tool ${name}`, isError: true, label: name, detail: 'unknown tool' };
}
