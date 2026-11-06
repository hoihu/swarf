// The line laser in a real browser against the simulated mill and camera (true camera calibration
// seeded): Z on the plate, laser calibration, a scan with the two clamps; prints found vs truth.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-laser.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
const OUT = process.argv[2] ?? require('os').tmpdir();
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
  await p.locator('section.camera').getByRole('button', { name: 'Start', exact: true }).click();
  await p.waitForFunction(() => window.__swarfCamera?.running && window.__swarfSimCamera?.frameNo > 10, null, { polling: 300, timeout: 60000 });
  await p.evaluate(() => {
    const c = window.__swarfCamera, s = window.__swarfSimCamera;
    c.calib = { lens: { ...s.lens, rms: 0, views: 0 }, pose: { R: s.pose.R, t: s.pose.t, frame: 'machine', kind: 'mill', rms: 0, points: 0, method: 'machine' } };
  });
  // Z on the plate
  await p.getByRole('button', { name: 'Touch the plate, set Z' }).click();
  await p.waitForFunction(() => !window.__swarfProbe.busy && (window.__swarfProbe.result || window.__swarfProbe.error), null, { polling: 200, timeout: 120000 });
  log('plate', await p.evaluate(() => window.__swarfProbe.result || window.__swarfProbe.error));
  // laser calibration
  await p.getByRole('button', { name: /Calibrate the laser/ }).click();
  await p.waitForFunction(() => !window.__swarfLaser.busy, null, { polling: 300, timeout: 300000 });
  const cal = await p.evaluate(() => {
    const L = window.__swarfCamera.calib.laser, T = window.__swarfSimCamera.laser;
    const k = T.normal[0] * T.at[0] + T.normal[1] * T.at[1] + T.normal[2] * T.at[2];
    return { err: window.__swarfLaser.error, got: L && { n: L.n.map((v) => +v.toFixed(4)), k: +L.k.toFixed(3), rms: +L.rms.toFixed(4), points: L.points }, truth: { n: T.normal.map((v) => +v.toFixed(4)), k: +k.toFixed(3) } };
  });
  log('laser calibration', JSON.stringify(cal));
  // up above the clamps, scan
  await p.evaluate(() => window.__swarfMachine.request('$J=G90 X40 Y25 Z30 F3000'));
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: 'Scan the setup' }).click();
  await p.waitForFunction(() => !window.__swarfLaser.busy, null, { polling: 500, timeout: 900000 });
  const res = await p.evaluate(() => {
    const L = window.__swarfLaser, w = window.__swarfSimWorld, m = window.__swarfMachine.status;
    const wco = m.mpos.map((v, i) => v - m.wpos[i]);
    const shift = wco.map((v, i) => v - w.origin[i]); // work = origin-relative − shift
    const job = { x: 80, y: 50 };
    const clamps = [{ x: -22, y: 16, w: 18, d: 18, z1: 8.5 }, { x: 84, y: 16, w: 18, d: 18, z1: 8.5 }].map((c) => ({ x0: c.x - shift[0], y0: c.y - shift[1], x1: c.x + c.w - shift[0], y1: c.y + c.d - shift[1], top: +(c.z1 - shift[2]).toFixed(3) }));
    void job;
    return { err: L.error, points: L.cloud?.length, top: L.result?.top, obstacles: L.result?.obstacles.map((o) => ({ x0: +o.x0.toFixed(1), y0: +o.y0.toFixed(1), x1: +o.x1.toFixed(1), y1: +o.y1.toFixed(1), top: +o.top.toFixed(2) })), truthClamps: clamps, truthSlope: [w.stockError.tiltX * 100, w.stockError.tiltY * 100] };
  });
  log('scan', JSON.stringify(res));
  const bins = await p.evaluate(() => {
    const pts = window.__swarfLaser.cloud.filter((q) => q[0] > 3 && q[0] < 77 && q[1] > 3 && q[1] < 47);
    const w = window.__swarfSimWorld, m = window.__swarfMachine.status;
    const wco = m.mpos.map((v, i) => v - m.wpos[i]);
    const sh = wco.map((v, i) => v - w.origin[i]);
    // truth: top at origin-relative (x, y) = 0.5 + dz + tilt; work z = that − shift z
    const truthZ = (x, y) => 0.5 + w.stockError.dz + w.stockError.tiltX * (x + sh[0]) + w.stockError.tiltY * (y + sh[1]) - sh[2];
    const by = {}, bx = {};
    for (const q of pts) {
      const e = q[2] - truthZ(q[0], q[1]);
      const ky = Math.floor(q[1] / 5) * 5, kx = Math.floor(q[0] / 10) * 10;
      (by[ky] ??= []).push(e); (bx[kx] ??= []).push(e);
    }
    const st = (a) => { a.sort((u, v) => u - v); return [+(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3), +a[Math.floor(a.length * 0.05)].toFixed(3), +a[Math.floor(a.length * 0.95)].toFixed(3), a.length]; };
    return { byY: Object.fromEntries(Object.entries(by).map(([k, a]) => [k, st(a)])), byX: Object.fromEntries(Object.entries(bx).map(([k, a]) => [k, st(a)])) };
  });
  log('error bins (mean, 5%, 95%, n)', JSON.stringify(bins));
  const cl = await p.evaluate(() => {
    const pts = window.__swarfLaser.cloud;
    const hist = (f) => { const h = {}; for (const q of pts) if (f(q)) { const k = Math.round(q[2]); h[k] = (h[k] ?? 0) + 1; } return h; };
    return { left: hist((q) => q[0] > -20 && q[0] < -6 && q[1] > 18 && q[1] < 32), right: hist((q) => q[0] > 86 && q[0] < 100 && q[1] > 18 && q[1] < 32) };
  });
  log('clamp heights (rounded z: count)', JSON.stringify(cl));
  await p.getByRole('button', { name: 'Add to the job' }).click();
  await p.waitForTimeout(500);
  log('checks', JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.diag')].map((d) => d.textContent.slice(0, 160)).slice(0, 4))));
  await p.locator('section.camera').getByRole('button', { name: '3D' }).click();
  await p.waitForTimeout(800);
  await p.screenshot({ path: OUT + '/laser-3d.png', timeout: 120000 });
  await p.locator('section.camera').getByRole('button', { name: 'Toolpath on camera' }).click();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: OUT + '/laser-overlay.png', timeout: 120000 });
  log('shots');
  await b.close();
})().catch((e) => { log('FAILED', e.message); process.exit(1); });
