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
  /** Lathe: the controller can do spindle-synchronised moves (grblHAL lathe mode with an index + pulse encoder: $32=2, $38, PID tuned). Needed for threading (G33). */
  spindleSync: z.boolean().default(false),
  /** Lathe: chuck jaw outer diameter, used for the chuck collision check. */
  chuckDiameter: pos.optional(),
  /** Clearance kept above / beside the stock for rapids, mm. */
  clearance: pos.default(2),
  /** Acceleration, mm/s² (grbl $120…), for the time estimate. */
  accel: pos.default(250),
  /** Junction deviation, mm (grbl $11), for the time estimate. */
  junctionDeviation: pos.default(0.01),
});
export type Machine = z.infer<typeof Machine>;

export const ToolType = z.enum(['turning', 'boring', 'grooving', 'threading', 'drill', 'endmill']);
export type ToolType = z.infer<typeof ToolType>;

export const Tool = z.object({
  /** Tool number (T word / pocket). */
  id: z.number().int().min(1),
  name: z.string(),
  type: ToolType,
  /** Endmill or drill diameter; boring bar or internal threading bar: the smallest bore it fits in. */
  diameter: pos.optional(),
  /** Internal tool (boring bar, internal threading bar). */
  internal: z.boolean().optional(),
  /** Grooving / parting blade width. The tool's reference point is its +Z flank (touched off on the face). */
  width: pos.optional(),
  /** Insert nose radius (turning tool). Paths are for the imaginary tool tip; tapers and chamfers are compensated. */
  noseRadius: z.number().min(0).optional(),
  /** Length of the cutting edge behind the tip (turning tool), used by the material model. */
  edgeLength: pos.optional(),
  /** Usable flute length (endmill, drill); reach (boring bar, internal threading bar). */
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

export const ProfilePoint = z.object({
  d: z.number().min(0).describe('Diameter'),
  z: mm.describe('Z'),
  c: pos.optional().describe('Chamfer at this corner (leg length)'),
  r: pos.optional().describe('Radius at this corner'),
});

export const LatheProfile = z.object({
  type: z.literal('lathe_profile'),
  ...common,
  points: z.array(ProfilePoint).min(2).describe('The outline from the face towards the chuck; diameters never get smaller going towards the chuck. Start at d 0, z 0 to face as well.'),
  fromDiameter: pos.optional().describe('Diameter of the material now (default: stock diameter)'),
  doc: pos.optional().describe('Radial depth per roughing pass (default: tool maxDoc)'),
  finish: z.number().min(0).default(0.2).describe('Allowance left by roughing for the finishing pass'),
});

export const LatheBore = z.object({
  type: z.literal('lathe_bore'),
  ...common,
  diameter: pos.describe('Finished bore diameter'),
  zEnd: mm.describe('Depth: Z of the bore bottom (negative)'),
  fromDiameter: pos.describe('Diameter of the hole there now (the drill size)'),
  zStart: mm.default(0).describe('Z where the bore starts (usually the face)'),
  doc: pos.optional().describe('Radial depth per pass (default: tool maxDoc)'),
  finish: z.number().min(0).default(0.15).describe('Radial allowance for one finishing pass'),
});

export const LatheThread = z.object({
  type: z.literal('lathe_thread'),
  ...common,
  side: z.enum(['external', 'internal']).default('external').describe('internal: in a bore already at the minor diameter'),
  diameter: pos.describe('Nominal (major) diameter of the thread, e.g. 10 for M10; external: turned to it first, internal: bored to the minor diameter first'),
  pitch: pos.describe('Pitch, mm (e.g. 1.5 for M10)'),
  zEnd: mm.describe('Z where the thread ends (towards the chuck); leave room, there is no pull-out'),
  zStart: mm.default(0).describe('Z where the thread starts (usually the face)'),
  depth: pos.optional().describe('Radial thread depth (default ISO metric: external 0.6134 × pitch, internal 0.5413 × pitch)'),
  firstCut: pos.default(0.25).describe('Radial depth of the first pass; later passes get shallower (constant chip area)'),
  springPasses: z.number().int().min(0).max(5).default(1).describe('Extra passes at full depth'),
  infeed: z.enum(['flank', 'radial']).default('flank').describe('flank: along the 29.5° flank like a compound slide; radial: straight in'),
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

const rampAngle = z.number().gt(0).max(30).default(3).describe('Entry ramp angle, degrees');

export const MillPocketRect = z.object({
  type: z.literal('mill_pocket_rect'),
  ...common,
  ...rect,
  ...depthFields,
  stepover: z.number().gt(0).max(1).default(0.45),
  entry: z.enum(['ramp', 'plunge']).default('ramp').describe('How the tool gets down to each level'),
  rampAngle,
});

export const MillPocketCircle = z.object({
  type: z.literal('mill_pocket_circle'),
  ...common,
  cx: mm,
  cy: mm,
  diameter: pos,
  ...depthFields,
  stepover: z.number().gt(0).max(1).default(0.45),
  entry: z.enum(['helix', 'plunge']).default('helix').describe('How the tool gets down to each level'),
  rampAngle,
});

export const MillContourRect = z.object({
  type: z.literal('mill_contour_rect'),
  ...common,
  ...rect,
  ...depthFields,
  side: z.enum(['outside', 'inside']).default('outside').describe('Which side of the line the tool runs'),
  entry: z.enum(['ramp', 'plunge']).default('ramp').describe('How the tool gets down to each level'),
  rampAngle,
  tabs: z.number().int().min(0).max(16).default(0).describe('Holding tabs left standing so a cut-out part stays in place'),
  tabWidth: pos.default(4).describe('Tab width along the edge'),
  tabHeight: pos.default(1).describe('Tab height above the bottom'),
});

/** Imported 2D geometry (DXF, SVG) in mm, placed on the stock by `at`. */
export const Shape = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Polylines (arcs and curves already as short segments), as drawn. */
  paths: z.array(z.object({ closed: z.boolean(), pts: z.array(z.tuple([mm, mm])).min(2) })).min(1),
  /** Where the drawing's origin goes on the stock (X0 Y0 = front-left corner). */
  at: z.object({ x: mm, y: mm }).default({ x: 0, y: 0 }),
});
export type Shape = z.infer<typeof Shape>;

const shapeEntry = {
  entry: z.enum(['ramp', 'plunge']).default('ramp').describe('ramp: down along the path at the ramp angle; plunge: straight down'),
  rampAngle,
};

export const MillContour = z.object({
  type: z.literal('mill_contour'),
  ...common,
  shape: z.string().describe('Shape id (an imported drawing)'),
  side: z.enum(['outside', 'inside', 'on']).default('outside').describe('outside: cut the part out (holes in it are cut too); inside: run inside the outline; on: tool centre on the lines (engraving, open paths)'),
  ...depthFields,
  ...shapeEntry,
  tabs: z.number().int().min(0).max(16).default(0).describe('Holding tabs per outer loop, so a cut-out part stays in place'),
  tabWidth: pos.default(4),
  tabHeight: pos.default(1),
});

export const MillPocket = z.object({
  type: z.literal('mill_pocket'),
  ...common,
  shape: z.string().describe('Shape id: its closed loops are the pocket, loops inside them islands that stay'),
  ...depthFields,
  stepover: z.number().gt(0).max(1).default(0.45),
  ...shapeEntry,
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
  LatheProfile,
  LatheChamfer,
  LatheGroove,
  LathePartoff,
  LatheBore,
  LatheThread,
  LatheDrill,
  MillFace,
  MillPocketRect,
  MillPocketCircle,
  MillContourRect,
  MillContour,
  MillPocket,
  MillDrill,
]);
export type Operation = z.infer<typeof Operation>;
export type OperationInput = z.input<typeof Operation>;
export type OpType = Operation['type'];

export const OP_MACHINE: Record<OpType, MachineKind> = {
  lathe_face: 'lathe',
  lathe_turn: 'lathe',
  lathe_profile: 'lathe',
  lathe_chamfer: 'lathe',
  lathe_groove: 'lathe',
  lathe_partoff: 'lathe',
  lathe_bore: 'lathe',
  lathe_thread: 'lathe',
  lathe_drill: 'lathe',
  mill_face: 'mill',
  mill_pocket_rect: 'mill',
  mill_pocket_circle: 'mill',
  mill_contour_rect: 'mill',
  mill_contour: 'mill',
  mill_pocket: 'mill',
  mill_drill: 'mill',
};

/** Which tool types each operation can use. */
export const OP_TOOLS: Record<OpType, ToolType[]> = {
  lathe_face: ['turning'],
  lathe_turn: ['turning'],
  lathe_profile: ['turning'],
  lathe_chamfer: ['turning'],
  lathe_groove: ['grooving'],
  lathe_partoff: ['grooving'],
  lathe_bore: ['boring'],
  lathe_thread: ['threading'],
  lathe_drill: ['drill'],
  mill_face: ['endmill'],
  mill_pocket_rect: ['endmill'],
  mill_pocket_circle: ['endmill'],
  mill_contour_rect: ['endmill'],
  mill_contour: ['endmill'],
  mill_pocket: ['endmill'],
  mill_drill: ['drill', 'endmill'],
};

export const Job = z.object({
  name: z.string(),
  machine: Machine,
  tools: z.array(Tool),
  stock: Stock,
  operations: z.array(Operation),
  /** Imported drawings that operations refer to. */
  shapes: z.array(Shape).default([]),
  /** What the user said about the workpiece material, free text (shown to the agent). */
  material: z.string().optional(),
});
export type Job = z.infer<typeof Job>;
export type JobInput = z.input<typeof Job>;
