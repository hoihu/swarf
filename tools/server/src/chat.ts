/**
 * The app's chat answered by Claude Code on this computer: one headless run per message, with the
 * user's own login and plan, whose only tools are swarf's (through this server's /mcp endpoint, so
 * they act on the open tab). Each run gets its own bearer token; only tokens of runs still going
 * open the endpoint. Ported from 4k7's ChatRunner (tools/server/src/chat.ts), chat only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChatEvent } from '@swarf/agent';
import type { ClaudeHarness, DoneEvent, RunSink } from './claude.ts';
import { tokensMatch } from './mcp.ts';
import type { ChatMessage, LocalServer } from './server.ts';

export interface ChatRunnerOptions {
  server: LocalServer;
  claude: ClaudeHarness;
  /** Neutral working directory for the runs (no project files, no CLAUDE.md). */
  workDir: string;
  log?: (msg: string) => void;
}

interface Run {
  token: string;
  child: ChildProcess | null;
  done: boolean;
  cancelled: boolean;
}

export class ChatRunner {
  #o: ChatRunnerOptions;
  #runs = new Map<string, Run>();

  constructor(o: ChatRunnerOptions) {
    this.#o = o;
    mkdirSync(o.workDir, { recursive: true, mode: 0o700 });
  }

  /** A bearer token of a run that is still going. */
  validToken = (token: string): boolean => {
    for (const r of this.#runs.values()) if (!r.done && tokensMatch(r.token, token)) return true;
    return false;
  };

  handle = (msg: ChatMessage): void => {
    if (msg.type === 'chat_cancel') this.cancel(msg.id);
    else void this.start(msg);
  };

  #emit(id: string, event: ChatEvent): void {
    this.#o.server.sendToTab({ type: 'chat_event', id, event });
  }

  async start(msg: Extract<ChatMessage, { type: 'chat' }>): Promise<DoneEvent> {
    if ([...this.#runs.values()].some((r) => !r.done)) {
      const busy: DoneEvent = { kind: 'done', ok: false, error: 'Claude Code is still working on the previous message.' };
      this.#emit(msg.id, busy);
      return busy;
    }
    const run: Run = { token: randomBytes(24).toString('hex'), child: null, done: false, cancelled: false };
    this.#runs.set(msg.id, run);
    this.#o.log?.(`chat ${msg.id}: ${msg.session ? `resume ${msg.session.slice(0, 8)}` : 'new session'}`);
    const done = await this.#spawn(msg.id, run, {
      text: msg.text,
      session: msg.session,
      ...(msg.model ? { model: msg.model } : {}),
      mcpUrl: `http://127.0.0.1:${this.#o.server.port}/mcp`,
      token: run.token,
      rulesDir: join(this.#o.workDir, 'rules'),
    });
    run.done = true;
    this.#runs.delete(msg.id);
    this.#emit(msg.id, done);
    return done;
  }

  #spawn(id: string, run: Run, job: Parameters<ClaudeHarness['chat']>[0]): Promise<DoneEvent> {
    const harness = this.#o.claude;
    return new Promise((resolve) => {
      let outcome: DoneEvent | null = null;
      const sink: RunSink = {
        emit: (e) => this.#emit(id, e),
        finish: (d) => (outcome ??= d),
        log: (m) => this.#o.log?.(`chat ${id}: ${m}`),
      };
      let child: ChildProcess;
      let inv: ReturnType<ClaudeHarness['chat']>;
      try {
        inv = harness.chat(job, sink);
        const path = harness.path;
        child = spawn(path, inv.args, { cwd: this.#o.workDir, env: inv.env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' && path.endsWith('.cmd') });
      } catch (e) {
        resolve({ kind: 'done', ok: false, error: `Could not start Claude Code: ${(e as Error).message}` });
        return;
      }
      run.child = child;
      child.stdin!.on('error', () => {});
      child.stdin!.end(inv.stdin);
      let stderr = '';
      createInterface({ input: child.stdout! }).on('line', (l) => inv.line(l));
      child.stderr!.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)));
      child.on('error', (e) => {
        outcome ??= { kind: 'done', ok: false, error: `Could not start Claude Code: ${e.message}` };
        if (child.pid === undefined) resolve(outcome);
      });
      child.on('close', (code, signal) => {
        outcome ??= {
          kind: 'done',
          ok: false,
          error: signal || run.cancelled ? 'Stopped.' : `Claude Code exited (${code})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`,
        };
        if (run.cancelled && outcome.ok) outcome = { ...outcome, ok: false, error: 'Stopped.' };
        this.#o.log?.(`chat ${id}: finished (${signal ?? code})`);
        resolve(outcome);
      });
    });
  }

  cancel(id: string): void {
    const r = this.#runs.get(id);
    if (!r || r.done) return;
    r.cancelled = true;
    const child = r.child;
    if (!child) return;
    child.kill('SIGINT');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
  }

  stopAll(): void {
    for (const id of this.#runs.keys()) this.cancel(id);
  }
}
