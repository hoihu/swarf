/**
 * Ways a block can be held on the simulated mill, as solids (solids.ts): what the probe touches,
 * the camera sees and the laser lights. All in work coordinates of the simulator's original work
 * zero; the real block is a little off from the job's (`StockError`) and the holding follows the
 * real block, the way it would on a real table.
 */
import type { Solid } from './solids.ts';

export type SetupName = 'side' | 'block' | 'toe' | 'straps' | 'vise';

export const SETUPS: { name: SetupName; label: string; about: string }[] = [
  { name: 'side', label: 'Two blocks beside it', about: 'Two steel blocks left and right of the stock, 8 mm taller than it.' },
  { name: 'block', label: 'Block alone', about: 'Just the block on the table (taped down): nothing to hit.' },
  { name: 'toe', label: 'Low edge clamps', about: 'Two edge clamps pushing from the left against a stop on the right, all below the top.' },
  { name: 'straps', label: 'Strap clamps', about: 'Two straps across the left and right edges of the top, on step blocks, with tall bolts and nuts.' },
  { name: 'vise', label: 'Machine vise', about: 'In a vise, the jaws 4 mm below the top, the block sticking out of them along X.' },
];

/** The real block against the job's: corner offset, size difference, turn (°), top too high/low, tilt (mm per mm along X and Y). */
export interface StockError {
  dx: number;
  dy: number;
  dsx: number;
  dsy: number;
  angle: number;
  dz: number;
  tiltX: number;
  tiltY: number;
}

export interface BlockStock {
  x: number;
  y: number;
  z: number;
  top: number;
}

export interface World {
  solids: Solid[];
  /** The table's top (work Z). */
  floor: number;
}

/** The real block's top at a point (work coordinates at the start). */
export function blockTopAt(s: BlockStock, e: StockError, x: number, y: number): number {
  return s.top + e.dz + e.tiltX * x + e.tiltY * y;
}

/** The setup's solids: the block first, then what holds it. */
export function buildSetup(s: BlockStock, e: StockError, setup: SetupName): World {
  const a = (e.angle * Math.PI) / 180;
  const W = s.x + e.dsx;
  const D = s.y + e.dsy;
  const bottom = s.top - s.z;
  /** Block frame (u along its X edge from its front-left corner, v along its Y edge) into work X/Y. */
  const place = (u: number, v: number): [number, number] => [e.dx + u * Math.cos(a) - v * Math.sin(a), e.dy + u * Math.sin(a) + v * Math.cos(a)];
  const top = (u: number, v: number) => blockTopAt(s, e, ...place(u, v));
  /** A box in the block's frame. */
  const box = (name: string, u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, look: Solid['look'] = 'steel', conductive = true): Solid => {
    const [cx, cy] = place((u0 + u1) / 2, (v0 + v1) / 2);
    return { kind: 'box', name, cx, cy, w: u1 - u0, d: v1 - v0, z0, z1, angle: e.angle, conductive, look };
  };
  const cyl = (name: string, u: number, v: number, r: number, z0: number, z1: number, look: Solid['look'] = 'steel'): Solid => {
    const [cx, cy] = place(u, v);
    return { kind: 'cyl', name, cx, cy, r, z0, z1, conductive: true, look };
  };
  const [bcx, bcy] = place(W / 2, D / 2);
  const block: Solid = {
    kind: 'box',
    name: 'block',
    cx: bcx,
    cy: bcy,
    w: W,
    d: D,
    z0: bottom,
    z1: blockTopAt(s, e, bcx, bcy),
    angle: e.angle,
    slope: [e.tiltX, e.tiltY],
    conductive: true,
    look: 'stock',
    stock: true,
  };
  const solids: Solid[] = [block];
  let floor = bottom;
  const mid = D / 2;
  switch (setup) {
    case 'block':
      break;
    case 'side':
      solids.push(box('left block', -22, -4, mid - 9, mid + 9, bottom, s.top + 8), box('right block', W + 4, W + 22, mid - 9, mid + 9, bottom, s.top + 8));
      break;
    case 'toe':
      // edge clamps: a body against the left side, low, with the screw head sunk in it; a stop on the right
      for (const [i, v] of [D * 0.25, D * 0.75].entries()) {
        solids.push(box(`edge clamp ${i + 1}`, -20, 0, v - 8, v + 8, bottom, s.top - 3), cyl(`edge clamp ${i + 1} screw`, -13, v, 4.5, s.top - 3, s.top - 1.5, 'dark'));
      }
      solids.push(box('stop', W, W + 12, mid - 15, mid + 15, bottom, s.top - 4));
      break;
    case 'straps':
      // a strap over each end of the top, 12 mm onto it, its far end on a step block; a T-bolt through it with a nut
      for (const side of ['left', 'right'] as const) {
        const o = side === 'left' ? (u: number) => -u : (u: number) => W + u;
        const span = (p: number, q: number): [number, number] => [Math.min(o(p), o(q)), Math.max(o(p), o(q))];
        const edge = top(side === 'left' ? 6 : W - 6, mid);
        const [s0, s1] = span(-12, 50);
        const [h0, h1] = span(40, 54);
        solids.push(
          box(`${side} strap`, s0, s1, mid - 8, mid + 8, edge, edge + 10),
          box(`${side} step block`, h0, h1, mid - 12, mid + 12, bottom, edge),
          cyl(`${side} bolt`, o(20), mid, 5, bottom, edge + 10 + 26, 'dark'),
          cyl(`${side} nut`, o(20), mid, 9, edge + 10, edge + 18),
        );
      }
      break;
    case 'vise': {
      // the vise's jaws grip the block's long sides (front and back); 100 mm wide, centred on it
      const jaw = 4;
      const u0 = W / 2 - 50;
      const u1 = W / 2 + 50;
      floor = bottom - 70;
      solids.push(
        box('vise bed', u0 - 10, u1 + 10, -60, D + 26, floor, bottom - 0.01, 'dark'),
        box('moving jaw', u0, u1, -24, 0, bottom - 20, s.top - jaw),
        box('fixed jaw', u0, u1, D, D + 24, bottom - 20, s.top - jaw),
      );
      break;
    }
  }
  return { solids, floor };
}
