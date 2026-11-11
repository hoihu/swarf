// The session log in a real browser: run the example on the simulated mill, stop it part way, save the log and look at it.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-log.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  p.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 300)));
  p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  await p.getByRole('button', { name: 'File' }).click();
  await p.getByRole('menuitem', { name: 'Mill example' }).click();
  await p.evaluate(() => { window.__swarfSimWorld.speed = 20; });
  await p.getByRole('button', { name: /^Machine/ }).click();
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  await p.getByRole('button', { name: 'Run program' }).click();
  await p.waitForFunction(() => window.__swarfMachine.job === 'waiting', null, { polling: 200, timeout: 30000 });
  await p.getByRole('button', { name: 'Resume' }).click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Stop', exact: true }).click();
  await p.waitForFunction(() => window.__swarfMachine.status?.state === 'Idle' && window.__swarfMachine.job !== 'running', null, { polling: 200, timeout: 30000 });
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Save a log' }).click()]);
  const path = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n');
  console.log(dl.suggestedFilename(), Math.round(text.length / 1024), 'kB,', lines.length, 'lines');
  console.log(lines.slice(0, 8).join('\n'));
  const show = (re, n = 3) => console.log(lines.filter((l) => re.test(l)).slice(0, n).join('\n'));
  show(/# /, 12);
  show(/> \[/, 4);
  show(/< \$\d+=|< \[G54|< \[GC:/, 5);
  console.log('status reports kept:', lines.filter((l) => /< </.test(l)).length, '| G-code lines sent:', lines.filter((l) => /> [GMST]/.test(l)).length, '| job at the end reads back:', (() => { try { return JSON.parse(lines.filter(Boolean).at(-1)).job.name; } catch (e) { return 'NO: ' + e.message; } })());
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
