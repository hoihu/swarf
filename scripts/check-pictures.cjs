// Attaching a picture to a chat message, in a real browser (no model connected: the offline answer).
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-pictures.cjs <picture> [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const PIC = process.argv[2]; const OUT = process.argv[3] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.locator('.compose input[type=file]').setInputFiles(PIC);
  await p.waitForSelector('.thumb img');
  const size = await p.evaluate(() => new Promise((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight, Math.round(document.querySelector('.thumb img').src.length / 1024) + ' kB as text']); i.src = document.querySelector('.thumb img').src; }));
  console.log('attached, sent at', JSON.stringify(size));
  console.log('Send enabled with a picture and no words:', await p.getByRole('button', { name: 'Send' }).isEnabled());
  await p.getByLabel('Message').fill('Make this part');
  await p.getByRole('button', { name: 'Send' }).click();
  await p.waitForTimeout(500);
  console.log('picture shown in the message:', await p.locator('.msg.user .pics img').count(), '| answer:', (await p.locator('.msg.bot').last().innerText()).slice(0, 160));
  console.log('thumb gone after sending:', (await p.locator('.thumb').count()) === 0);
  await p.locator('.pane-chat').screenshot({ path: `${OUT}/pictures.png`, timeout: 120000 });
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
