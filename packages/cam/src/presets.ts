/**
 * Starting points: a small grblHAL lathe and mill with a basic tool table, and an example job
 * for each. Cutting data is conservative and meant for aluminium/free-cutting steel with
 * carbide inserts (lathe) and carbide endmills (mill); edit to match your machine.
 */
import { Job, type JobInput, type Machine, type Tool } from './schema.ts';

export const LATHE: Machine = {
  kind: 'lathe',
  name: 'grblHAL lathe',
  envelope: { min: { x: -1, y: 0, z: -200 }, max: { x: 70, y: 0, z: 60 } },
  minRpm: 80,
  maxRpm: 2500,
  maxFeed: 1500,
  rapidRate: 3000,
  xMode: 'diameter',
  spindleSync: false,
  chuckDiameter: 100,
  clearance: 2,
  accel: 200,
  junctionDeviation: 0.01,
  arcTolerance: 0.005,
};

export const MILL: Machine = {
  kind: 'mill',
  name: 'grblHAL mill',
  envelope: { min: { x: -30, y: -30, z: -80 }, max: { x: 300, y: 200, z: 60 } },
  minRpm: 500,
  maxRpm: 6000,
  maxFeed: 2000,
  rapidRate: 3000,
  xMode: 'diameter',
  spindleSync: false,
  clearance: 2,
  accel: 300,
  junctionDeviation: 0.01,
  arcTolerance: 0.005,
};

export const LATHE_TOOLS: Tool[] = [
  { id: 1, name: 'Turning, CCMT 09 R0.4 carbide', type: 'turning', vc: 120, feedPerRev: 0.1, maxDoc: 1, edgeLength: 3, noseRadius: 0.4 },
  { id: 2, name: 'Parting blade 2 mm', type: 'grooving', width: 2, vc: 60, feedPerRev: 0.04 },
  { id: 3, name: 'Drill Ø6 HSS', type: 'drill', diameter: 6, vc: 20, feedPerRev: 0.08, fluteLength: 50 },
  { id: 4, name: 'Threading insert 60°, 16ER', type: 'threading', vc: 60, edgeLength: 1.5 },
  { id: 5, name: 'Boring bar, min. bore Ø10', type: 'boring', internal: true, diameter: 10, fluteLength: 30, vc: 100, feedPerRev: 0.08, maxDoc: 0.5, noseRadius: 0.2, edgeLength: 2 },
  { id: 6, name: 'Internal threading bar 60°, min. bore Ø12', type: 'threading', internal: true, diameter: 12, fluteLength: 25, vc: 50, edgeLength: 1.5 },
];

export const MILL_TOOLS: Tool[] = [
  { id: 1, name: 'Endmill Ø6 3F carbide', type: 'endmill', diameter: 6, flutes: 3, vc: 120, chipload: 0.03, fluteLength: 15, maxDoc: 3, centerCutting: true },
  { id: 2, name: 'Endmill Ø10 3F carbide', type: 'endmill', diameter: 10, flutes: 3, vc: 120, chipload: 0.04, fluteLength: 22, maxDoc: 4, centerCutting: true },
  { id: 3, name: 'Drill Ø5 HSS', type: 'drill', diameter: 5, vc: 20, feedPerRev: 0.08, fluteLength: 40 },
];

const latheExample: JobInput = {
  name: 'Pin Ø20',
  machine: LATHE,
  tools: LATHE_TOOLS,
  stock: { kind: 'bar', diameter: 25, stickout: 60, front: 1 },
  material: 'aluminium 6082',
  operations: [
    { id: 'op1', type: 'lathe_face', tool: 1, z: 0 },
    { id: 'op2', type: 'lathe_turn', tool: 1, diameter: 20, zEnd: -30 },
    { id: 'op3', type: 'lathe_chamfer', tool: 1, diameter: 20, z: 0, size: 1 },
    { id: 'op4', type: 'lathe_partoff', tool: 2, z: -38 },
  ],
};

const millExample: JobInput = {
  name: 'Plate with pocket',
  machine: MILL,
  tools: MILL_TOOLS,
  stock: { kind: 'block', x: 80, y: 50, z: 15, top: 0.5 },
  material: 'aluminium 6082',
  operations: [
    { id: 'op1', type: 'mill_face', tool: 2, z: 0 },
    { id: 'op2', type: 'mill_pocket_rect', tool: 1, x: 20, y: 15, w: 40, h: 20, zBottom: -5, zTop: 0 },
    { id: 'op3', type: 'mill_drill', tool: 3, points: [{ x: 8, y: 8 }, { x: 72, y: 8 }, { x: 72, y: 42 }, { x: 8, y: 42 }], zBottom: -16, zTop: 0, peck: 4 },
  ],
};

export const EXAMPLES = { lathe: () => Job.parse(latheExample), mill: () => Job.parse(millExample) };

/** An empty job for a machine kind (its tools and example stock, no operations). */
export function emptyJob(kind: 'lathe' | 'mill'): Job {
  const j = EXAMPLES[kind]();
  return { ...j, name: 'New job', operations: [] };
}
