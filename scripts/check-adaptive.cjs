// Adaptive clearing in a real browser: switch the example pocket to it in the form, look at the preview, run it on the simulated mill.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-adaptive.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 300)));
  p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  await p.getByRole('tab', { name: 'Operations' }).click();
  const before = await p.evaluate(() => Math.round(window.__swarfStore.analysis.seconds));
  await p.locator('.ops .op').nth(1).click();
  await p.locator('.detail').getByLabel('Strategy').selectOption('adaptive');
  await p.waitForTimeout(800);
  const st = await p.evaluate(() => { const s = window.__swarfStore; return { op: s.job.operations[1].strategy, load: s.job.operations[1].load, seconds: Math.round(s.analysis.seconds), diags: s.analysis.diagnostics.map((d) => d.code), lines: s.gcode.text.split('\n').length }; });
  log('set in the form:', JSON.stringify(st), '| job before:', before, 's');
  await p.locator('.viewer').getByRole('button', { name: 'Top', exact: true }).click();
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/adaptive-app.png`, timeout: 120000 });
  // run it on the simulated mill, fast
  await p.evaluate(() => { window.__swarfSimWorld.speed = 40; });
  await p.getByRole('button', { name: /^Machine/ }).click();
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  await p.evaluate(() => { const s = window.__swarfStore; const j = JSON.parse(JSON.stringify(s.job)); s.set(window.__swarfJob.parse({ ...j, operations: [j.operations[1]] })); });
  await p.getByRole('button', { name: 'Run program' }).click();
  for (let i = 0; i < 80; i++) {
    await p.waitForTimeout(1500);
    const m = await p.evaluate(() => ({ job: window.__swarfMachine.job, line: window.__swarfMachine.line, crash: window.__swarfMachine.crash, msg: window.__swarfMachine.message }));
    if (m.job === 'waiting') await p.getByRole('button', { name: /Resume/ }).first().click().catch(() => {});
    if (m.job === 'done' || m.job === 'failed' || m.crash) { log('run:', JSON.stringify(m)); break; }
    if (i % 10 === 0) log('…', m.job, m.line);
  }
  await b.close();
})().catch((e) => { log('FAILED', e.message); process.exit(1); });
