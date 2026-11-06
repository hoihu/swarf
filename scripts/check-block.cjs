// The block check in a real browser: the simulated camera with its true calibration, the simulated
// block where the job has it and then moved, resized and turned; prints truth and measurement.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-block.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.getByRole('tab', { name: 'Stock' }).click();
  await p.getByRole('button', { name: 'Mill example' }).click();
  await p.getByRole('tab', { name: 'Machine' }).click();
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.locator('section.camera').getByRole('button', { name: 'Start', exact: true }).click();
  await p.waitForFunction(() => window.__swarfCamera?.running && window.__swarfSimCamera?.frameNo > 10 && window.__swarfCamera.wco(), null, { polling: 300, timeout: 60000 });
  const cases = [
    { name: 'as in the job', err: { dx: 0, dy: 0, dsx: 0, dsy: 0, angle: 0 } },
    { name: 'off, other size, turned', err: { dx: 1.5, dy: -2.0, dsx: 2.4, dsy: -1.3, angle: 0.8 } },
  ];
  await p.evaluate(() => {
    const c = window.__swarfCamera, s = window.__swarfSimCamera;
    c.calib = { lens: { ...s.lens, rms: 0, views: 0 }, pose: { R: s.pose.R, t: s.pose.t, frame: 'machine', kind: 'mill', rms: 0, points: 0, method: 'machine' } };
  });
  for (const k of cases) {
    await p.evaluate((err) => { window.__swarfSimCamera.stockError = err; window.__swarfCamera.block = null; }, k.err);
    await p.waitForTimeout(800);
    await p.locator('section.camera').getByRole('button', { name: 'Check the block' }).click();
    await p.waitForFunction(() => window.__swarfCamera.block || document.querySelector('section.camera .diag.error'), null, { polling: 300, timeout: 60000 });
    const r = await p.evaluate(() => { const f = window.__swarfCamera.block; return f ? { corner: f.corner.map((v) => +v.toFixed(2)), x: +f.x.toFixed(2), y: +f.y.toFixed(2), angle: +f.angle.toFixed(2), rms: f.edges.map((e) => +e.rms.toFixed(3)), used: f.edges.map((e) => `${e.used}/${e.searched}`) } : document.querySelector('section.camera .diag.error').textContent; });
    const dbg = await p.evaluate(() => ({ wco: window.__swarfCamera.wco(), mpos: window.__swarfCamera.mpos(), frame: window.__swarfSimCamera.frameNo, wpos: null }));
    log('dbg', JSON.stringify(dbg));
    const png = await p.evaluate(() => { const img = window.__swarfCamera.grab(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); return c.toDataURL('image/png'); });
    require('fs').writeFileSync((process.argv[2] ?? require('os').tmpdir()) + '/block-frame-' + k.name.split(' ')[0] + '.png', Buffer.from(png.split(',')[1], 'base64'));
    log(k.name, 'truth', JSON.stringify({ corner: [k.err.dx, k.err.dy], x: 80 + k.err.dsx, y: 50 + k.err.dsy, angle: k.err.angle }), 'measured', JSON.stringify(r));
  }
  await p.locator('section.camera ul.result').scrollIntoViewIfNeeded();
  await p.waitForTimeout(500);
  await p.screenshot({ path: (process.argv[2] ?? require('os').tmpdir()) + '/block-check.png', timeout: 120000 });
  log('shot');
  await b.close();
})().catch((e) => { log('FAILED', e.message); process.exit(1); });
