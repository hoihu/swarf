// Touch probing in a real browser against the simulated mill, whose block is not where the job says:
// Z on a touch plate, the top at 3 × 3 points, the front-left corner; prints what was found and the truth.
// The setup on the simulated table: side (default), block, toe, straps, vise.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-probe.cjs [outdir] [setup]      (needs Playwright)
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
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  const setup = process.argv[3] ?? 'side';
  await p.locator('.simsetup select').selectOption(setup);
  log('setup', setup);
  const truth = () => p.evaluate(() => {
    const w = window.__swarfSimWorld, m = window.__swarfMachine.status;
    const wco = m.mpos.map((v, i) => v - m.wpos[i]);
    return { wcoFromOrigin: wco.map((v, i) => +(v - w.origin[i]).toFixed(4)) };
  });
  const run = async (button, timeout = 180000) => {
    await p.getByRole('button', { name: button }).click();
    await p.waitForFunction(() => !window.__swarfProbe.busy, null, { polling: 200, timeout });
    return p.evaluate(() => ({ result: window.__swarfProbe.result, error: window.__swarfProbe.error }));
  };
  const job = await p.evaluate(() => 0);
  void job;
  // 1: Z on a 10 mm plate, where the cutter is (work X40 Y25)
  let r = await run('Touch the plate, set Z');
  const expZ = await p.evaluate(() => { const w = window.__swarfSimWorld; return +(w.stockError.dz + w.stockError.tiltX * 40 + w.stockError.tiltY * 25).toFixed(4); });
  log('plate:', JSON.stringify(r), 'wco-origin', JSON.stringify(await truth()), 'expected z', expZ);
  // 2: the top at 3 × 3 points
  r = await run('Check the top (3 × 3)');
  const surf = await p.evaluate(() => { const s = window.__swarfProbe.surface; return s && { hi: s.highest, lo: s.lowest, sx: s.slopeX, sy: s.slopeY, flat: s.flatness, points: s.points.length, skipped: s.skipped, outliers: s.outliers }; });
  log('surface:', JSON.stringify(r), JSON.stringify(surf));
  // 3: the corner: jog above it first (work coordinates)
  await p.evaluate(() => window.__swarfMachine.request('$J=G90 X1.5 Y-1.5 Z12 F3000'));
  await p.waitForTimeout(1500);
  await p.waitForFunction(() => window.__swarfMachine.status?.state === 'Idle', null, { polling: 200 });
  r = await run('Find the front-left corner');
  const corner = await p.evaluate(() => window.__swarfProbe.corner);
  log('corner:', JSON.stringify(r), JSON.stringify(corner), 'wco-origin', JSON.stringify(await truth()));
  const exp = await p.evaluate(() => { const e = window.__swarfSimWorld.stockError; return { x: e.dx, y: e.dy, angle: e.angle, zAt66: +(e.dz + e.tiltX * (e.dx + 6) + e.tiltY * (e.dy + 6)).toFixed(4) }; });
  log('expected corner', JSON.stringify(exp));
  await p.screenshot({ path: (process.argv[2] ?? require('os').tmpdir()) + '/probe.png', timeout: 120000 });
  await b.close();
})().catch((e) => { log('FAILED', e.message); process.exit(1); });
