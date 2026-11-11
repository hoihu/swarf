// A picture of the newer mill operations cut on one part (slot, spot, chamfer, engraving, a milled thread), to look at by eye.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/shot-ops.cjs <outdir>      (needs Playwright)
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
  await p.waitForTimeout(500);
  const diags = await p.evaluate(() => {
    const s = window.__swarfStore;
    const job = JSON.parse(JSON.stringify(s.job));
    job.name = 'Label plate';
    job.tools = [...job.tools.filter((t) => t.id <= 4), { id: 5, name: 'Thread mill Ø4', type: 'threadmill', diameter: 4, flutes: 3, fluteLength: 12 }];
    job.operations = [
      { type: 'mill_face', tool: 2, z: 0 },
      { type: 'mill_contour_rect', tool: 1, x: 8, y: 6, w: 64, h: 38, zBottom: -6, side: 'outside', finish: 0.2 },
      { type: 'mill_slot', tool: 1, x0: 20, y0: 14, x1: 60, y1: 14, width: 8, zBottom: -3, finish: 0.2 },
      { type: 'mill_spot', tool: 4, points: [{ x: 16, y: 36 }, { x: 64, y: 36 }], diameter: 5.6 },
      { type: 'mill_drill', tool: 3, points: [{ x: 16, y: 36 }, { x: 64, y: 36 }], zBottom: -12, peck: 3 },
      { type: 'mill_thread', tool: 5, cx: 16, cy: 36, diameter: 6, pitch: 1, zBottom: -9 },
      { type: 'mill_thread', tool: 5, cx: 64, cy: 36, diameter: 6, pitch: 1, zBottom: -9 },
      { type: 'mill_engrave', tool: 4, text: 'SWARF Nr.7', x: 23, y: 24, height: 6, depth: 0.25 },
      { type: 'mill_chamfer', tool: 4, x: 8, y: 6, w: 64, h: 38, size: 1 },
    ];
    s.set(window.__swarfJob.parse(job));
    return new Promise((r) => setTimeout(() => r(s.analysis.diagnostics.map((d) => d.severity + ' ' + d.code + ' ' + (d.opId ?? '') + ': ' + d.message.slice(0, 90))), 600));
  });
  console.log('checks:', JSON.stringify(diags, null, 1));
  console.log('ops:', JSON.stringify(await p.evaluate(() => window.__swarfStore.analysis.program.segments.map((g) => g.opId + ' ' + g.label + ' @' + g.rpm))));
  await p.locator('.viewer').getByRole('button', { name: '3D', exact: true }).click();
  await p.locator('.scrub input').evaluate((el) => { el.value = el.max; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(2500);
  const box = await p.locator('.viewer').boundingBox();
  await p.screenshot({ path: `${OUT}/ops.png`, clip: box });
  await p.locator('.viewer').getByRole('button', { name: 'Top', exact: true }).click();
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/ops-top.png`, clip: box });
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
