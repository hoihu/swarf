// The camera calibration end to end in a real browser, against the simulated mill or lathe and the
// simulated camera (known lens and pose): lens from the board, pose from the machine moving the tool
// marker, tool-tip clicks placed on the true pixel, then the overlay compared with the truth.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-camera.cjs [outdir] [full|skiplens] [mill|lathe]     (needs Playwright)
const { chromium } = require('playwright');
const S = process.argv[2] ?? require('os').tmpdir();
const KIND = process.argv[4] ?? 'mill';
const T0 = Date.now(); const ts = () => ((Date.now() - T0) / 1000).toFixed(0) + 's';
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 300)); });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate((skip) => { localStorage.clear(); if (skip) localStorage.setItem('swarf.camera', JSON.stringify({ 'sim@1280x720': { lens: { width: 1280, height: 720, fx: 1061.6, fy: 1059.5, cx: 651.04, cy: 347.87, dist: [-0.1613, 0.0942, 0.00055, -0.00047, 0], rms: 0.074, views: 19 } } })); }, process.argv[3] === 'skiplens');
  await p.reload();
  await p.waitForTimeout(800);
  // mill example, machine tab, simulated mill
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: KIND === 'lathe' ? 'Lathe example' : 'Mill example' }).click();
  await p.getByRole('button', { name: /^Machine/ }).click();
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForTimeout(800);
  await p.locator('section.camera').getByRole('button', { name: 'Start', exact: true }).click();
  await p.waitForFunction(() => window.__swarfCamera?.running || window.__swarfCamera?.error, null, { timeout: 120000, polling: 300 });
  const e0 = await p.evaluate(() => window.__swarfCamera.error);
  if (e0) throw new Error('camera: ' + e0);
  console.log(ts(), 'camera running', await p.evaluate(() => [window.__swarfCamera.width, window.__swarfCamera.height]));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: S + '/cam-1-live.png', timeout: 120000 });
  // lens
  if (process.argv[3] !== 'skiplens') {
  await p.locator('section.camera').getByRole('button', { name: 'Start', exact: true }).click();
  const t0 = Date.now();
  await p.waitForFunction(() => window.__swarfCamera.views.length >= 15, null, { timeout: 480000, polling: 500 });
  console.log(ts(), 'views after', Math.round((Date.now() - t0) / 1000), 's');
  await p.screenshot({ path: S + '/cam-2-board.png', timeout: 120000 });
  await p.locator('section.camera').getByRole('button', { name: /^Calibrate/ }).click();
  await p.waitForFunction(() => !!window.__swarfCamera.calib.lens, null, { timeout: 60000, polling: 300 });
  const lens = await p.evaluate(() => ({ got: window.__swarfCamera.calib.lens, truth: window.__swarfSimCamera.lens }));
  console.log(ts(), 'lens', JSON.stringify(lens));
  }
  // pose
  await p.locator('section.camera').getByRole('button', { name: 'Measure', exact: true }).click();
  for (let i = 0; i < 4; i++) {
    const watch = setInterval(async () => console.log(ts(), await p.evaluate(() => [window.__swarfCamera.progress, document.querySelector('section.camera .diag.error')?.textContent, window.__swarfCamera.mpos()?.map((v) => v.toFixed(1)).join(',')]).catch(() => '?')), 10000);
    await p.waitForFunction(() => window.__swarfCamera.awaitingClick || document.querySelector('section.camera .diag.error'), null, { timeout: 240000, polling: 200 });
    clearInterval(watch);
    const e1 = await p.locator('section.camera .diag.error').textContent().catch(() => null);
    if (e1) throw new Error('pose: ' + e1);
    const [cx, cy] = await p.evaluate(() => {
      const m = window.__swarfCamera.mpos();
      const [u, v] = window.__swarfSimCamera.project(m);
      return window.__swarfImageToClient(u, v);
    });
    if (i === 0) await p.screenshot({ path: S + '/cam-3-click.png', timeout: 120000 });
    console.log(ts(), 'click', i);
    await p.mouse.click(cx + (Math.random() - 0.5) * 0.6, cy + (Math.random() - 0.5) * 0.6);
    await p.waitForTimeout(300);
  }
  await p.waitForFunction(() => !!window.__swarfCamera.calib.pose || document.querySelector('section.camera .diag.error'), null, { timeout: 120000, polling: 300 });
  const err = await p.locator('section.camera .diag.error').textContent().catch(() => null);
  if (err) console.log('ERROR', err);
  const res = await p.evaluate((KIND) => {
    const c = window.__swarfCamera, sim = window.__swarfSimCamera;
    const pose = c.calib.pose;
    // compare projections of points across the work area with the truth
    const wco = c.wco();
    let worst = 0, sum = 0, n = 0;
    const pts = [];
    if (KIND === 'lathe') { for (let x = 0; x <= 20; x += 4) for (const y of [-10, 0, 10]) for (let z = -50; z <= 10; z += 10) pts.push([x, y, z]); }
    else { for (let x = -10; x <= 90; x += 20) for (let y = -10; y <= 60; y += 14) for (const z of [-15, 0, 20]) pts.push([x, y, z]); }
    for (const [x, y, z] of pts) {
      const X = [wco[0] + x, wco[1] + y, wco[2] + z];
      const a = sim.project(X);
      // the app's projection with its lens and pose
      const L = c.calib.lens; const R = pose.R, t = pose.t;
      const cc = [R[0]*X[0]+R[1]*X[1]+R[2]*X[2]+t[0], R[3]*X[0]+R[4]*X[1]+R[5]*X[2]+t[1], R[6]*X[0]+R[7]*X[1]+R[8]*X[2]+t[2]];
      const xn = cc[0]/cc[2], yn = cc[1]/cc[2]; const [k1,k2,p1,p2,k3] = L.dist; const r2 = xn*xn+yn*yn; const rad = 1+k1*r2+k2*r2*r2+k3*r2*r2*r2;
      const xd = xn*rad + 2*p1*xn*yn + p2*(r2+2*xn*xn), yd = yn*rad + p1*(r2+2*yn*yn) + 2*p2*xn*yn;
      const b = [L.fx*xd+L.cx, L.fy*yd+L.cy];
      const e = Math.hypot(a[0]-b[0], a[1]-b[1]); worst = Math.max(worst, e); sum += e; n++;
    }
    return { pose: { rms: pose.rms, tipPx: pose.tipPx, points: pose.points }, meanPx: sum / n, worstPx: worst };
  }, KIND);
  console.log(ts(), 'pose', JSON.stringify(res));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: S + '/cam-4-overlay-' + KIND + '.png', timeout: 120000 });
  await b.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
