// Pictures of the preview's looks: surroundings, chips, coolant, a picture of one's own (to look at by eye).
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/shot-look.cjs <outdir> [picture.jpg]      (needs Playwright)
const { chromium } = require('playwright');
const OUT = process.argv[2] ?? require('os').tmpdir();
const PIC = process.argv[3];
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 300)));
  p.on('console', (m) => m.type() === 'error' && !/TUNNEL|net::/.test(m.text()) && console.log('console:', m.text().slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  const view = p.locator('.viewer');
  const shot = async (name) => { const box = await view.boundingBox(); await p.screenshot({ path: `${OUT}/look-${name}.png`, clip: box, animations: 'disabled', timeout: 120000 }); console.log('shot', name); };
  const look = async (name, opts = {}) => {
    if (!(await p.locator('.look').count())) await view.getByRole('button', { name: 'Look' }).click();
    if (name) await p.locator('.look .chips').getByRole('button', { name, exact: true }).click();
    for (const [label, on] of Object.entries(opts)) await p.locator('.look label', { hasText: label }).locator('input').setChecked(on);
    await view.getByRole('button', { name: 'Look' }).click();
  };
  // play to a point in the program and let it run on a little, so chips are in the air
  const playAt = async (frac, ms = 700) => {
    await p.locator('.scrub input').evaluate((el, f) => { el.value = String(Math.round(Number(el.max) * f)); el.dispatchEvent(new Event('input', { bubbles: true })); }, frac);
    await p.waitForTimeout(300);
    await p.locator('.scrub .play').click();
    await p.waitForTimeout(ms);
  };
  const pause = async () => { if (await p.locator('.scrub .play[aria-label="Pause"]').count()) await p.locator('.scrub .play').click(); };
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  await p.waitForTimeout(800);
  await look('Workshop', { Shadows: true, Chips: true });
  await playAt(0.42, 2500); await shot('workshop-mill'); await pause();
  await look('Workshop', { Coolant: true });
  await playAt(0.3, 2500); await shot('workshop-mill-coolant'); await pause();
  await look('Studio', { Coolant: false });
  await playAt(0.5, 2500); await shot('studio-mill'); await pause();
  await look('Night shift');
  await playAt(0.2, 2500); await shot('night-mill'); await pause();
  await look('Plain');
  await playAt(0.6, 2500); await shot('plain-mill'); await pause();
  if (PIC) {
    // dropped onto the preview, as one would
    const b64 = require('fs').readFileSync(PIC).toString('base64');
    const dt = await p.evaluateHandle((b) => { const d = new DataTransfer(); const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0)); d.items.add(new File([bytes], 'workshop.jpg', { type: 'image/jpeg' })); return d; }, b64);
    await view.dispatchEvent('dragover', { dataTransfer: dt });
    await p.waitForTimeout(300);
    await shot('drop-hint');
    await view.dispatchEvent('drop', { dataTransfer: dt });
    await p.waitForTimeout(2500);
    console.log('picture in use:', await p.evaluate(() => JSON.parse(localStorage.getItem('swarf.look')).surround));
    await playAt(0.45, 2500); await shot('picture-mill'); await pause();
    // it is still there after a reload
    await p.reload();
    await p.waitForTimeout(2500);
    await shot('picture-after-reload');
  }
  await look('Workshop', { Coolant: true });
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Lathe example' }).click();
  await p.waitForTimeout(800);
  await playAt(0.25, 2500); await shot('workshop-lathe'); await pause();
  await view.getByRole('button', { name: 'Look' }).click();
  await p.waitForTimeout(200);
  await shot('menu');
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
