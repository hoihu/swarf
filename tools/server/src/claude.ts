/**
 * Claude Code as the app chat's engine: `claude -p` with stream-json output, swarf's HTTP MCP
 * endpoint as its only MCP server and no other tools, the chat rules appended to its system prompt.
 * The message goes in on stdin and the rules in a file (neither fits a Windows command line).
 * Ported from 4k7 (tools/server/src/harness/claude.ts and claude-bin.ts), reduced to Claude Code.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { CHAT_RULES, type ChatCapability, type ChatEvent } from '@swarf/agent';

export type DoneEvent = Extract<ChatEvent, { kind: 'done' }>;

export interface ChatJob {
  text: string;
  session: string | null;
  model?: string;
  mcpUrl: string;
  token: string;
  /** Where the rules file is written. */
  rulesDir: string;
}

export interface RunSink {
  emit(event: ChatEvent): void;
  /** The run's outcome; the first one counts. */
  finish(done: DoneEvent): void;
  log(msg: string): void;
}

export interface Invocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
  line(line: string): void;
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `bin` itself when it is a path, else the first match on the PATH or in the usual install folders. */
export function findClaude(bin: string, env = process.env, home = homedir()): string | null {
  if (bin.includes(sep) || bin.includes('/')) return isExecutable(bin) ? bin : null;
  const dirs = [
    ...(env.PATH ?? '').split(delimiter),
    join(home, '.claude', 'local'),
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global', 'bin'),
    ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : []),
  ].filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) for (const e of exts) if (isExecutable(join(d, bin + e))) return join(d, bin + e);
  return null;
}

/**
 * Environment for the headless Claude: never the markers of a Claude Code session that may have
 * started this server (the run is not nested inside it).
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

export function detectClaude(bin: string): ChatCapability {
  const path = findClaude(bin);
  if (!path) return { available: false, reason: `Claude Code not found ("${bin}"). Install it (claude.com/claude-code), or set SWARF_CLAUDE_BIN to its path.` };
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000, env: childEnv(), shell: process.platform === 'win32' && path.endsWith('.cmd') });
  if (r.error || r.status !== 0) return { available: false, reason: `Claude Code at ${path} did not start: ${r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}`}` };
  return { available: true, version: r.stdout.trim().split(/\r?\n/)[0] ?? '' };
}

/** The rules in a file named after its content, written atomically (runs may share it). */
export function rulesFile(dir: string, text: string): string {
  const file = join(dir, `rules-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.md`);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    if (!existsSync(file)) throw e;
  }
  return file;
}

export class ClaudeHarness {
  readonly name = 'Claude Code';
  bin: string;

  constructor(bin: string) {
    this.bin = bin;
  }

  /** The program to start (resolved on the PATH and the usual folders). */
  get path(): string {
    return findClaude(this.bin) ?? this.bin;
  }

  detect(): ChatCapability {
    return detectClaude(this.bin);
  }

  chat(job: ChatJob, sink: RunSink): Invocation {
    return {
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--mcp-config',
        JSON.stringify({ mcpServers: { swarf: { type: 'http', url: job.mcpUrl, headers: { Authorization: `Bearer ${job.token}` } } } }),
        '--strict-mcp-config',
        '--tools',
        '', // no shell, files or web: only swarf's tools
        '--allowedTools',
        'mcp__swarf',
        '--permission-mode',
        'dontAsk',
        '--append-system-prompt-file',
        rulesFile(job.rulesDir, CHAT_RULES),
        ...(job.model ? ['--model', job.model] : []),
        ...(job.session ? ['--resume', job.session] : []),
      ],
      env: childEnv(),
      stdin: job.text,
      line: streamReader(sink),
    };
  }
}

/** The subset of Claude Code's stream-json output that is read. */
type StreamJson =
  | { type: 'system'; subtype?: string; session_id?: string; mcp_servers?: { name: string; status: string }[] }
  | { type: 'stream_event'; event?: { type: string; delta?: { type: string; text?: string; thinking?: string } } }
  | { type: 'assistant'; message?: { content?: { type: string; text?: string }[] } }
  | { type: 'result'; subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number; session_id?: string }
  | { type: 'user' };

/** Reads stream-json lines into chat events. */
export function streamReader(sink: RunSink): (line: string) => void {
  let streamed = false;
  return (line) => {
    if (!line.startsWith('{')) return;
    let m: StreamJson;
    try {
      m = JSON.parse(line) as StreamJson;
    } catch {
      return;
    }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          if (m.session_id) sink.emit({ kind: 'session', session: m.session_id });
          const s = m.mcp_servers?.find((x) => x.name === 'swarf');
          if (s && s.status !== 'connected') sink.log(`swarf MCP status ${s.status}`);
        }
        return;
      case 'stream_event': {
        const e = m.event;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          streamed = true;
          sink.emit({ kind: 'text', text: e.delta.text });
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && e.delta.thinking) {
          sink.emit({ kind: 'thinking', text: e.delta.thinking });
        } else if (e?.type === 'message_start' && streamed) {
          // a new model call after tool use: a new paragraph
          sink.emit({ kind: 'text', text: '\n\n' });
        }
        return;
      }
      case 'assistant':
        // without partial messages (older CLIs), the text comes whole
        if (!streamed) for (const b of m.message?.content ?? []) if (b.type === 'text' && b.text) sink.emit({ kind: 'text', text: b.text });
        return;
      case 'result': {
        const ok = !m.is_error && m.subtype === 'success';
        sink.finish({
          kind: 'done',
          ok,
          ...(ok ? {} : { error: m.result || m.subtype || 'Claude Code reported an error.' }),
          ...(typeof m.total_cost_usd === 'number' ? { costUsd: m.total_cost_usd } : {}),
          ...(m.session_id ? { session: m.session_id } : {}),
        });
        return;
      }
    }
  };
}
