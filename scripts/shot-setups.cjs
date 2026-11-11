// Pictures of the simulated camera for each simulated setup, laser on (to look at by eye).
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/shot-setups.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 300)));
  p.on('console', (m) => m.type() === 'error' && console.log('console:', m.text().slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  await p.getByRole('button', { name: /^Machine/ }).click();
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  await p.locator('section.camera').getByRole('button', { name: 'Start', exact: true }).click();
  await p.waitForFunction(() => window.__swarfCamera?.running && window.__swarfSimCamera?.frameNo > 10, null, { polling: 300, timeout: 60000 });
  await p.evaluate(() => window.__swarfMachine.request('$J=G90 X40 Y25 Z30 F3000'));
  await p.evaluate(() => window.__swarfMachine.request('M8'));
  for (const setup of ['side', 'block', 'toe', 'straps', 'vise']) {
    await p.locator('.simsetup select').selectOption(setup);
    await p.waitForTimeout(1500);
    const url = await p.evaluate(() => window.__swarfSimCamera.canvas.toDataURL('image/png'));
    fs.writeFileSync(`${OUT}/setup-${setup}.png`, Buffer.from(url.split(',')[1], 'base64'));
    console.log('shot', setup);
  }
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
