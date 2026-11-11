// The camera measuring round things, in a real browser against the simulated machine and camera
// (true camera calibration seeded): the cutter in the mill's spindle after tool changes, and the
// bar in the lathe's chuck, which is not quite the job's. Prints what was seen and the truth.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-round.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
const OUT = process.argv[2] ?? require('os').tmpdir();
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('swarf.sections', 'all'); }); await p.reload();
  const start = async (kind) => {
    await p.getByRole('button', { name: 'File' }).click();
    await p.getByRole('menuitem', { name: kind === 'mill' ? 'Mill example' : 'Lathe example' }).click();
    await p.getByRole('button', { name: /^Machine/ }).click();
    if (await p.getByRole('button', { name: /Connect a simulated/ }).count()) await p.getByRole('button', { name: /Connect a simulated/ }).click();
    await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
    if (!(await p.evaluate(() => window.__swarfCamera?.running))) await p.locator('section.camera').getByRole('button', { name: 'Start', exact: true }).click();
    await p.waitForFunction(() => window.__swarfCamera?.running && window.__swarfSimCamera?.frameNo > 10, null, { polling: 300, timeout: 60000 });
    await p.waitForTimeout(1500);
    await p.evaluate((kind) => {
      const c = window.__swarfCamera, s = window.__swarfSimCamera;
      c.calib = { lens: { ...s.lens, rms: 0, views: 0 }, pose: { R: s.pose.R, t: s.pose.t, frame: 'machine', kind, rms: 0, points: 0, method: 'machine' } };
    }, kind);
  };
  const idle = () => p.waitForFunction(() => window.__swarfMachine.status?.state === 'Idle', null, { polling: 200 });

  // ---- the mill: the cutter after tool changes
  await start('mill');
  await p.evaluate(() => window.__swarfMachine.request('$J=G91 Z25 F3000'));
  await p.waitForTimeout(1500); await idle();
  const tools = await p.evaluate(() => window.__swarfStore.job.tools.filter((t) => t.diameter).map((t) => ({ id: t.id, d: t.diameter })));
  for (const [loaded, expected] of [[1, 1], [2, 2], [3, 3], [3, 1]]) {
    const truth = await p.evaluate((id) => { const w = window.__swarfSimWorld; w.toolDiameter = window.__swarfStore.job.tools.find((t) => t.id === id).diameter; return { d: w.toolDiameter, out: w.loadTool(id) }; }, loaded);
    await p.waitForTimeout(1500);
    const exp = tools.find((t) => t.id === expected);
    const r = await p.evaluate(async (d) => { try { return await window.__swarfCamera.checkTool(d); } catch (e) { return { error: e.message }; } }, exp.d);
    await p.waitForTimeout(300);
    const says = await p.locator('section.camera .result').last().innerText().catch(() => '');
    log(`T${loaded} in (Ø${truth.d}, tip ${(-truth.out).toFixed(1)}), checked as T${expected} (Ø${exp.d}):`, r.error ?? `sees Ø${r.diameter.toFixed(2)}, tip ${r.tip.toFixed(2)}, off axis ${r.offset.toFixed(2)}`);
    if (loaded !== expected || loaded === 1) log('   panel:', says.replace(/\n+/g, ' | '));
  }
  await p.locator('section.camera').screenshot({ path: `${OUT}/round-mill.png`, timeout: 120000 }).catch(() => {});

  // ---- the lathe: the bar
  await p.getByRole('button', { name: 'Disconnect' }).click().catch(() => {});
  await start('lathe');
  const r = await p.evaluate(async () => { try { return await window.__swarfCamera.checkBar(); } catch (e) { return { error: e.message }; } });
  const t = await p.evaluate(() => { const s = window.__swarfStore.job.stock, e = window.__swarfSimWorld.barError; return { d: s.diameter + e.diameter, out: s.stickout + e.stickout, front: s.front + e.front, job: s }; });
  log('bar:', r.error ?? `sees Ø${r.diameter.toFixed(2)}, ${r.stickout?.toFixed(2)} out, face at Z${r.front?.toFixed(2)}, off axis ${r.offset.toFixed(2)}`, `| truth Ø${t.d}, ${t.out} out, face at Z${t.front} | job Ø${t.job.diameter}, ${t.job.stickout}, Z${t.job.front}`);
  await p.waitForTimeout(300);
  log('   panel:', (await p.locator('section.camera .result').last().innerText().catch(() => '')).replace(/\n+/g, ' | '));
  await p.getByRole('button', { name: 'Use what the camera sees as the stock' }).click();
  log('stock now:', JSON.stringify(await p.evaluate(() => window.__swarfStore.job.stock)));
  await p.locator('section.camera').screenshot({ path: `${OUT}/round-lathe.png`, timeout: 120000 }).catch(() => {});
  await b.close();
})().catch((e) => { log('FAILED', e.message); process.exit(1); });
