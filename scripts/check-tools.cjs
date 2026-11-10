// Tool lengths in a real browser on the simulated mill (40× real time): a program with tool
// changes where every tool sticks out differently, each measured on the (simulated) tool setter
// at its change; then the top of the work is touched to see whether Z zero is still on it. And:
// stopping in an operation and starting again there.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-tools.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const OUT = process.argv[2];
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 1300 } });
  p.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 300)));
  const dialogs = [];
  p.on('dialog', (d) => { dialogs.push(d.message().split('\n')[0]); void d.accept(); });
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.getByRole('tab', { name: 'Stock' }).click();
  await p.getByRole('button', { name: 'Mill example' }).click();
  await p.getByRole('tab', { name: 'Machine' }).click();
  await p.evaluate(() => { window.__swarfSimWorld.speed = 40; });
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  await p.locator('.simsetup select').selectOption('toe');
  const idle = () => p.waitForFunction(() => window.__swarfMachine.status?.state === 'Idle' && !window.__swarfTooling.busy, null, { polling: 100, timeout: 120000 });
  const tools = p.locator('section.toolpanel');
  /** Touch the top of the block at X40 Y25 and say what work Z it is found at (it should stay where it was). */
  const touchTop = async () => {
    await p.evaluate(() => window.__swarfMachine.request('G90 G0 Z25'));
    await p.evaluate(() => window.__swarfMachine.request('G0 X40 Y25'));
    await p.waitForTimeout(400); await idle();
    await p.evaluate(() => { window.__swarfMachine.probe = null; return window.__swarfMachine.request('G38.2 Z-25 F300'); });
    await p.waitForTimeout(400); await idle();
    const z = await p.evaluate(() => { const m = window.__swarfMachine; return m.probe.mpos[2] - (m.status.mpos[2] - m.status.wpos[2]); });
    await p.evaluate(() => window.__swarfMachine.request('G0 Z25'));
    await p.waitForTimeout(300); await idle();
    return +z.toFixed(3);
  };
  const top0 = await touchTop();
  log('the top with the first tool is at work Z', top0);
  // the setter; a reading of the tool the program starts with
  await tools.locator('summary').click();
  await tools.getByRole('button', { name: 'Use the simulated setter' }).click();
  const first = await p.evaluate(() => window.__swarfStore.analysis.program.segments[0].tool);
  await tools.locator('select').first().selectOption(String(first));
  await tools.getByRole('button', { name: 'Take a reading of the tool now in' }).click();
  await p.waitForTimeout(500); await idle();
  log('reading:', await tools.locator('p.ok').innerText().catch(() => ''), await tools.locator('.diag.error').innerText().catch(() => ''));
  await p.getByRole('button', { name: 'Run program' }).click();
  let changes = 0;
  for (let i = 0; i < 3000; i++) {
    const m = await p.evaluate(() => ({ job: window.__swarfMachine.job, pending: window.__swarfTooling.pending, active: window.__swarfTooling.active }));
    if (m.job === 'waiting') {
      changes++;
      await p.waitForFunction(() => window.__swarfTooling.pending !== null, null, { polling: 50, timeout: 5000 });
      if (OUT && changes === 1) await tools.screenshot({ path: OUT + '/tool-change.png' });
      await tools.getByRole('button', { name: 'Measure it on the setter' }).click({ force: true });
      await p.waitForTimeout(500); await idle();
      log(`change ${changes}:`, await tools.locator('p.ok').innerText().catch(() => ''), await tools.locator('.diag.error').innerText().catch(() => ''), '| sim stick-out', await p.evaluate(() => window.__swarfSimWorld.stickout));
      await p.getByRole('button', { name: 'Resume' }).click();
      await p.waitForFunction(() => window.__swarfMachine.job !== 'waiting', null, { polling: 50 });
    }
    if (['done', 'failed', 'stopped'].includes(m.job)) break;
    await p.waitForTimeout(200);
  }
  log('program:', await p.evaluate(() => window.__swarfMachine.job), 'tool changes', changes, 'crash:', JSON.stringify(await p.evaluate(() => window.__swarfMachine.crash)), 'asked:', JSON.stringify(dialogs));
  log('the top with the last tool is at work Z', await touchTop(), '(was', top0 + ')');

  // stop in the pocket, start again there. (The script says "loaded and touched off" to tools it has
  // not touched off, so the app has no reading to compare with at the changes below, says so, and asks
  // before going on: that is what should happen. The depths in this part mean nothing.)
  await p.evaluate(() => window.__swarfMachine.request('G0 X0 Y0'));
  await p.waitForTimeout(500); await idle();
  await p.getByRole('button', { name: 'Run program' }).click();
  for (let i = 0; i < 2000; i++) {
    const m = await p.evaluate(() => ({ job: window.__swarfMachine.job, line: window.__swarfMachine.line, op2: (() => { const s = window.__swarfStore; let n = 0; for (const g of s.analysis.program.segments) { if (g.opId === 'op2') return s.gcode.lineOfMove[n + 15]; n += g.moves.length; } })() }));
    if (m.job === 'waiting') { await tools.getByRole('button', { name: 'Measure it on the setter' }).click({ force: true, timeout: 8000 }).catch(async () => { log('no button; panel says:', JSON.stringify(await tools.innerText()), JSON.stringify(await p.evaluate(() => ({ pending: window.__swarfTooling.pending, active: window.__swarfTooling.active, line: window.__swarfMachine.line, job: window.__swarfMachine.job })))); throw new Error('stuck'); }); await p.waitForTimeout(500); await idle(); await p.getByRole('button', { name: 'Resume' }).click(); await p.waitForFunction(() => window.__swarfMachine.job !== 'waiting', null, { polling: 50, timeout: 60000 }); }
    if (m.line >= m.op2) break;
    await p.waitForTimeout(100);
  }
  await p.getByRole('button', { name: 'Stop', exact: true }).click();
  await p.waitForTimeout(1200);
  log('stopped:', await p.evaluate(() => ({ job: window.__swarfMachine.job, z: +window.__swarfMachine.status.wpos[2].toFixed(2), spindle: window.__swarfMachine.status.spindle })));
  log('start row:', JSON.stringify(await p.locator('.row.from').innerText().catch((e) => String(e).slice(0, 80))), JSON.stringify(await p.evaluate(() => ({ line: window.__swarfMachine.line, job: window.__swarfMachine.job }))));
  const offer = p.getByRole('button', { name: /It stopped in op2/ });
  log('offers:', await offer.innerText());
  await offer.click();
  if (OUT) await p.locator('section.machine, .machine').first().screenshot({ path: OUT + '/start-at.png' }).catch(() => {});
  await p.getByRole('button', { name: 'Run from op2' }).click();
  for (let i = 0; i < 3000; i++) {
    const job = await p.evaluate(() => window.__swarfMachine.job);
    if (job === 'waiting') { await p.waitForFunction(() => window.__swarfTooling.pending !== null, null, { polling: 50, timeout: 5000 }); await tools.getByRole('button', { name: 'Measure it on the setter' }).click({ force: true }); await p.waitForTimeout(500); await idle(); log('change after the restart:', await tools.locator('p.ok').innerText().catch(() => ''), await tools.locator('.diag.error').innerText().catch(() => ''), '| sim stick-out', await p.evaluate(() => window.__swarfSimWorld.stickout), 'dialogs', dialogs.length); await p.getByRole('button', { name: 'Resume' }).click(); await p.waitForFunction(() => window.__swarfMachine.job !== 'waiting', null, { polling: 50, timeout: 60000 }); }
    if (['done', 'failed', 'stopped'].includes(job)) break;
    await p.waitForTimeout(200);
  }
  log('run from op2:', await p.evaluate(() => ({ job: window.__swarfMachine.job, crash: window.__swarfMachine.crash, message: window.__swarfMachine.message })), 'asked:', JSON.stringify(dialogs.slice(-2)));
  log('the top is at work Z', await touchTop());
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
