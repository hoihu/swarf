/**
 * The app's chat answered by a coding agent's CLI on this computer (Claude Code, GitHub Copilot CLI,
 * Codex CLI): one headless run per message, with the user's own login and plan, whose only tools are
 * swarf's (through this server's /mcp endpoint, so they act on the open tab). Each run gets its own
 * bearer token; only tokens of runs still going open the endpoint. Ported from 4k7's ChatRunner.
 */
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChatEvent, HarnessId, HarnessInfo } from '@swarf/agent';
import { spawnCli, type ChatJob, type DoneEvent, type Harness, type Invocation, type RunSink } from './harness/types.ts';
import { tokensMatch } from './mcp.ts';
import type { ChatMessage, LocalServer } from './server.ts';

export interface ChatRunnerOptions {
  server: LocalServer;
  harnesses: Harness[];
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

  /** What each CLI can do on this computer (runs `--version` on each). */
  detect(): HarnessInfo[] {
    return this.#o.harnesses.map((h) => h.detect());
  }

  #harness(id: HarnessId | undefined): Harness | undefined {
    return this.#o.harnesses.find((h) => h.id === (id ?? 'claude'));
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
    const harness = this.#harness(msg.harness);
    const refuse = (error: string): DoneEvent => {
      const d: DoneEvent = { kind: 'done', ok: false, error };
      this.#emit(msg.id, d);
      return d;
    };
    if (!harness) return refuse(`This server does not know the coding agent "${msg.harness}".`);
    if ([...this.#runs.values()].some((r) => !r.done)) return refuse('The previous message is still being answered.');
    const run: Run = { token: randomBytes(24).toString('hex'), child: null, done: false, cancelled: false };
    this.#runs.set(msg.id, run);
    this.#o.log?.(`chat ${msg.id}: ${harness.name}, ${msg.session ? `resume ${msg.session.slice(0, 8)}` : 'new session'}`);
    const done = await this.#spawn(msg.id, run, harness, {
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

  async #spawn(id: string, run: Run, harness: Harness, job: ChatJob): Promise<DoneEvent> {
    let outcome: DoneEvent | null = null;
    const sink: RunSink = {
      emit: (e) => this.#emit(id, e),
      finish: (d) => (outcome ??= d),
      log: (m) => this.#o.log?.(`chat ${id}: ${m}`),
    };
    let inv: Invocation;
    try {
      inv = await harness.chat(job, sink);
    } catch (e) {
      return { kind: 'done', ok: false, error: `Could not start ${harness.name}: ${(e as Error).message}` };
    }
    if (run.cancelled) return { kind: 'done', ok: false, error: 'Stopped.' };
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnCli(harness.bin, inv.args, { cwd: this.#o.workDir, env: inv.env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ kind: 'done', ok: false, error: `Could not start ${harness.name}: ${(e as Error).message}` });
        return;
      }
      run.child = child;
      child.stdin!.on('error', () => {});
      child.stdin!.end(inv.stdin);
      let stderr = '';
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (l) => inv.line(l));
      // every line read before the outcome is decided
      const stdoutDone = new Promise<void>((r) => lines.once('close', () => r()));
      child.stderr!.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)));
      child.on('error', (e) => {
        outcome ??= { kind: 'done', ok: false, error: `Could not start ${harness.name}: ${e.message}` };
        if (child.pid === undefined) resolve(outcome);
      });
      child.on('close', async (code, signal) => {
        await stdoutDone;
        try {
          await inv.close?.(code);
        } catch (e) {
          this.#o.log?.(`chat ${id}: ${(e as Error).message}`);
        }
        outcome ??= {
          kind: 'done',
          ok: false,
          error: signal || run.cancelled ? 'Stopped.' : `${harness.name} exited (${code})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`,
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
