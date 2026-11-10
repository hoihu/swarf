// The jog panel in a real browser on the simulated mill: a step, hold-to-move with the mouse and
// with a key, letting go, set zero, the spindle; and that it is shut while a program runs.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-jog.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const OUT = process.argv[2];
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 1100 } });
  p.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 300)));
  const dialogs = [];
  p.on('dialog', (d) => { dialogs.push(d.message().split('\n')[0]); void d.accept(); });
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.getByRole('tab', { name: 'Stock' }).click();
  await p.getByRole('button', { name: 'Mill example' }).click();
  await p.getByRole('tab', { name: 'Machine' }).click();
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  const W = () => p.evaluate(() => ({ w: window.__swarfMachine.status.wpos.map((v) => +v.toFixed(3)), st: window.__swarfMachine.status.state, s: window.__swarfMachine.status.spindle }));
  const jog = p.locator('section.jogpanel');
  log('start', JSON.stringify(await W()));
  // a 1 mm step in X+
  await jog.getByRole('button', { name: 'Jog X plus' }).click();
  await p.waitForTimeout(500);
  log('after X+ 1 mm', JSON.stringify(await W()));
  // 10 mm step up
  await jog.getByRole('radio', { name: '10', exact: true }).click();
  await jog.getByRole('button', { name: 'Jog Z plus' }).click();
  await p.waitForTimeout(900);
  log('after Z+ 10 mm', JSON.stringify(await W()));
  // hold Y+ with the mouse for a second at 800 mm/min (13.3 mm/s)
  await jog.getByRole('radio', { name: 'Hold' }).click();
  const y = await jog.getByRole('button', { name: 'Jog Y plus' }).boundingBox();
  await p.mouse.move(y.x + y.width / 2, y.y + y.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(1000);
  const mid = await W();
  await p.mouse.up();
  await p.waitForTimeout(150);
  const rel = await W();
  await p.waitForTimeout(500);
  log('held Y+ 1 s:', JSON.stringify(mid), 'on release', JSON.stringify(rel), 'half a second later', JSON.stringify(await W()));
  // hold, and drag the pointer off the button: lets go
  await p.mouse.down();
  await p.waitForTimeout(300);
  await p.mouse.move(y.x + 300, y.y + 300);
  await p.waitForTimeout(200);
  const off = await W();
  await p.waitForTimeout(400);
  log('pointer left the button:', JSON.stringify(off), 'later', JSON.stringify(await W()));
  await p.mouse.up();
  // keyboard: hold the left arrow
  await jog.getByRole('checkbox').check();
  await p.locator('h4', { hasText: 'Move by hand' }).click();
  await p.keyboard.down('ArrowLeft');
  await p.waitForTimeout(600);
  await p.keyboard.up('ArrowLeft');
  await p.waitForTimeout(200);
  const k = await W();
  await p.waitForTimeout(400);
  log('left arrow held 0.6 s:', JSON.stringify(k), 'later', JSON.stringify(await W()));
  // typing in a field does not jog
  await p.locator('.mdi input').click();
  await p.keyboard.press('ArrowLeft');
  await p.waitForTimeout(300);
  log('arrow while typing:', JSON.stringify(await W()));
  // set X zero here
  await jog.locator('.zero button').first().click();
  await p.waitForTimeout(600);
  log('X set to 0:', JSON.stringify(await W()), JSON.stringify(dialogs));
  // spindle on, off
  await jog.locator('.spin').getByRole('button', { name: 'On' }).click();
  await p.waitForTimeout(500);
  log('spindle on:', JSON.stringify(await W()), JSON.stringify(dialogs.slice(-1)));
  if (OUT) await jog.screenshot({ path: OUT + '/jog.png' });
  await jog.locator('.spin').getByRole('button', { name: 'Off' }).click();
  await p.waitForTimeout(500);
  log('spindle off:', JSON.stringify(await W()));
  // while a program runs: shut
  await p.evaluate(() => window.__swarfMachine.request('$J=G90 X40 Y25 Z30 F3000'));
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Run program' }).click();
  await p.waitForTimeout(1500);
  log('program running: jog buttons disabled', await jog.getByRole('button', { name: 'Jog X plus' }).isDisabled(), '| says', await jog.locator('p.muted').last().innerText());
  await p.getByRole('button', { name: 'Stop', exact: true }).click();
  await p.waitForTimeout(800);
  log('after Stop', JSON.stringify(await W()), 'jog enabled', await jog.getByRole('button', { name: 'Jog X plus' }).isEnabled());
  await b.close();
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
