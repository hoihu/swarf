// Listening to the cut in a real browser: the microphone is a sound file (a three-flute cutter at
// 6000 rpm that starts to chatter at 1840 Hz after six seconds), the machine the simulated one.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-listen.cjs <cut.wav> [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
const WAV = process.argv[2]; const OUT = process.argv[3] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`] });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, permissions: ['microphone'] });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.getByRole('tab', { name: 'Stock' }).click();
  await p.getByRole('button', { name: 'Mill example' }).click();
  await p.getByRole('tab', { name: 'Machine' }).click();
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  await p.evaluate(() => window.__swarfMachine.send('M3 S6000'));
  await p.evaluate(() => { window.__swarfListening.teethSet = 3; });
  await p.waitForFunction(() => window.__swarfMachine.status?.spindle === 6000, null, { polling: 200, timeout: 10000 });
  await p.getByRole('button', { name: 'Listen', exact: true }).click();
  const L = () => p.evaluate(() => { const l = window.__swarfListening; return { on: l.on, err: l.error, state: l.state, hz: l.hz && Math.round(l.hz), teeth: l.heard?.teeth && Math.round(l.heard.teeth.hz), turning: l.heard?.turning && Math.round(l.heard.turning * 60) }; });
  for (let i = 0; i < 9; i++) { await p.waitForTimeout(1500); log(JSON.stringify(await L())); }
  log('panel:', (await p.locator('section.listen .now').innerText()).trim(), '|', (await p.locator('section.listen .ring').innerText().catch(() => '(no ring)')).replace(/\n+/g, ' | '));
  await p.locator('section.listen').screenshot({ path: `${OUT}/listen.png`, timeout: 120000 }).catch(() => {});
  const first = p.locator('section.listen .ring .btn').first();
  log('trying', await first.innerText());
  await first.click();
  await p.waitForTimeout(1500);
  log('spindle now', await p.evaluate(() => ({ rpm: window.__swarfMachine.status.spindle, ov: window.__swarfMachine.status.ov })));
  await p.getByRole('button', { name: 'Back to 100 %' }).click();
  await p.waitForTimeout(800);
  log('back:', await p.evaluate(() => window.__swarfMachine.status.ov));
  await p.getByRole('button', { name: 'Stop listening' }).click();
  await b.close();
})().catch((e) => { log('FAILED', e.message); process.exit(1); });
