/**
 * The relay: HTTP + WebSocket on 127.0.0.1. One app tab connects over the WebSocket; tool calls
 * (from the MCP side) are forwarded to it and it answers with the result. Ported from 4k7's
 * LocalServer (tools/server/src/server.ts), cut down to tool calls.
 *
 * Security: loopback only; WebSocket connections only from localhost pages (the server's own port,
 * the dev server, vite preview); nothing is forwarded until the tab presents the access key.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { SERVER_PORTS, SERVER_PROTOCOL, type ChatCapability, type HarnessInfo, type ServerToTab, type TabToServer } from '@swarf/agent';

export interface CallResult {
  isError: boolean;
  text: string;
  images?: { data: string; mimeType: string }[];
}

export interface LocalServerOptions {
  accessKey: string;
  ports?: readonly number[];
  /** Other localhost ports whose pages may connect (dev server, vite preview). */
  devPorts?: readonly number[];
  /** Where the app is opened; default: the app this server serves. */
  appUrl?: string;
  callTimeoutMs?: number;
  log?: (msg: string) => void;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type ChatMessage = Extract<TabToServer, { type: 'chat' | 'chat_cancel' }>;

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/;

export function secretsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class LocalServer {
  readonly accessKey: string;
  port: number | null = null;
  #opts: LocalServerOptions;
  #http: HttpServer | null = null;
  #wss: WebSocketServer | null = null;
  #tab: WebSocket | null = null;
  #http_handler: HttpHandler | null = null;
  #pending = new Map<number, { resolve: (r: CallResult) => void; timer: ReturnType<typeof setTimeout> }>();
  #seq = 0;
  #agent: string | null = null;
  #chat: ChatCapability = { available: false, reason: 'This server does not run Claude Code for the chat.' };
  #harnesses: HarnessInfo[] = [];
  #chatHandler: ((m: ChatMessage) => void) | null = null;

  constructor(opts: LocalServerOptions) {
    this.#opts = opts;
    this.accessKey = opts.accessKey;
  }

  get connected(): boolean {
    return this.#tab !== null;
  }

  #log(msg: string): void {
    this.#opts.log?.(msg);
  }

  /** Listen on the first free port of the range. */
  async start(): Promise<number> {
    const ports = this.#opts.ports ?? SERVER_PORTS;
    for (const port of ports) {
      try {
        this.#http = await listen(port, (req, res) => this.#onHttp(req, res));
        this.port = (this.#http.address() as { port: number }).port;
        this.#wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
        this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req));
        this.#http.on('upgrade', (req, socket, head) => this.#wss!.handleUpgrade(req, socket, head, (ws) => this.#wss!.emit('connection', ws, req)));
        return this.port;
      } catch (e) {
        if (!['EADDRINUSE', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      }
    }
    throw new Error(`All server ports are in use (${ports.join(', ')}). Is another swarf server already running?`);
  }

  async stop(): Promise<void> {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ isError: true, text: 'The swarf server is shutting down.' });
    }
    this.#pending.clear();
    this.#tab?.close(1001, 'server stopped');
    this.#wss?.close();
    await new Promise<void>((resolve) => (this.#http ? this.#http.close(() => resolve()) : resolve()));
    this.#http?.closeAllConnections();
  }

  setHttpHandler(h: HttpHandler): void {
    this.#http_handler = h;
  }

  setAppUrl(url: string | undefined): void {
    this.#opts.appUrl = url;
  }

  /** Answer the tab's chat messages (coding agents' CLIs, headless); what they can do is told to every tab. */
  setChatHandler(h: (m: ChatMessage) => void, harnesses: HarnessInfo[]): void {
    this.#chatHandler = h;
    this.#harnesses = harnesses;
    const claude = harnesses.find((x) => x.id === 'claude');
    this.#chat = claude ? { available: claude.available, ...(claude.version ? { version: claude.version } : {}), ...(claude.reason ? { reason: claude.reason } : {}) } : { available: false, reason: 'Claude Code is not set up on this server.' };
  }

  get harnesses(): HarnessInfo[] {
    return this.#harnesses;
  }

  get chatCapability(): ChatCapability {
    return this.#chat;
  }

  /** Send to the connected tab (dropped when none is connected). */
  sendToTab(msg: ServerToTab): void {
    this.#send(msg);
  }

  /** The MCP client driving the app (shown in the tab). */
  setAgent(name: string | null): void {
    this.#agent = name;
    this.#send({ type: 'agent', name });
  }

  /** The link that opens the app connected to this server. */
  appLink(): string {
    const base = (this.#opts.appUrl ?? `http://localhost:${this.port}`).replace(/\/$/, '');
    return `${base}/#connect=${this.accessKey}@${this.port}`;
  }

  allowedOrigin(origin: string): boolean {
    const m = LOCAL_ORIGIN.exec(origin);
    if (!m) return false;
    const port = Number(m[2] ?? (origin.startsWith('https:') ? 443 : 80));
    const app = this.#opts.appUrl ? Number(new URL(this.#opts.appUrl).port || 80) : null;
    return port === this.port || port === app || !!this.#opts.devPorts?.includes(port);
  }

  /** Forward a tool call to the tab and wait for its answer. */
  call(tool: string, input: unknown): Promise<CallResult> {
    if (!this.#tab) {
      return Promise.resolve({
        isError: true,
        text: `The swarf app is not open. Ask the user to open this link (it connects the app to this server), then try again: ${this.appLink()}`,
      });
    }
    const id = ++this.#seq;
    const ms = this.#opts.callTimeoutMs ?? 60_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ isError: true, text: `The app did not answer ${tool} within ${Math.round(ms / 1000)} s.` });
      }, ms);
      this.#pending.set(id, { resolve, timer });
      this.#send({ type: 'call', id, tool, input });
    });
  }

  #send(msg: ServerToTab): void {
    if (this.#tab?.readyState === 1) this.#tab.send(JSON.stringify(msg));
  }

  #onHttp(req: IncomingMessage, res: ServerResponse): void {
    if (!this.#http_handler) {
      res.writeHead(404).end();
      return;
    }
    void Promise.resolve(this.#http_handler(req, res)).catch((e) => {
      this.#log(`http error: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  }

  #onConnection(ws: WebSocket, req: IncomingMessage): void {
    const origin = req.headers.origin ?? '';
    if (!this.allowedOrigin(origin)) {
      this.#log(`rejected connection from origin "${origin}"`);
      ws.close(1008, 'origin not allowed');
      return;
    }
    let accepted = false;
    const helloTimer = setTimeout(() => !accepted && ws.close(1008, 'no hello'), 5000);

    ws.on('message', (raw) => {
      let msg: TabToServer;
      try {
        msg = JSON.parse(String(raw)) as TabToServer;
      } catch {
        return;
      }
      if (!accepted) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimer);
        const deny = (reason: string) => {
          ws.send(JSON.stringify({ type: 'denied', reason } satisfies ServerToTab));
          ws.close(1008, reason);
          this.#log(`rejected tab: ${reason}`);
        };
        if (msg.protocol !== SERVER_PROTOCOL) return deny(`protocol ${msg.protocol} not supported (server speaks ${SERVER_PROTOCOL})`);
        if (typeof msg.accessKey !== 'string' || !secretsMatch(msg.accessKey, this.accessKey)) return deny('wrong access key');
        accepted = true;
        if (this.#tab && this.#tab !== ws) this.#tab.close(4000, 'replaced by another tab');
        this.#tab = ws;
        ws.send(JSON.stringify({ type: 'welcome', protocol: SERVER_PROTOCOL, agent: this.#agent, chat: this.#chat, harnesses: this.#harnesses } satisfies ServerToTab));
        this.#log(`tab connected (${msg.client}, origin ${origin})`);
        return;
      }
      if (msg.type === 'chat' || msg.type === 'chat_cancel') {
        if (this.#chatHandler) this.#chatHandler(msg);
        else if (msg.type === 'chat') this.#send({ type: 'chat_event', id: msg.id, event: { kind: 'done', ok: false, error: this.#chat.reason ?? 'Chat is not available on this server.' } });
        return;
      }
      if (msg.type === 'result') {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.#pending.delete(msg.id);
        p.resolve({ isError: msg.isError, text: msg.text, ...(msg.images?.length ? { images: msg.images } : {}) });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.#tab !== ws) return;
      this.#tab = null;
      this.#log('tab disconnected');
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.resolve({ isError: true, text: 'The app disconnected before answering.' });
        this.#pending.delete(id);
      }
    });
  }
}

function listen(port: number, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const http = createServer(handler);
    http.once('listening', () => resolve(http));
    http.once('error', (e) => {
      http.close();
      reject(e);
    });
    http.listen(port, '127.0.0.1');
  });
}
