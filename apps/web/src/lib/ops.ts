import type { MachineKind, OperationInput, OpType } from '@swarf/cam';

/** Names and starting values for adding an operation by hand. */
export const OP_TEMPLATES: Record<MachineKind, { type: OpType; name: string; make: () => OperationInput }[]> = {
  lathe: [
    { type: 'lathe_face', name: 'Face', make: () => ({ type: 'lathe_face', tool: 1, z: 0 }) },
    { type: 'lathe_turn', name: 'Turn diameter', make: () => ({ type: 'lathe_turn', tool: 1, diameter: 20, zEnd: -20 }) },
    { type: 'lathe_chamfer', name: 'Chamfer', make: () => ({ type: 'lathe_chamfer', tool: 1, diameter: 20, z: 0, size: 0.5 }) },
    { type: 'lathe_groove', name: 'Groove', make: () => ({ type: 'lathe_groove', tool: 2, diameter: 16, z: -10, width: 3 }) },
    { type: 'lathe_drill', name: 'Drill on centre', make: () => ({ type: 'lathe_drill', tool: 3, depth: 10, peck: 3 }) },
    { type: 'lathe_partoff', name: 'Part off', make: () => ({ type: 'lathe_partoff', tool: 2, z: -30 }) },
  ],
  mill: [
    { type: 'mill_face', name: 'Face', make: () => ({ type: 'mill_face', tool: 2, z: 0 }) },
    { type: 'mill_pocket_rect', name: 'Rectangular pocket', make: () => ({ type: 'mill_pocket_rect', tool: 1, x: 10, y: 10, w: 30, h: 20, zBottom: -3 }) },
    { type: 'mill_pocket_circle', name: 'Circular pocket', make: () => ({ type: 'mill_pocket_circle', tool: 1, cx: 20, cy: 20, diameter: 16, zBottom: -3 }) },
    { type: 'mill_contour_rect', name: 'Rectangular contour', make: () => ({ type: 'mill_contour_rect', tool: 1, x: 5, y: 5, w: 40, h: 30, zBottom: -2, side: 'outside' }) },
    { type: 'mill_drill', name: 'Drill holes', make: () => ({ type: 'mill_drill', tool: 3, points: [{ x: 10, y: 10 }], zBottom: -5 }) },
  ],
};

export function minutes(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} min ${s.toString().padStart(2, '0')} s`;
}
