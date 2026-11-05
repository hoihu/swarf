/**
 * A coding agent's CLI ("harness") that the server runs headlessly to answer the app chat: how to
 * start it with only swarf's tools, and how to read what it prints. Each one uses the user's own
 * login and plan. Ported from 4k7 (tools/server/src/harness/types.ts and claude-bin.ts).
 */
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import type { ChatCapability, ChatEvent, HarnessId, HarnessInfo } from '@swarf/agent';

export type DoneEvent = Extract<ChatEvent, { kind: 'done' }>;

/** One chat message to answer. */
export interface ChatJob {
  text: string;
  /** The CLI's session to continue, null for a new conversation. */
  session: string | null;
  model?: string;
  /** The server's MCP endpoint and the bearer token of this run. */
  mcpUrl: string;
  token: string;
  /** Where the run's rules can be written for the CLI to read (see rulesFile). */
  rulesDir: string;
}

/** Where a run's output goes. */
export interface RunSink {
  emit(event: ChatEvent): void;
  /** The run's outcome; the first one counts. */
  finish(done: DoneEvent): void;
  log(msg: string): void;
}

/** How to start one run, and the reader for its stdout. */
export interface Invocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Written to the CLI's stdin. */
  stdin: string;
  line(line: string): void;
  /** After the process exited, before its exit code decides the outcome (e.g. to fetch what the stream left out). */
  close?(code: number | null): void | Promise<void>;
}

export interface Harness {
  readonly id: HarnessId;
  readonly name: string;
  /** The CLI: a path, or a name looked up on the PATH and in the usual install folders. */
  bin: string;
  detect(): HarnessInfo;
  /** Promise: it may first have to ask the CLI something. */
  chat(job: ChatJob, sink: RunSink): Invocation | Promise<Invocation>;
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
export function findCli(bin: string, env = process.env, home = homedir()): string | null {
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

/** npm installs CLIs on Windows as .cmd files, which only start through the shell. */
const viaShell = (path: string) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(path);

export function spawnCli(bin: string, args: string[], opts: SpawnOptions) {
  const path = findCli(bin) ?? bin;
  return spawn(path, args, { ...opts, shell: viaShell(path) });
}

export function spawnCliSync(bin: string, args: string[], opts: Omit<SpawnSyncOptionsWithStringEncoding, 'shell'>) {
  const path = findCli(bin) ?? bin;
  return spawnSync(path, args, { ...opts, shell: viaShell(path) });
}

/** `<bin> --version`, the first line of it; unavailable when it is not there or does not run. */
export function detectCli(bin: string, name: string, env: NodeJS.ProcessEnv, envVar: string, install: string): ChatCapability {
  const path = findCli(bin, env);
  if (!path) return { available: false, reason: `${name} not found ("${bin}"). Install it (${install}), or set ${envVar} to its path.` };
  const r = spawnCliSync(path, ['--version'], { encoding: 'utf8', timeout: process.platform === 'win32' ? 30_000 : 15_000, env });
  if (r.error || r.status !== 0) return { available: false, reason: `${name} at ${path} did not start: ${r.error?.message ?? (r.stderr?.trim() || `exit ${r.status}`)}` };
  return { available: true, version: r.stdout.trim().split(/\r?\n/)[0] ?? '' };
}

/** Run a CLI to completion and return its stdout (null when it failed). */
export function capture(bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, args, { env: opts.env, ...(opts.cwd ? { cwd: opts.cwd } : {}), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.stdout!.on('data', (d) => (out += String(d)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

/**
 * A run's rules in a file, for a CLI that can read them from one (they are longer than a Windows
 * command line may be). Named after what it holds, so runs share it; written atomically.
 */
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

/** JSON of one output line, or null for anything else the CLI prints. */
export function parseLine<T>(line: string): T | null {
  if (!line.startsWith('{')) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/** -1, 0, 1 for dotted version numbers. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
