// A whole program in a real browser on the simulated mill (40× real time): Run, the tool change
// (the program waits, the machine is free: Z is touched on the plate there), Resume, the end.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-run.cjs [setup]      (needs Playwright; setup: toe (default), side, block, straps, vise)
const { chromium } = require('playwright');
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 300)));
  const dialogs = [];
  p.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  await p.getByRole('button', { name: /^Machine/ }).click();
  await p.evaluate(() => { window.__swarfSimWorld.speed = 40; });
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  const setup = process.argv[2] ?? 'toe';
  await p.locator('.simsetup select').selectOption(setup);
  const M = () => p.evaluate(() => { const m = window.__swarfMachine; return { job: m.job, state: m.status?.state, wpos: m.status?.wpos, spindle: m.status?.spindle, message: m.message, crash: m.crash, acked: m.acked, total: m.total }; });
  await p.getByRole('button', { name: 'Run program' }).click();
  log('confirm said:', JSON.stringify(dialogs[0]));
  let changes = 0;
  for (let i = 0; i < 2400; i++) {
    const m = await M();
    if (m.job === 'waiting') {
      changes++;
      log('waiting at a tool change:', JSON.stringify(m));
      // the machine is free: touch Z on the plate with the new tool, as one would
      await p.evaluate(() => window.__swarfMachine.request('$J=G90 X40 Y25 F3000'));
      await p.waitForTimeout(600);
      await p.waitForFunction(() => window.__swarfMachine.status?.state === 'Idle', null, { polling: 100 });
      await p.getByRole('button', { name: 'Touch the plate, set Z' }).click();
      await p.waitForFunction(() => !window.__swarfProbe.busy, null, { polling: 100, timeout: 60000 });
      log('touched:', await p.evaluate(() => window.__swarfProbe.result || window.__swarfProbe.error));
      await p.getByRole('button', { name: 'Resume' }).click();
      await p.waitForFunction(() => window.__swarfMachine.job !== 'waiting', null, { polling: 50 });
    }
    if (['done', 'failed', 'stopped'].includes(m.job)) break;
    await p.waitForTimeout(250);
  }
  log('end:', JSON.stringify(await M()), 'tool changes', changes);
  // Stop in the middle of a second run: held, then reset; the spindle off
  await p.getByRole('button', { name: 'Run program' }).click();
  await p.waitForTimeout(500);
  log('second run:', JSON.stringify(await M()));
  await p.waitForFunction(() => window.__swarfMachine.status?.state === 'Run' && window.__swarfMachine.status?.spindle > 0, null, { polling: 50, timeout: 20000 });
  await p.waitForTimeout(400);
  await p.getByRole('button', { name: 'Stop', exact: true }).click();
  await p.waitForTimeout(800);
  log('after Stop:', JSON.stringify(await M()));
  log('console tail:', JSON.stringify(await p.evaluate(() => window.__swarfMachine.console.slice(-6).map((l) => l.dir + ' ' + l.text.replace(/[\x00-\x1f]/g, '?')))));
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
