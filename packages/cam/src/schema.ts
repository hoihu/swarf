/**
 * The job model: machine, tool table, stock and an ordered list of operations.
 * Everything is in millimetres and work coordinates. On the lathe, X is a radius internally
 * (the G-code emitter writes diameters in G7 mode); Z0 is the finished front face.
 * On the mill, X0 Y0 is the stock's front-left corner and Z0 its top.
 */
import { z } from 'zod';

const mm = z.number().finite();
const pos = z.number().finite().positive();

export const Vec3 = z.object({ x: mm, y: mm, z: mm });
export type Vec3 = z.infer<typeof Vec3>;

export const MachineKind = z.enum(['lathe', 'mill']);
export type MachineKind = z.infer<typeof MachineKind>;

export const Machine = z.object({
  kind: MachineKind,
  name: z.string(),
  /** Where the tool may go, in work coordinates (lathe: x is a radius, y unused). */
  envelope: z.object({ min: Vec3, max: Vec3 }),
  minRpm: pos,
  maxRpm: pos,
  /** Fastest cutting feed, mm/min. */
  maxFeed: pos,
  /** Rapid rate, mm/min (for the time estimate only). */
  rapidRate: pos,
  /** Lathe: how X is written in the G-code (G7 diameter / G8 radius). */
  xMode: z.enum(['diameter', 'radius']).default('diameter'),
  /** Lathe: chuck jaw outer diameter, used for the chuck collision check. */
  chuckDiameter: pos.optional(),
  /** Clearance kept above / beside the stock for rapids, mm. */
  clearance: pos.default(2),
});
export type Machine = z.infer<typeof Machine>;

export const ToolType = z.enum(['turning', 'grooving', 'drill', 'endmill']);
export type ToolType = z.infer<typeof ToolType>;

export const Tool = z.object({
  /** Tool number (T word / pocket). */
  id: z.number().int().min(1),
  name: z.string(),
  type: ToolType,
  /** Endmill or drill diameter. */
  diameter: pos.optional(),
  /** Grooving / parting blade width. The tool's reference point is its +Z flank (touched off on the face). */
  width: pos.optional(),
  /** Length of the cutting edge behind the tip (turning tool), used by the material model. */
  edgeLength: pos.optional(),
  /** Usable flute length (endmill, drill). */
  fluteLength: pos.optional(),
  flutes: z.number().int().min(1).optional(),
  /** Endmill can plunge straight down. */
  centerCutting: z.boolean().optional(),
  /** Cutting speed, m/min. */
  vc: pos,
  /** Feed per tooth, mm (endmill). */
  chipload: pos.optional(),
  /** Feed per revolution, mm (turning, grooving, drill). */
  feedPerRev: pos.optional(),
  /** Largest depth of cut per pass, mm (radial on the lathe, axial on the mill). */
  maxDoc: pos.optional(),
});
export type Tool = z.infer<typeof Tool>;

export const Stock = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bar'),
    diameter: pos,
    /** Length sticking out of the chuck, measured from the raw front face. */
    stickout: pos,
    /** Z of the raw front face (material left to face off), default 1. */
    front: mm.default(1),
  }),
  z.object({
    kind: z.literal('block'),
    x: pos,
    y: pos,
    /** Height of the raw block. */
    z: pos,
    /** Z of the raw top (material left to face off), default 0. */
    top: mm.default(0),
  }),
]);
export type Stock = z.infer<typeof Stock>;

/** Optional overrides every operation accepts. */
const common = {
  id: z.string().min(1).optional().describe('Stable id; assigned automatically when omitted'),
  label: z.string().optional().describe('Short human-readable name'),
  tool: z.number().int().min(1).describe('Tool number from the tool table'),
  rpm: pos.optional().describe('Spindle speed override (otherwise from the tool cutting speed)'),
  feed: pos.optional().describe('Cutting feed override, mm/min'),
};

// ---------- lathe ----------

export const LatheFace = z.object({
  type: z.literal('lathe_face'),
  ...common,
  z: mm.default(0).describe('Final face Z'),
  fromZ: mm.optional().describe('Z of the material face now (default: raw stock front)'),
  stepDown: pos.optional().describe('Z per pass (default: tool maxDoc)'),
  fromDiameter: pos.optional().describe('Diameter to start from (default: stock diameter)'),
});

export const LatheTurn = z.object({
  type: z.literal('lathe_turn'),
  ...common,
  diameter: pos.describe('Finished diameter'),
  zEnd: mm.describe('Z where the turned section ends (shoulder), negative'),
  zStart: mm.default(0).describe('Z where the turned section starts (usually the face, 0)'),
  fromDiameter: pos.optional().describe('Diameter of the material now (default: stock diameter)'),
  doc: pos.optional().describe('Radial depth per roughing pass (default: tool maxDoc)'),
  finish: z.number().min(0).default(0.2).describe('Radial allowance left for one finishing pass'),
});

export const LatheChamfer = z.object({
  type: z.literal('lathe_chamfer'),
  ...common,
  diameter: pos.describe('Diameter of the edge to chamfer'),
  z: mm.default(0).describe('Z of the edge (the face it meets)'),
  size: pos.describe('Chamfer leg length at 45°'),
});

export const LatheGroove = z.object({
  type: z.literal('lathe_groove'),
  ...common,
  diameter: pos.describe('Groove bottom diameter'),
  z: mm.describe('Z of the groove flank nearest the face'),
  width: pos.describe('Groove width (≥ blade width)'),
  fromDiameter: pos.optional().describe('Diameter of the material there (default: stock diameter)'),
  peck: pos.optional().describe('Radial peck depth (default: none)'),
});

export const LathePartoff = z.object({
  type: z.literal('lathe_partoff'),
  ...common,
  z: mm.describe('Z of the cut flank nearest the face = part length as a negative number'),
  fromDiameter: pos.optional(),
  toDiameter: z.number().min(0).default(0).describe('Stop diameter (0 = all the way through)'),
  peck: pos.optional(),
});

export const LatheDrill = z.object({
  type: z.literal('lathe_drill'),
  ...common,
  depth: pos.describe('Hole depth from the face (Z0), measured at full diameter'),
  peck: pos.optional().describe('Peck depth (default: no pecking)'),
});

// ---------- mill ----------

export const MillFace = z.object({
  type: z.literal('mill_face'),
  ...common,
  z: mm.default(0).describe('Final top Z'),
  fromZ: mm.optional().describe('Top Z now (default: raw stock top)'),
  stepDown: pos.optional(),
  stepover: z.number().gt(0).max(1).default(0.6).describe('Fraction of the tool diameter'),
});

const rect = {
  x: mm.describe('Rectangle min X'),
  y: mm.describe('Rectangle min Y'),
  w: pos.describe('Width along X'),
  h: pos.describe('Height along Y'),
};
const depthFields = {
  zBottom: mm.describe('Final depth (negative)'),
  zTop: mm.optional().describe('Material top here (default: stock top, or 0 after facing)'),
  stepDown: pos.optional().describe('Z per level (default: tool maxDoc)'),
};

export const MillPocketRect = z.object({
  type: z.literal('mill_pocket_rect'),
  ...common,
  ...rect,
  ...depthFields,
  stepover: z.number().gt(0).max(1).default(0.45),
});

export const MillPocketCircle = z.object({
  type: z.literal('mill_pocket_circle'),
  ...common,
  cx: mm,
  cy: mm,
  diameter: pos,
  ...depthFields,
  stepover: z.number().gt(0).max(1).default(0.45),
});

export const MillContourRect = z.object({
  type: z.literal('mill_contour_rect'),
  ...common,
  ...rect,
  ...depthFields,
  side: z.enum(['outside', 'inside']).default('outside').describe('Which side of the line the tool runs'),
});

export const MillDrill = z.object({
  type: z.literal('mill_drill'),
  ...common,
  points: z.array(z.object({ x: mm, y: mm })).min(1),
  zBottom: mm,
  zTop: mm.optional(),
  peck: pos.optional(),
});

export const Operation = z.discriminatedUnion('type', [
  LatheFace,
  LatheTurn,
  LatheChamfer,
  LatheGroove,
  LathePartoff,
  LatheDrill,
  MillFace,
  MillPocketRect,
  MillPocketCircle,
  MillContourRect,
  MillDrill,
]);
export type Operation = z.infer<typeof Operation>;
export type OperationInput = z.input<typeof Operation>;
export type OpType = Operation['type'];

export const OP_MACHINE: Record<OpType, MachineKind> = {
  lathe_face: 'lathe',
  lathe_turn: 'lathe',
  lathe_chamfer: 'lathe',
  lathe_groove: 'lathe',
  lathe_partoff: 'lathe',
  lathe_drill: 'lathe',
  mill_face: 'mill',
  mill_pocket_rect: 'mill',
  mill_pocket_circle: 'mill',
  mill_contour_rect: 'mill',
  mill_drill: 'mill',
};

/** Which tool types each operation can use. */
export const OP_TOOLS: Record<OpType, ToolType[]> = {
  lathe_face: ['turning'],
  lathe_turn: ['turning'],
  lathe_chamfer: ['turning'],
  lathe_groove: ['grooving'],
  lathe_partoff: ['grooving'],
  lathe_drill: ['drill'],
  mill_face: ['endmill'],
  mill_pocket_rect: ['endmill'],
  mill_pocket_circle: ['endmill'],
  mill_contour_rect: ['endmill'],
  mill_drill: ['drill', 'endmill'],
};

export const Job = z.object({
  name: z.string(),
  machine: Machine,
  tools: z.array(Tool),
  stock: Stock,
  operations: z.array(Operation),
  /** What the user said about the workpiece material, free text (shown to the agent). */
  material: z.string().optional(),
});
export type Job = z.infer<typeof Job>;
export type JobInput = z.input<typeof Job>;
