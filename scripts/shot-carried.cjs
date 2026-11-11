// Pictures of a part carried over a turn: the example plate (pocket, four holes), then the same
// block with its left face up (the pocket is a hollow in the right wall) and flipped over.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/shot-carried.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  const box = await p.locator('.viewer').boundingBox();
  const shot = async (name) => { await p.waitForTimeout(2500); await p.screenshot({ path: `${OUT}/carried-${name}.png`, clip: box, timeout: 120000 }); };
  await shot('1');
  for (const [turn, name, drag] of [['left-up', 'left-up', [260, -40]], ['over-y', 'flipped', [0, 0]]]) {
    await p.getByRole('tab', { name: /Setup 1/ }).click().catch(() => {});
    await p.getByRole('button', { name: '+ Setup' }).click();
    await p.locator('.setups select').selectOption(turn);
    const t0 = Date.now();
    await p.getByRole('button', { name: 'Add the setup' }).click();
    await p.waitForTimeout(800);
    const info = await p.evaluate(() => { const s = window.__swarfStore; const m = s.analysis.material; return { stock: s.job.stock, from: s.job.setups.from, spans: !!m.spans, lowest: Math.min(...m.h), checks: s.analysis.diagnostics.map((d) => d.code) }; });
    console.log(turn, JSON.stringify(info), `${Date.now() - t0} ms`);
    await p.locator('.viewer').getByRole('button', { name: '3D', exact: true }).click();
    if (drag[0]) { await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.mouse.move(box.x + box.width / 2 - drag[0], box.y + box.height / 2 + drag[1], { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(4000); }
    await shot(name);
  }
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
