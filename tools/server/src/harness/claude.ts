/**
 * Claude Code as the app chat's engine: `claude -p` with stream-json output, swarf's HTTP MCP
 * endpoint as its only MCP server and no other tools, the chat rules appended to its system prompt.
 * The message goes in on stdin and the rules in a file (neither fits a Windows command line).
 * Ported from 4k7 (tools/server/src/harness/claude.ts).
 */
import { CHAT_RULES, type HarnessInfo } from '@swarf/agent';
import { detectCli, findCli, rulesFile, type ChatJob, type Harness, type Invocation, type RunSink } from './types.ts';

/** `bin` itself when it is a path, else the first match on the PATH or in the usual install folders. */
export const findClaude = findCli;

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

export function detectClaude(bin: string): HarnessInfo {
  return { id: 'claude', name: 'Claude Code', ...detectCli(bin, 'Claude Code', childEnv(), 'SWARF_CLAUDE_BIN', 'claude.com/claude-code') };
}

export class ClaudeHarness implements Harness {
  readonly id = 'claude' as const;
  readonly name = 'Claude Code';
  bin: string;

  constructor(bin: string) {
    this.bin = bin;
  }

  detect(): HarnessInfo {
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
