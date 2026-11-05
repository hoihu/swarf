#!/usr/bin/env node
/**
 * swarf-server: lets Claude Code (or any MCP client) build jobs in the swarf app open in your
 * browser. Ported in spirit from 4k7's server.
 *
 *   claude mcp add swarf -- node /path/to/swarf/tools/server/src/main.ts
 *
 * Claude Code starts it over stdio; it also listens on 127.0.0.1:7790 (or the next free port)
 * for the app tab. The link it logs (and returns from any tool while no tab is connected) opens
 * the app connected to it. `--serve` runs only the relay and app (no MCP), `--open` opens the link.
 *
 * The other direction: the app's own chat can be answered by Claude Code on this computer (your
 * login and plan, no API key). The server runs `claude -p` per message with swarf as its only MCP
 * server (SWARF_CLAUDE_BIN: where claude is, if not on the PATH).
 *
 * In stdio mode stdout belongs to the MCP protocol; logs go to stderr.
 */
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appHandler } from './app.ts';
import { appDir, configDir, configPath, DEV_APP, loadConfig } from './config.ts';
import { createMcpServer, mcpHttpHandler, VERSION } from './mcp.ts';
import { ChatRunner } from './chat.ts';
import { ClaudeHarness } from './claude.ts';
import { LocalServer } from './server.ts';
import { spawn } from 'node:child_process';

const serve = process.argv.includes('--serve');
const open = process.argv.includes('--open');
const log = (msg: string) => process.stderr.write(`[swarf] ${msg}\n`);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dir = appDir();
  const server = new LocalServer({ accessKey: cfg.accessKey, devPorts: [5173, 4173], log, ...(dir ? {} : { appUrl: DEV_APP }) });
  const claude = new ClaudeHarness(process.env.SWARF_CLAUDE_BIN ?? 'claude');
  const chat = new ChatRunner({ server, claude, workDir: join(configDir(), 'claude-workspace'), log });
  const capability = claude.detect();
  server.setChatHandler(chat.handle, capability);
  const app = appHandler(dir);
  const mcpHttp = mcpHttpHandler(server, chat.validToken);
  server.setHttpHandler((req, res) => ((req.url ?? '').split('?')[0] === '/mcp' ? mcpHttp(req, res) : app(req, res)));
  const port = await server.start();
  log(`v${VERSION} on 127.0.0.1:${port}; access key in ${configPath()}`);
  log(capability.available ? `app chat via Claude Code ${capability.version}` : `app chat via Claude Code: no (${capability.reason})`);
  if (!dir) log(`the app is not built (npm run build): the link points at the dev server (npm run dev)`);
  log(`open the app: ${server.appLink()}`);
  if (open) openBrowser(server.appLink());

  let mcp: ReturnType<typeof createMcpServer> | null = null;
  if (!serve) {
    mcp = createMcpServer(server);
    await mcp.connect(new StdioServerTransport());
  }
  const shutdown = async () => {
    chat.stopAll();
    await server.stop();
    await mcp?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (!serve) {
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => log(`could not open a browser; open ${url}`)).unref();
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
