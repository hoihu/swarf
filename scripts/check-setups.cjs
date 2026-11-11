// A part in two setups, in a real browser: add a setup with the block turned, plan a side hole in it,
// switch back and forth, print both pages, run the second on the simulated mill.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-setups.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 300)));
  p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  const J = () => p.evaluate(() => { const j = window.__swarfStore.job; return { stock: j.stock, ops: j.operations.length, setups: j.setups && { at: j.setups.at, name: j.setups.name, turn: j.setups.turn, others: j.setups.others.map((o) => `${o.name}:${o.operations.length}`) } }; });
  await p.getByRole('button', { name: '+ Setup' }).click();
  await p.locator('.setups select').selectOption('front-up');
  log('the form says:', (await p.locator('.setups .box').innerText()).replace(/\n+/g, ' | ').slice(0, 420));
  await p.locator('.setups .box input').fill('Side hole');
  await p.getByRole('button', { name: 'Add the setup' }).click();
  log('after adding:', JSON.stringify(await J()));
  await p.evaluate(() => { const s = window.__swarfStore; const j = JSON.parse(JSON.stringify(s.job)); s.set(window.__swarfJob.parse({ ...j, operations: [{ type: 'mill_drill', tool: 3, points: [{ x: 40, y: 7.25 }], zBottom: -12, zTop: 0, peck: 3 }], notes: 'On edge against the fixed jaw, stop on the left' })); });
  await p.waitForTimeout(600);
  log('header:', (await p.locator('header .facts').innerText()).replace(/\n+/g, ' | '));
  // where the first setup's point X10 Y5 on the top lies now
  await p.locator('.turned summary').click();
  const inputs = p.locator('.turned .pt input');
  await inputs.nth(0).fill('10'); await inputs.nth(1).fill('5'); await inputs.nth(2).fill('0');
  log('a point of setup 1 (X10 Y5 Z0):', (await p.locator('.turned .is').innerText()).replace(/\s+/g, ' '));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/setups-job.png`, timeout: 120000 });
  // back to the first and again to the second
  await p.getByRole('tab', { name: /Setup 1/ }).click();
  log('setup 1 in hand:', JSON.stringify(await J()));
  await p.getByRole('tab', { name: /Side hole/ }).click();
  log('setup 2 in hand:', JSON.stringify(await J()));
  log('G-code head:', await p.evaluate(() => window.__swarfStore.gcode.text.split('\n').slice(0, 3).join(' / ')));
  // the sheet: a page each
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: /Setup sheet/ }).click();
  await p.waitForTimeout(600);
  log('sheet pages:', await p.locator('.sheet').count(), '|', (await p.locator('.sheet h1').allInnerTexts()).join(' || '), '| turn note:', (await p.locator('.sheet .turn').innerText()).slice(0, 120));
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: `${OUT}/setups-sheet.pdf`, format: 'A4', preferCSSPageSize: true });
  await p.emulateMedia({ media: 'screen' });
  await p.keyboard.press('Escape');
  // run the second setup on the simulated mill
  await p.evaluate(() => { window.__swarfSimWorld.speed = 40; });
  await p.getByRole('button', { name: /^Machine/ }).click();
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  log('at the machine:', (await p.locator('.which').innerText()).replace(/\n+/g, ' | ').slice(0, 260));
  await p.getByRole('button', { name: 'Run program' }).click();
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(1000);
    const m = await p.evaluate(() => ({ job: window.__swarfMachine.job, crash: window.__swarfMachine.crash }));
    if (m.job === 'waiting') await p.getByRole('button', { name: /Resume/ }).first().click().catch(() => {});
    if (m.job === 'done' || m.job === 'failed' || m.job === 'stopped') { log('run:', JSON.stringify(m)); break; }
  }
  await b.close();
})().catch((e) => { log('FAILED', e.message); process.exit(1); });
