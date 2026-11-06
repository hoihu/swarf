/**
 * The simulated setups against the code that has to cope with them: a laser scan of each, made by
 * casting rays (the laser's fan from the spindle head, its shadows, what the camera cannot see),
 * through the scan analysis; the obstacles it finds through the job's checks; the probe's world.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES, Job, analyze } from '@swarf/cam';
import { analyseScan, type Obstacle } from '../src/lib/camera/laser.ts';
import { buildSetup, type SetupName, type StockError } from '../src/lib/sim/setups.ts';
import { heightAt, raycast, touches, type Solid, type V3 } from '../src/lib/sim/solids.ts';
import { LASER, millCamera } from '../src/lib/sim/rig.ts';
import { analyseSurface } from '../src/lib/surface.ts';

const stock = { x: 80, y: 50, z: 15, top: 0.5 };
const bottom = stock.top - stock.z;
const err: StockError = { dx: 0.8, dy: -0.6, dsx: 0.4, dsy: -0.3, angle: 0.25, dz: -0.37, tiltX: 0.0004, tiltY: -0.0006 };
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/**
 * A laser scan: the tool at height `z` swept so the line crosses the block and 35 mm around it,
 * 1 mm a step; at each step the fan's rays (0.12° apart, about the camera's pixels) to the first surface, kept where the
 * camera sees that point, with a little noise along the camera's line of sight.
 */
function scan(world: { solids: Solid[]; floor: number }, z: number): V3[] {
  const cam = millCamera(stock).at;
  const n = LASER.normal;
  const pts: V3[] = [];
  for (let line = -35; line <= stock.y + 35; line += 1) {
    // the laser where its sheet meets the top at Y = line (the sheet's normal has no X)
    const P: V3 = [stock.x / 2 + LASER.at[0], line - (n[2] * (LASER.at[2] + z - stock.top)) / n[1], z + LASER.at[2]];
    for (let a = -LASER.fan; a <= LASER.fan; a += 0.12) {
      const t = (a * Math.PI) / 180;
      const d: V3 = [0, 1, 2].map((i) => Math.cos(t) * LASER.down[i]! + Math.sin(t) * LASER.across[i]!) as V3;
      const hit = raycast(world.solids, P, d, world.floor);
      if (!hit) continue;
      const X: V3 = [P[0] + hit.t * d[0], P[1] + hit.t * d[1], P[2] + hit.t * d[2]];
      const toCam: V3 = [cam[0] - X[0], cam[1] - X[1], cam[2] - X[2]];
      const L = Math.hypot(...toCam);
      const u: V3 = [toCam[0] / L, toCam[1] / L, toCam[2] / L];
      const from: V3 = [X[0] + 0.05 * u[0], X[1] + 0.05 * u[1], X[2] + 0.05 * u[2]];
      const block = raycast(world.solids, from, toCam);
      if (block && block.t < 1) continue;
      const e = 0.12 * rnd();
      pts.push([X[0] + e * u[0], X[1] + e * u[1], X[2] + e * u[2]]);
    }
  }
  return pts;
}

const covers = (o: Obstacle, x: number, y: number, grow = 0) => x >= o.x0 - grow && x <= o.x1 + grow && y >= o.y0 - grow && y <= o.y1 + grow;

/**
 * Every place where something of the setup stands up (as far as the scan saw it) is inside a found
 * obstacle at least as high, give or take; no found obstacle is higher than what is really there.
 */
function expectObstaclesMatch(world: { solids: Solid[]; floor: number }, pts: V3[], found: Obstacle[]) {
  const holders = world.solids.filter((s) => !s.stock);
  const block = world.solids.filter((s) => s.stock);
  // where the scan saw the surface (two points or more in a 1 mm cell)
  const hits = new Map<string, number>();
  for (const [x, y] of pts) hits.set(`${Math.floor(x)},${Math.floor(y)}`, (hits.get(`${Math.floor(x)},${Math.floor(y)}`) ?? 0) + 1);
  const seen = new Set([...hits].filter(([, n]) => n >= 2).map(([k]) => k));
  let checked = 0;
  for (let y = -34.5; y < stock.y + 35; y += 1)
    for (let x = -34.5; x < stock.x + 35; x += 1) {
      const h = heightAt(holders, x, y, -Infinity);
      const onBlock = heightAt(block, x, y, -Infinity);
      // what stands up: above the stock's bottom beside the block, above its top on it
      const standing = onBlock > -Infinity ? h > onBlock + 1.5 : h > bottom + 2;
      if (!standing || !seen.has(`${Math.floor(x)},${Math.floor(y)}`)) continue;
      // a point inside, not on the very edge (whose cells average two heights)
      const inner = [-1.5, 1.5].every((dx) => [-1.5, 1.5].every((dy) => Math.abs(heightAt(holders, x + dx, y + dy, -Infinity) - h) < 0.5));
      if (!inner) continue;
      checked++;
      const by = found.filter((o) => covers(o, x, y, 0.5) && o.top >= h - 0.4);
      expect(by.length, `nothing found covers ${x}, ${y} (up to Z${h.toFixed(2)})`).toBeGreaterThan(0);
    }
  expect(checked).toBeGreaterThan(50);
  for (const o of found) {
    let highest = -Infinity;
    for (let y = o.y0; y <= o.y1; y += 0.5) for (let x = o.x0; x <= o.x1; x += 0.5) highest = Math.max(highest, heightAt(holders, x, y, -Infinity));
    expect(o.top, `phantom height at X${o.x0}…${o.x1} Y${o.y0}…${o.y1}`).toBeLessThan(highest + 0.5);
  }
}

describe('simulated setups', () => {
  const world = (setup: SetupName) => buildSetup(stock, err, setup);
  const topAt = (x: number, y: number) => stock.top + err.dz + err.tiltX * x + err.tiltY * y;

  it('the probe touches the block at its real top, a clamp from the side, and the bolt above the strap', () => {
    const w = world('straps');
    const r = 3;
    // above the middle of the block: touching once below its top
    expect(touches(w.solids, r, 40, 40, 25, topAt(40, 25) + 0.01)).toBeNull();
    expect(touches(w.solids, r, 40, 40, 25, topAt(40, 25) - 0.01)?.name).toBe('block');
    // over the strap on the left edge: the strap, 10 mm up
    expect(touches(w.solids, r, 40, 4, 25, topAt(4, 25) + 9)?.name).toBe('left strap');
    // beside the nut, low: its side
    const bolt = w.solids.find((s) => s.name === 'left bolt')! as Extract<Solid, { kind: 'cyl' }>;
    expect(touches(w.solids, r, 40, bolt.cx + 9 + 2.9, bolt.cy, topAt(0, 25) + 12)?.name).toBe('left nut');
    expect(touches(w.solids, r, 40, bolt.cx + 9 + 3.1, bolt.cy, topAt(0, 25) + 12)).toBeNull();
    // in the vise, between the jaws and below their top: the jaw
    const v = world('vise');
    expect(touches(v.solids, r, 40, 40, -4, stock.top - 5)?.name).toBe('moving jaw');
    expect(touches(v.solids, r, 40, 40, -4, stock.top - 3)).toBeNull();
  });

  it('touching the top on a 3 × 3 grid: a chip on it is left out; over a strap the way down is blocked well above the top', () => {
    const w = world('straps');
    // a 0.3 mm chip lying at the middle point
    w.solids.push({ kind: 'cyl', name: 'chip', cx: 40, cy: 25, r: 1.5, z0: topAt(40, 25), z1: topAt(40, 25) + 0.3, conductive: true, look: 'steel' });
    const pts: { x: number; y: number; z: number }[] = [];
    const blocked: [number, number][] = [];
    for (const y of [6, 25, 44])
      for (const x of [6, 40, 74]) {
        // down from 30 above, as the probe does (0.005 mm steps), until it touches
        let z = stock.top + 30;
        while (z > stock.top - 6 && !touches(w.solids, 3, 40, x, y, z)) z -= 0.005;
        if (z > stock.top + 2) blocked.push([x, y]);
        else pts.push({ x, y, z });
      }
    // the straps lie over the middle of the left and right edges
    expect(blocked).toEqual([[6, 25], [74, 25]]);
    const s = analyseSurface(pts);
    expect(s.outliers?.map((p) => [p.x, p.y])).toEqual([[40, 25]]);
    expect(s.outliers![0]!.off).toBeCloseTo(0.3, 1);
    expect(s.slopeX).toBeCloseTo(err.tiltX * 100, 2);
    expect(s.slopeY).toBeCloseTo(err.tiltY * 100, 2);
    expect(s.flatness).toBeLessThan(0.01);
    // a warped top (a saddle, 0.4 mm): every point is a little off, none is left out
    const warped = [6, 25, 44].flatMap((y) => [6, 40, 74].map((x) => ({ x, y, z: 0.4 * ((x - 40) / 34) * ((y - 25) / 19) })));
    expect(analyseSurface(warped).outliers).toHaveLength(0);
  });

  for (const setup of ['block', 'side', 'toe', 'straps', 'vise'] as const) {
    it(`a laser scan of the ${setup} setup: the top as it is, and what holds it`, () => {
      const w = world(setup);
      const pts = scan(w, stock.top + 50);
      const r = analyseScan(pts, { x: stock.x, y: stock.y, top: stock.top, bottom });
      // the top, whatever lies on it: its slope and height
      expect(r.top.slopeX).toBeCloseTo(err.tiltX * 100, 1);
      expect(r.top.slopeY).toBeCloseTo(err.tiltY * 100, 1);
      expect(Math.abs(r.top.mean - topAt(40, 25))).toBeLessThan(0.05);
      expect(r.top.flatness).toBeLessThan(0.15);
      if (setup === 'block') expect(r.obstacles).toHaveLength(0);
      else expectObstaclesMatch(w, pts, r.obstacles);
      if (setup === 'straps') {
        // the straps lie on the top: left out of it, found as in the way of facing it
        expect(r.top.covered).toBeGreaterThan(200);
        expect(r.obstacles.filter((o) => o.overTop).length).toBeGreaterThanOrEqual(2);
        // in steps: a bolt is its own narrow box, as high as the bolt
        const bolts = w.solids.filter((s) => s.name.endsWith('bolt'));
        for (const b of bolts) {
          const o = r.obstacles.find((q) => Math.abs(q.top - b.z1) < 0.5);
          expect(o, `${b.name} as its own step`).toBeDefined();
          expect(o!.x1 - o!.x0).toBeLessThan(16);
        }
      } else expect(r.top.covered).toBe(0);
      if (setup === 'vise') {
        // the jaws, reaching up to the block's long sides
        expect(r.obstacles.length).toBe(2);
        const [front, back] = [...r.obstacles].sort((a, b) => a.y0 - b.y0);
        expect(front!.y1).toBeGreaterThan(-0.7);
        expect(back!.y0).toBeLessThan(stock.y + 0.5);
        expect(r.obstacles.some((o) => o.overTop)).toBe(false);
        for (const j of [front!, back!]) expect(j.top).toBeCloseTo(stock.top - 4, 0);
      }
    });
  }

  it('a block 2.5 mm off from the job and bigger: its rim beyond the outline is not an obstacle; the vise jaws stop at its side', () => {
    const off: StockError = { ...err, dx: -1.5, dy: 1.2, dsx: 2.5, dsy: 1 };
    for (const setup of ['block', 'vise'] as const) {
      const w = buildSetup(stock, off, setup);
      const r = analyseScan(scan(w, stock.top + 50), { x: stock.x, y: stock.y, top: stock.top, bottom });
      expect(r.obstacles.length, setup).toBe(setup === 'block' ? 0 : 2);
      for (const o of r.obstacles) expect(o.overTop, JSON.stringify(o)).toBeFalsy();
    }
  });

  it('the checks with what a scan found: facing over vise jaws is fine, a deep contour into them is not; straps are in the way of facing', () => {
    const found = (setup: SetupName) =>
      analyseScan(scan(world(setup), stock.top + 50), { x: stock.x, y: stock.y, top: stock.top, bottom }).obstacles.map((o, i) => ({ name: `scanned ${i + 1}`, x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, top: o.top }));
    const codes = (job: Job) => analyze(job).diagnostics.filter((d) => d.code === 'OBSTACLE');
    const vise = found('vise');
    const base = EXAMPLES.mill();
    expect(codes(Job.parse({ ...base, obstacles: vise }))).toHaveLength(0);
    const contour = (zBottom: number) => Job.parse({ ...base, operations: [...base.operations, { id: 'op4', type: 'mill_contour_rect', tool: 1, x: 2, y: 2, w: 76, h: 46, zTop: 0, zBottom, side: 'outside' }], obstacles: vise });
    expect(codes(contour(-3))).toHaveLength(0);
    expect(codes(contour(-8)).length).toBeGreaterThan(0);
    expect(codes(Job.parse({ ...base, obstacles: found('straps') })).some((d) => d.opId === 'op1')).toBe(true);
    // low edge clamps: facing and drilling clear them
    expect(codes(Job.parse({ ...base, obstacles: found('toe') }))).toHaveLength(0);
  });
});
