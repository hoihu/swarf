/**
 * GitHub Copilot CLI with JSONL output, non-interactive. swarf's endpoint is added as an MCP server
 * for the run, and every other tool (shell, files, the GitHub MCP server, the user's own MCP servers)
 * is filtered out with --available-tools. The user's own MCP servers would still start (their
 * programs run, though the model never sees their tools), so `copilot mcp list` names them and each
 * is switched off for the run; a run that cannot tell which there are does not start.
 * `scripts/check-copilot.mjs` runs the real CLI (offline, against a stand-in model API) to check. The CLI has no system-prompt option, so the chat rules open
 * the first message of a conversation; it all goes in on stdin (too long for a Windows command line).
 * Ported from 4k7 (tools/server/src/harness/copilot.ts), without token counting and web access.
 */
import { randomUUID } from 'node:crypto';
import { CHAT_RULES, type HarnessInfo } from '@swarf/agent';
import { capture, detectCli, parseLine, type ChatJob, type Harness, type Invocation, type RunSink } from './types.ts';

/** The server's name for the run: also what --available-tools and --allow-tool select. */
const SERVER = 'swarf';

export class CopilotHarness implements Harness {
  readonly id = 'copilot' as const;
  readonly name = 'GitHub Copilot CLI';
  bin: string;
  #cwd: string;

  constructor(bin: string, cwd: string) {
    this.bin = bin;
    this.#cwd = cwd;
  }

  #env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.COPILOT_ALLOW_ALL; // would approve every tool, shell included
    return env;
  }

  detect(): HarnessInfo {
    return { id: this.id, name: this.name, ...detectCli(this.bin, 'GitHub Copilot CLI', this.#env(), 'SWARF_COPILOT_BIN', 'npm install -g @github/copilot') };
  }

  /** The MCP servers from the user's settings and plugins (ours, added for the run, replaces one of the same name). */
  async #userServers(): Promise<string[]> {
    const out = await capture(this.bin, ['mcp', 'list', '--json'], { env: this.#env(), cwd: this.#cwd });
    try {
      return Object.keys((JSON.parse(out ?? '') as { mcpServers?: Record<string, unknown> }).mcpServers ?? {}).filter((n) => n !== SERVER);
    } catch {
      throw new Error('it did not say which MCP servers it would start ("copilot mcp list --json").');
    }
  }

  async chat(job: ChatJob, sink: RunSink): Promise<Invocation> {
    const users = await this.#userServers();
    // a new conversation gets its id now, so the tab has it even if the run is stopped
    const session = job.session ?? randomUUID();
    const rules = job.session ? '' : `${CHAT_RULES}\n\n---\n\nThe user's message:\n\n`;
    const mcp = { mcpServers: { [SERVER]: { type: 'http', url: job.mcpUrl, headers: { Authorization: `Bearer ${job.token}` }, tools: ['*'] } } };
    sink.emit({ kind: 'session', session });
    return {
      args: [
        '--output-format',
        'json',
        '--stream',
        'on',
        '--additional-mcp-config',
        JSON.stringify(mcp),
        '--disable-builtin-mcps',
        ...users.flatMap((name) => ['--disable-mcp-server', name]),
        '--available-tools',
        SERVER,
        '--allow-tool',
        SERVER,
        '--no-ask-user',
        '--no-custom-instructions',
        '--no-auto-update',
        `--session-id=${session}`,
        ...(job.model ? ['--model', job.model] : []),
      ],
      env: this.#env(),
      stdin: rules + job.text,
      line: reader(session, sink),
    };
  }
}

function reader(session: string, sink: RunSink): (line: string) => void {
  const streamed = new Set<string>();
  let wrote = false;
  /** A new message began: the next text starts a paragraph (once, however it arrives). */
  let fresh = false;
  let error: string | undefined;
  const write = (text: string) => {
    if (fresh && wrote) sink.emit({ kind: 'text', text: '\n\n' });
    fresh = false;
    wrote = true;
    sink.emit({ kind: 'text', text });
  };
  return (line) => {
    const m = parseLine<CopilotEvent>(line);
    if (!m) return;
    const d = m.data ?? {};
    switch (m.type) {
      case 'assistant.message_start':
        fresh = true;
        break;
      case 'assistant.message_delta':
        if (d.deltaContent) {
          if (d.messageId) streamed.add(d.messageId);
          write(d.deltaContent);
        }
        break;
      case 'assistant.message':
        // the whole message: only when it was not streamed
        if (d.content && !(d.messageId && streamed.has(d.messageId))) {
          fresh = true;
          write(d.content);
        }
        break;
      case 'assistant.reasoning_delta':
        if (d.deltaContent) sink.emit({ kind: 'thinking', text: d.deltaContent });
        break;
      case 'session.error':
        error = d.message ?? error;
        break;
      case 'result':
        sink.finish({
          kind: 'done',
          ok: m.exitCode === 0 && !error,
          ...(m.exitCode !== 0 || error ? { error: error ?? `GitHub Copilot CLI exited (${m.exitCode})` } : {}),
          session: m.sessionId ?? session,
        });
        break;
    }
  };
}

/** The subset of the CLI's JSONL events this reader reads. */
interface CopilotEvent {
  type: string;
  data?: { messageId?: string; deltaContent?: string; content?: string; message?: string };
  sessionId?: string;
  exitCode?: number;
}
