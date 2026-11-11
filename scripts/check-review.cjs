// The review in a real browser, with no model connected: the "worth a look" list and the Review button.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-review.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.getByRole('tab', { name: 'Stock' }).click();
  await p.getByRole('button', { name: 'Mill example' }).click();
  await p.evaluate(() => { const s = window.__swarfStore; const j = JSON.parse(JSON.stringify(s.job)); s.set(window.__swarfJob.parse({ ...j, operations: [...j.operations].reverse() })); });
  await p.getByRole('tab', { name: 'Operations' }).click();
  await p.getByText(/Worth a look/).click();
  console.log('list:', await p.locator('.look li').allInnerTexts());
  await p.locator('.look li button').first().click();
  console.log('clicking the operation selects it:', await p.evaluate(() => window.__swarfStore.selected));
  await p.getByRole('button', { name: 'Review', exact: true }).click();
  await p.waitForTimeout(500);
  console.log('review, offline:', (await p.locator('.pane-chat .log').innerText()).slice(-700));
  await p.screenshot({ path: `${OUT}/review.png` , timeout: 120000});
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
