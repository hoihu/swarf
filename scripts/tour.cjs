// A walk through the app for looking at its layout: both modes at desktop size, the machine mode connected, and a phone.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/tour.cjs [outdir] [all]      ('all': every section open; needs Playwright)
const { chromium } = require('playwright');
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 200)));
  await p.goto('http://localhost:4173/');
  await p.evaluate((all) => { localStorage.clear(); if (all) localStorage.setItem('swarf.sections', 'all'); }, process.argv[3] === 'all'); await p.reload();
  await p.getByRole('button', { name: 'File' }).click();
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/tour-menu.png`, clip: { x: 0, y: 0, width: 720, height: 420 }, timeout: 120000 });
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  await p.waitForTimeout(1500);
  const whole = async (name) => { await p.waitForTimeout(1200); await p.screenshot({ path: `${OUT}/tour-${name}.png`, timeout: 120000 }); };
  await whole('job');
  await p.getByRole('tab', { name: 'Setup' }).click();
  await whole('job-setup');
  await p.getByRole('button', { name: /^Machine/ }).click();
  await whole('machine-off');
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  await whole('machine-on');
  console.log('overflowing horizontally at 1440:', await p.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  for (const [w, h, n] of [[1100, 800, 'narrow'], [390, 800, 'phone']]) {
    await p.setViewportSize({ width: w, height: h });
    await whole(`machine-${n}`);
    console.log(`overflowing horizontally at ${w}:`, await p.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  }
  await p.getByRole('button', { name: 'Machine', exact: true }).last().click();
  await whole('phone-left');
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
