/**
 * The local server ↔ app tab protocol (WebSocket, JSON). Modelled on 4k7's
 * (packages/schema/src/server.ts), cut down to tool calls: Claude Code (or any MCP client) talks to
 * the server, the server forwards each tool call to the one connected tab, the tab runs it against
 * its job and answers. The tab stays the single source of truth, so the preview updates live.
 *
 * The other direction: a message typed into the app's chat can be answered by a coding agent's CLI on
 * this computer (Claude Code, GitHub Copilot CLI, Codex CLI or OpenCode, with the user's own login). The tab
 * sends `chat`, the server runs the CLI headlessly with swarf as its only MCP server, and streams
 * `chat_event`s back; the tool calls of that run arrive as `call`s like any other.
 */
export const SERVER_PROTOCOL = 3;
/** Ports the server tries in turn (HTTP and WebSocket share one). */
export const SERVER_PORTS = [7790, 7791, 7792, 7793, 7794] as const;

export type TabToServer =
  | { type: 'hello'; protocol: number; accessKey: string; client: string }
  | { type: 'result'; id: number; isError: boolean; text: string }
  /** A chat message for a coding agent (default Claude Code). `session`: continue that conversation (null: a new one). */
  | { type: 'chat'; id: string; text: string; session: string | null; model?: string; harness?: HarnessId }
  | { type: 'chat_cancel'; id: string };

/** The coding agents' CLIs the server can run for the chat. */
export const HARNESSES = { claude: 'Claude Code', copilot: 'GitHub Copilot CLI', codex: 'Codex CLI', opencode: 'OpenCode' } as const;
export type HarnessId = keyof typeof HARNESSES;
export const isHarnessId = (v: unknown): v is HarnessId => typeof v === 'string' && v in HARNESSES;

/** Whether the server can answer the chat with a CLI on this computer. */
export interface ChatCapability {
  available: boolean;
  /** `<cli> --version` */
  version?: string;
  reason?: string;
}

export interface HarnessInfo extends ChatCapability {
  id: HarnessId;
  name: string;
}

export type ChatEvent =
  | { kind: 'session'; session: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'done'; ok: boolean; error?: string; costUsd?: number; session?: string };

export type ServerToTab =
  /** `chat`: Claude Code's (older tabs read it); `harnesses`: every CLI the server knows. */
  | { type: 'welcome'; protocol: number; agent: string | null; chat: ChatCapability; harnesses: HarnessInfo[] }
  | { type: 'chat_event'; id: string; event: ChatEvent }
  | { type: 'denied'; reason: string }
  | { type: 'call'; id: number; tool: string; input: unknown }
  /** The MCP client that drives the app (e.g. "Claude Code"), once it has introduced itself. */
  | { type: 'agent'; name: string | null };

/**
 * How a tab finds the server: the app's link carries `#connect=<accessKey>@<port>`.
 * Returns null when the hash has no (valid) connect part.
 */
export function parseConnect(hash: string): { accessKey: string; port: number } | null {
  const m = /(?:^#|&)connect=([\w-]{8,})@(\d{2,5})/.exec(hash);
  if (!m) return null;
  return { accessKey: m[1]!, port: Number(m[2]) };
}
