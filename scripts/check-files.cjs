// Job files, the tool library and the setup sheet in a real browser.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-files.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  const job = () => p.evaluate(() => JSON.parse(JSON.stringify(window.__swarfStore.job)));
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  await p.getByRole('tab', { name: 'Setup' }).click();
  await p.getByLabel('Setup notes').fill('Vise on 10 mm parallels, stop on the left');
  await p.getByLabel('Setup notes').blur();
  await p.evaluate(() => { const s = window.__swarfStore; s.set(window.__swarfJob.parse({ ...JSON.parse(JSON.stringify(s.job)), obstacles: [{ name: 'fixed jaw', x0: -5, y0: 50, x1: 85, y1: 70, top: 8 }, { name: 'moving jaw', x0: -5, y0: -20, x1: 85, y1: 0, top: 8 }] })); });

  // save the job, start another, open the file again
  await p.getByRole('button', { name: 'File' }).click();
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('menuitem', { name: /Save the job/ }).click()]);
  const path = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  const before = await job();
  console.log('saved as', dl.suggestedFilename(), fs.statSync(path).size, 'bytes; says:', await p.locator('.said').innerText());
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Lathe example' }).click();
  console.log('now a', (await job()).machine.kind, 'job');
  await p.locator('header input[type=file]').setInputFiles(path);
  await p.waitForTimeout(300);
  console.log('opened again, the same job:', JSON.stringify(await job()) === JSON.stringify(before), '| says:', await p.locator('.said').innerText());
  // a file that is not a job
  fs.writeFileSync(`${OUT}/not-a-job.json`, '{"hello": 1}');
  await p.locator('header input[type=file]').setInputFiles(`${OUT}/not-a-job.json`);
  await p.waitForTimeout(300);
  console.log('a wrong file:', await p.locator('.said').innerText(), '| job untouched:', JSON.stringify(await job()) === JSON.stringify(before));
  await p.locator('.said button').click();

  // the library: keep a tool, find it in an empty job
  await p.getByRole('tab', { name: 'Tools' }).click();
  await p.locator('.ops .op').first().click();
  await p.getByRole('button', { name: 'Keep in the library' }).click();
  console.log('kept:', await p.locator('.lib li').allInnerTexts());
  await p.evaluate(() => { const s = window.__swarfStore; const j = JSON.parse(JSON.stringify(s.job)); s.set({ ...j, operations: [], tools: j.tools.slice(1) }); });
  await p.waitForTimeout(200);
  await p.locator('.lib').getByRole('button', { name: /^Add / }).click();
  await p.waitForTimeout(200);
  console.log('tools in the job after adding from the library:', (await job()).tools.map((t) => `T${t.id} ${t.name}`).join(', '));
  await p.screenshot({ path: `${OUT}/files-tools.png`, clip: { x: 0, y: 0, width: 345, height: 900 } });
  const [dl2] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Save the library as a file' }).click()]);
  await dl2.saveAs(`${OUT}/${dl2.suggestedFilename()}`);
  await p.getByRole('button', { name: /Remove .* from the library/ }).click();
  await p.locator('.lib + .row input[type=file]').setInputFiles(`${OUT}/${dl2.suggestedFilename()}`);
  await p.waitForTimeout(300);
  console.log('library after dropping the tool and reading the file:', await p.evaluate(() => window.__swarfFiles.library.length), 'tool; kept over a reload:', await p.evaluate(() => JSON.parse(localStorage.getItem('swarf.library')).length));

  // the setup sheet
  await p.locator('header input[type=file]').setInputFiles(path);
  await p.getByRole('tab', { name: 'G-code' }).click();
  await p.getByRole('button', { name: 'Setup sheet' }).click();
  await p.waitForTimeout(500);
  const sheet = p.locator('.sheet');
  console.log('sheet text:\n' + (await sheet.innerText()).split('\n').filter(Boolean).slice(0, 60).join('\n'));
  await sheet.screenshot({ path: `${OUT}/sheet-mill.png` });
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: `${OUT}/sheet-mill.pdf`, format: 'A4', preferCSSPageSize: true });
  await p.emulateMedia({ media: 'screen' });
  await p.keyboard.press('Escape');
  console.log('closed by Escape:', (await p.locator('.sheet').count()) === 0);
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Lathe example' }).click();
  await p.getByRole('tab', { name: 'G-code' }).click();
  await p.getByRole('button', { name: 'Setup sheet' }).click();
  await p.waitForTimeout(500);
  await p.locator('.sheet').screenshot({ path: `${OUT}/sheet-lathe.png` });
  await p.getByRole('button', { name: 'Close' }).click();
  // on a phone
  await p.setViewportSize({ width: 390, height: 800 });
  await p.getByRole('button', { name: 'Job', exact: true }).click();
  await p.getByRole('button', { name: 'Setup sheet' }).click();
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/sheet-phone.png` });
  console.log('phone: page wider than the screen?', await p.evaluate(() => document.querySelector('.sheet-overlay').scrollWidth > innerWidth));
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
