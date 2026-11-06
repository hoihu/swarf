/**
 * The simulated mill's rig, the truths its calibrations should find: the line laser on the spindle
 * head and where the camera stands. Shared by the simulated camera and the tests.
 */
import type { V3 } from './solids.ts';

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * The line laser: a sheet of light from `at` (relative to the tool tip, machine coordinates),
 * across X and slanting down and back, fanning out `fan` degrees either side of `down` (`across`
 * is the fan's other direction). What stands in the light shadows what is behind it.
 */
export const LASER = (() => {
  const normal = norm([0, 1, 0.6]);
  // straight down, into the sheet
  const k = -normal[2];
  const down = norm([-k * normal[0], -k * normal[1], -1 - k * normal[2]]);
  const across = norm([down[1] * normal[2] - down[2] * normal[1], down[2] * normal[0] - down[0] * normal[2], down[0] * normal[1] - down[1] * normal[0]]);
  return { at: [0, -55, 70] as V3, normal, down, across, fan: 45, halfWidth: 0.3 };
})();

/** How the simulated camera's picture lags the machine (ms), like a webcam's. */
export const LAG = 150;

/** Where the camera stands and what it looks at (work coordinates of the original zero): in front of the machine, up, looking down at the block. */
export function millCamera(stock: { x: number; y: number; top: number }): { at: V3; target: V3 } {
  return { at: [stock.x / 2 + 30, -210, stock.top + 190], target: [stock.x / 2, stock.y / 2, stock.top + 15] };
}
