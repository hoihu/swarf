// What probing measures, applied: on the simulated mill, whose block sits turned and tilted, find the
// corner, touch the top, keep both, engrave following the top, and compare the G-code with the truth.
//   npm run build && (cd apps/web && npx vite preview --port 4173) &
//   node scripts/check-measured.cjs [outdir]      (needs Playwright)
const { chromium } = require('playwright');
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1), ...a);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 300)));
  await p.goto('http://localhost:4173/');
  await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.getByRole('tab', { name: 'Stock' }).click();
  await p.getByRole('button', { name: 'Empty mill job' }).click();
  await p.evaluate(() => { const s = window.__swarfStore; const j = JSON.parse(JSON.stringify(s.job)); s.set(window.__swarfJob.parse({ ...j, stock: { ...j.stock, top: 0 }, operations: [{ type: 'mill_engrave', tool: 4, text: 'SWARF 2026', x: 8, y: 20, height: 8, depth: 0.2, follow: true }] })); });
  log('before anything is measured:', JSON.stringify(await p.evaluate(() => window.__swarfStore.analysis.diagnostics.map((d) => d.code))));
  await p.getByRole('tab', { name: 'Machine' }).click();
  await p.getByRole('button', { name: /Connect a simulated/ }).click();
  await p.waitForFunction(() => window.__swarfMachine?.status?.wpos, null, { polling: 200, timeout: 20000 });
  // a block that sits more askew and more tilted than the simulator's usual one
  await p.evaluate(() => Object.assign(window.__swarfSimWorld.stockError, { angle: 0.8, tiltX: 0.004, tiltY: -0.003 }));
  const run = async (button, timeout = 400000) => {
    await p.getByRole('button', { name: button, exact: true }).click();
    await p.waitForFunction(() => !window.__swarfProbe.busy, null, { polling: 200, timeout });
    return p.evaluate(() => ({ result: window.__swarfProbe.result, error: window.__swarfProbe.error }));
  };
  const idle = () => p.waitForFunction(() => window.__swarfMachine.status?.state === 'Idle', null, { polling: 200 });
  let r = await run('Touch the plate, set Z');
  log('Z:', r.result || r.error);
  await p.evaluate(() => window.__swarfMachine.request('$J=G90 X1.5 Y-1.5 Z12 F3000'));
  await p.waitForTimeout(1500); await idle();
  r = await run('Find the front-left corner');
  log('corner:', r.result || r.error);
  await p.getByRole('button', { name: /Turn the toolpath with the block/ }).click();
  log('kept angle:', await p.evaluate(() => window.__swarfStore.job.measured.angle), 'true:', await p.evaluate(() => window.__swarfSimWorld.stockError.angle));
  await p.evaluate(() => window.__swarfMachine.request('$J=G90 X40 Y25 Z8 F3000'));
  await p.waitForTimeout(1500); await idle();
  r = await run('finer (6 × 4)');
  log('top:', r.result || r.error);
  await p.getByRole('button', { name: /Keep this top/ }).click();
  const st = await p.evaluate(() => ({ m: window.__swarfStore.job.measured.top.length, codes: window.__swarfStore.analysis.diagnostics.map((d) => d.code), head: window.__swarfStore.gcode.text.split('\n').filter((l) => l.includes('measured')) }));
  log('kept points:', st.m, 'checks:', JSON.stringify(st.codes), 'G-code says:', JSON.stringify(st.head));
  // the G-code against the truth: every cutting position, in the simulated world's frame
  const res = await p.evaluate(() => {
    const w = window.__swarfSimWorld, m = window.__swarfMachine.status, job = window.__swarfStore.job;
    const wco = m.mpos.map((v, i) => v - m.wpos[i]);
    const at = { X: 0, Y: 0, Z: 0 }; let g = ''; const depth = []; let off = 0; let n = 0;
    for (const line of window.__swarfStore.gcode.text.split('\n')) {
      if (!/^(G[0-3] |[XYZ])/.test(line)) continue;
      const mm = /^G([0-3])\b/.exec(line); if (mm) g = mm[1];
      for (const [, a, v] of line.matchAll(/([XYZ])(-?[\d.]+)/g)) at[a] = Number(v);
      if (g !== '1') continue;
      const x = at.X + wco[0] - w.origin[0], y = at.Y + wco[1] - w.origin[1], z = at.Z + wco[2] - w.origin[2];
      const d = w.topAt(job, x, y) - z;
      if (d > 0.1) { depth.push(d); n++; if (!w.onBlock(job, x, y)) off++; }
    }
    return { n, off, min: Math.min(...depth), max: Math.max(...depth) };
  });
  log(`engraving: ${res.n} cutting positions, depth under the real top ${res.min.toFixed(3)} to ${res.max.toFixed(3)} mm (asked: 0.200); off the block: ${res.off}`);
  // the same without following: how far off a flat engraving would be on this top
  const flat = await p.evaluate(() => {
    const s = window.__swarfStore; const j = JSON.parse(JSON.stringify(s.job));
    const w = window.__swarfSimWorld, m = window.__swarfMachine.status;
    const wco = m.mpos.map((v, i) => v - m.wpos[i]);
    const job = window.__swarfJob.parse({ ...j, operations: j.operations.map((o) => ({ ...o, follow: false })) });
    s.set(job);
    const at = { X: 0, Y: 0, Z: 0 }; let g = ''; const depth = [];
    for (const line of s.gcode.text.split('\n')) {
      if (!/^(G[0-3] |[XYZ])/.test(line)) continue;
      const mm = /^G([0-3])\b/.exec(line); if (mm) g = mm[1];
      for (const [, a, v] of line.matchAll(/([XYZ])(-?[\d.]+)/g)) at[a] = Number(v);
      if (g !== '1' || at.Z > -0.1) continue;
      depth.push(w.topAt(job, at.X + wco[0] - w.origin[0], at.Y + wco[1] - w.origin[1]) - (at.Z + wco[2] - w.origin[2]));
    }
    s.undo();
    return { min: Math.min(...depth), max: Math.max(...depth) };
  });
  log(`not following, it would be ${flat.min.toFixed(3)} to ${flat.max.toFixed(3)} mm deep`);
  const out = process.argv[2] ?? require('os').tmpdir();
  await p.screenshot({ path: out + '/measured-panel.png', clip: { x: 0, y: 0, width: 345, height: 950 }, timeout: 120000 });
  await p.getByRole('tab', { name: 'G-code' }).click();
  await p.screenshot({ path: out + '/measured-gcode.png', clip: { x: 0, y: 0, width: 345, height: 600 }, timeout: 120000 });
  await p.getByRole('button', { name: /Forget/ }).click();
  log('forgotten:', await p.evaluate(() => window.__swarfStore.job.measured === undefined));
  await b.close();
})().catch((e) => { log('FAILED', e.message); process.exit(1); });
