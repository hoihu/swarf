// The preview's viewpoints in a real browser: the presets, turning the view by hand, and that it is kept over a reload.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-view.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  await p.waitForTimeout(1500);
  const view = p.locator('.viewer');
  const box = await view.boundingBox();
  const shot = async (name) => { await p.waitForTimeout(1200); const buf = await p.screenshot({ path: `${OUT}/view-${name}.png`, clip: box }); return buf; };
  const saved = () => p.evaluate(() => localStorage.getItem('swarf.view'));
  for (const v of ['Top', 'Front', 'Side', '3D']) {
    await view.getByRole('button', { name: v, exact: true }).click();
    await shot(v.toLowerCase());
    console.log(v, 'kept:', await saved());
  }
  // turn it by hand: drag across the preview
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 - 60, { steps: 8 });
  await p.mouse.up();
  // (it glides on after the hand lets go; drawn in software that takes a while)
  await p.waitForTimeout(12000);
  await shot('turned');
  console.log('turned by hand, kept:', await saved());
  await p.reload();
  await p.waitForTimeout(2500);
  await shot('after-reload');
  console.log('after a reload, kept:', await saved(), '(compare view-turned.png and view-after-reload.png)');
  await view.getByRole('button', { name: '3D', exact: true }).click();
  console.log('3D forgets it:', await saved());
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
