/**
 * The local server ↔ app tab protocol (WebSocket, JSON). Modelled on 4k7's
 * (packages/schema/src/server.ts), cut down to tool calls: Claude Code (or any MCP client) talks to
 * the server, the server forwards each tool call to the one connected tab, the tab runs it against
 * its job and answers. The tab stays the single source of truth, so the preview updates live.
 */
export const SERVER_PROTOCOL = 1;
/** Ports the server tries in turn (HTTP and WebSocket share one). */
export const SERVER_PORTS = [7790, 7791, 7792, 7793, 7794] as const;

export type TabToServer =
  | { type: 'hello'; protocol: number; accessKey: string; client: string }
  | { type: 'result'; id: number; isError: boolean; text: string };

export type ServerToTab =
  | { type: 'welcome'; protocol: number; agent: string | null }
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
