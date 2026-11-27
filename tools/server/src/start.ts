#!/usr/bin/env node
/**
 * `npm start`: swarf in one go. Builds the app, makes sure Claude Code is logged in (if it is
 * installed and is not, it offers `claude auth login` right here), then runs the server with the
 * app and opens it in the browser, the app's chat answered by Claude Code.
 *
 *   npm start              build, log in if needed, serve, open the browser
 *   npm start -- --no-open the same without opening the browser
 */
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeLoggedIn, childEnv } from './harness/claude.ts';
import { findCli } from './harness/types.ts';

const say = (msg: string) => process.stderr.write(`[swarf] ${msg}\n`);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// 1. the app as it is in this checkout (a pull since the last build is in it)
say('building the app…');
const build = spawnSync(npm, ['run', 'build'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
if (build.status !== 0) {
  process.stderr.write(`${build.stdout ?? ''}${build.stderr ?? ''}`);
  say('the build failed (above); fix that first, or run `npm install` if a package is missing.');
  process.exit(1);
}

// 2. Claude Code logged in, so that the app's chat can use it
const bin = process.env.SWARF_CLAUDE_BIN ?? 'claude';
if (findCli(bin, childEnv())) {
  if (claudeLoggedIn(bin) === false) {
    if (process.stdin.isTTY) {
      say('Claude Code is not logged in on this computer. Logging in now (a browser window opens)…');
      spawnSync(findCli(bin, childEnv())!, ['auth', 'login'], { stdio: 'inherit', env: childEnv() });
      if (claudeLoggedIn(bin) !== true) say('still not logged in: the chat will say so. Run `claude auth login` and send again (no restart needed).');
    } else say('Claude Code is not logged in: run `claude auth login` once (no restart needed).');
  }
} else say(`Claude Code not found ("${bin}"): the chat uses a model API key or the offline demo instead.`);

// 3. the server with the app, opened in the browser
const args = [fileURLToPath(new URL('./main.ts', import.meta.url)), '--serve', ...(process.argv.includes('--no-open') ? [] : ['--open'])];
const server = spawn(process.execPath, args, { stdio: 'inherit' });
const stop = () => server.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
