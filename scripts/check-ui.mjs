// The Playwright walks through the app, one after another, against a dev server of their own.
//   npx playwright install chromium     (once)
//   npm run check:ui [outdir]
// Starts Vite's dev server on a free port (the window.__swarf* hooks exist only in dev), passes
// its URL in SWARF_URL, says which script passed and which failed, and exits 1 if any failed.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'swarf-ui-'));

/** A port nothing listens on. */
const port = await new Promise((done, fail) => {
  const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => done(port));
  });
});
const url = `http://127.0.0.1:${port}/`;

/** What check-listen hears: a three-flute cutter at 6000 rpm, chattering at 1840 Hz after six seconds. */
function cutWav(path) {
  const rate = 48000, seconds = 20, n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const f = 6000 / 60;
  let s = 5;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0.01 * (((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1);
    for (let k = 1; k <= 10; k++) v += (0.2 / k) * Math.sin(2 * Math.PI * f * 3 * k * t);
    for (const k of [1, 2, 4]) v += 0.03 * Math.sin(2 * Math.PI * f * k * t);
    if (t > 6) v += 0.3 * Math.sin(2 * Math.PI * 1840 * t);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v / 1.5)) * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
  return path;
}

const checks = [
  ['check-jog.cjs', [out]],
  ['check-laser.cjs', [out]],
  ['check-listen.cjs', [cutWav(join(out, 'cut.wav')), out]],
  ['check-measured.cjs', [out]],
  ['check-probe.cjs', [out]],
  ['check-round.cjs', [out]],
  ['check-run.cjs', []],
  ['tour.cjs', [out]],
];

const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
  cwd: join(root, 'apps/web'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += d));
vite.stderr.on('data', (d) => (viteLog += d));
const stop = () => { if (vite.exitCode === null) vite.kill(); };
process.on('exit', stop);
process.on('SIGINT', () => process.exit(130));

for (let t = Date.now(); ; ) {
  if (vite.exitCode !== null) { console.error(viteLog); console.error('the dev server stopped'); process.exit(1); }
  try { if ((await fetch(url)).ok) break; } catch {}
  if (Date.now() - t > 60000) { console.error(viteLog); console.error(`no answer from ${url}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`dev server at ${url}, pictures in ${out}`);

const results = [];
for (const [name, args] of checks) {
  console.log(`\n--- ${name}`);
  const t = Date.now();
  const code = await new Promise((done) => {
    spawn(process.execPath, [join(root, 'scripts', name), ...args], { stdio: 'inherit', env: { ...process.env, SWARF_URL: url } })
      .on('exit', (c, sig) => done(c ?? (sig ? 1 : 0)));
  });
  results.push([name, code, ((Date.now() - t) / 1000).toFixed(0)]);
}

console.log('');
for (const [name, code, s] of results) console.log(`${code === 0 ? 'pass' : 'FAIL'}  ${name}  (${s} s)`);
stop();
process.exit(results.some(([, code]) => code !== 0) ? 1 : 0);
