/**
 * OpenCode: `opencode run --format json` with an agent of its own, defined for the run through
 * OPENCODE_CONFIG_CONTENT (merged into the user's config, so their providers and logins apply):
 * the chat rules as its prompt (from a file: they do not fit a variable on Windows), swarf's
 * endpoint as a remote MCP server, and every tool but swarf's switched off. The message goes in on
 * stdin (an argument would be quoted).
 *
 * The user's own MCP servers would still start (their programs run, though the agent never sees
 * their tools): `opencode debug config` names them and each is switched off for the run. Project
 * config and instructions (the working folder is a neutral one anyway) and Claude Code's files are
 * switched off by environment; the user's own global instructions still apply (config
 * `instructions` lists are appended to, not replaced). `scripts/check-opencode.mjs` runs the real CLI.
 *
 * `opencode run` can exit before it prints the last step of its answer, so once it has exited the
 * session is read back with `opencode export` and whatever the stream left out is sent then.
 * Ported from 4k7 (tools/server/src/harness/opencode.ts), without token counting and web access.
 */
import { CHAT_RULES, type HarnessInfo } from '@swarf/agent';
import { capture, detectCli, parseLine, rulesFile, type ChatJob, type Harness, type Invocation, type RunSink } from './types.ts';

const AGENT = 'swarf-chat';
/** The run's MCP server; its tools are `swarf_<tool>` to OpenCode. */
export const OPENCODE_SERVER = 'swarf';

export class OpenCodeHarness implements Harness {
  readonly id = 'opencode' as const;
  readonly name = 'OpenCode';
  bin: string;
  #cwd: string;

  constructor(bin: string, cwd: string) {
    this.bin = bin;
    this.#cwd = cwd;
  }

  detect(): HarnessInfo {
    return { id: this.id, name: this.name, ...detectCli(this.bin, 'OpenCode', this.#env(), 'SWARF_OPENCODE_BIN', 'npm install -g opencode-ai') };
  }

  #env(): NodeJS.ProcessEnv {
    return { ...process.env, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' };
  }

  /** The MCP servers in the user's config (ours, added for the run, replaces one of the same name). */
  async #userServers(): Promise<string[]> {
    const out = await capture(this.bin, ['debug', 'config'], { env: this.#env(), cwd: this.#cwd, timeoutMs: 60_000 });
    const start = out?.indexOf('{') ?? -1;
    try {
      return Object.keys((JSON.parse(out!.slice(start)) as { mcp?: Record<string, unknown> }).mcp ?? {}).filter((n) => n !== OPENCODE_SERVER);
    } catch {
      throw new Error('it did not say which MCP servers it would start ("opencode debug config").');
    }
  }

  async chat(job: ChatJob, sink: RunSink): Promise<Invocation> {
    const users = await this.#userServers();
    const config = {
      mcp: {
        ...Object.fromEntries(users.map((name) => [name, { enabled: false }])),
        [OPENCODE_SERVER]: { type: 'remote', url: job.mcpUrl, headers: { Authorization: `Bearer ${job.token}` }, enabled: true },
      },
      agent: {
        [AGENT]: {
          mode: 'primary',
          description: 'Answers the chat of the swarf app through its tools',
          // forward slashes: this goes into the config's text as it is, where a backslash would be an escape
          prompt: `{file:${rulesFile(job.rulesDir, CHAT_RULES).replaceAll('\\', '/')}}`,
          tools: { '*': false, [`${OPENCODE_SERVER}_*`]: true },
          permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' },
        },
      },
    };
    const env = { ...this.#env(), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    return {
      args: ['run', '--format', 'json', '--thinking', '--agent', AGENT, ...(job.model ? ['--model', job.model] : []), ...(job.session ? ['--session', job.session] : [])],
      env,
      stdin: job.text,
      ...this.#reader(job, env, sink),
    };
  }

  #reader(job: ChatJob, env: NodeJS.ProcessEnv, sink: RunSink): Pick<Invocation, 'line' | 'close'> {
    let session = job.session;
    let wrote = false;
    let cost = 0;
    let error: string | undefined;
    const seen = new Set<string>(); // parts already passed on
    const text = (t: string) => {
      if (!t.trim()) return;
      sink.emit({ kind: 'text', text: wrote ? `\n\n${t}` : t });
      wrote = true;
    };
    const part = (p: OpenCodePart) => {
      if (p.id) {
        if (seen.has(p.id)) return;
        seen.add(p.id);
      }
      if (p.type === 'text' && p.text && !p.synthetic) text(p.text);
      else if (p.type === 'reasoning' && p.text) sink.emit({ kind: 'thinking', text: p.text });
      else if (p.type === 'step-finish') cost += p.cost ?? 0;
    };
    return {
      line: (line) => {
        const m = parseLine<OpenCodeEvent>(line);
        if (!m) return;
        if (m.sessionID && m.sessionID !== session) {
          session = m.sessionID;
          sink.emit({ kind: 'session', session });
        }
        if (m.type === 'error') error = errorText(m.error) ?? 'OpenCode reported an error.';
        else if (m.part) part(m.part);
      },
      close: async (code) => {
        if (session) {
          const out = await capture(this.bin, ['export', session], { env, cwd: this.#cwd });
          const start = out?.indexOf('{') ?? -1;
          try {
            const exported = start >= 0 ? (JSON.parse(out!.slice(start)) as { messages?: { info?: { role?: string; error?: unknown }; parts?: OpenCodePart[] }[] }) : null;
            const msgs = exported?.messages ?? [];
            const lastUser = msgs.findLastIndex((x) => x.info?.role === 'user');
            for (const msg of msgs.slice(lastUser + 1)) {
              for (const p of msg.parts ?? []) part(p);
              if (msg.info?.error) error ??= errorText(msg.info.error);
            }
          } catch (e) {
            sink.log(`opencode export: ${(e as Error).message}`);
          }
        }
        if (code === 0 || error) sink.finish({ kind: 'done', ok: !error, ...(error ? { error } : {}), ...(cost ? { costUsd: cost } : {}), ...(session ? { session } : {}) });
      },
    };
  }
}

function errorText(e: unknown): string | undefined {
  const err = e as { name?: string; message?: string; data?: { message?: string } } | undefined;
  return err?.data?.message ?? err?.message ?? err?.name;
}

/** A message part as `opencode run --format json` and `opencode export` give it (the fields read here). */
interface OpenCodePart {
  id?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  cost?: number;
}

interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: OpenCodePart;
  error?: unknown;
}
