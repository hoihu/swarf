/**
 * Forms from the job schema: each operation type's (and the tool's) JSON schema becomes a list
 * of fields. Labels and units live here; validation stays with zod.
 */
import { z } from 'zod';
import { Machine, Operation, Tool, type MachineKind, type OpType } from '@swarf/cam';

export interface Field {
  key: string;
  label: string;
  kind: 'number' | 'integer' | 'text' | 'select' | 'checkbox' | 'rows' | 'tool' | 'shape';
  /** rows: the number columns of each row, and which must be filled. */
  columns?: { key: string; label: string; required: boolean }[];
  required: boolean;
  options?: string[];
  unit?: string;
  help?: string;
  default?: unknown;
}

type Json = Record<string, unknown>;

const LABELS: Record<string, [string, string?]> = {
  tool: ['Tool'],
  label: ['Name'],
  rpm: ['Spindle', 'rpm'],
  feed: ['Feed', 'mm/min'],
  z: ['Z', 'mm'],
  fromZ: ['Material face now at Z', 'mm'],
  stepDown: ['Step down', 'mm'],
  stepover: ['Stepover', '× Ø'],
  fromDiameter: ['Material Ø now', 'mm'],
  diameter: ['Diameter', 'mm'],
  toDiameter: ['Stop at Ø', 'mm'],
  zEnd: ['To Z (shoulder)', 'mm'],
  zStart: ['From Z', 'mm'],
  doc: ['Depth per pass', 'mm'],
  finish: ['Finishing allowance', 'mm'],
  size: ['Size', 'mm'],
  width: ['Width', 'mm'],
  peck: ['Peck', 'mm'],
  depth: ['Depth', 'mm'],
  x: ['X', 'mm'],
  y: ['Y', 'mm'],
  w: ['Width (X)', 'mm'],
  h: ['Height (Y)', 'mm'],
  cx: ['Centre X', 'mm'],
  cy: ['Centre Y', 'mm'],
  zBottom: ['Bottom Z', 'mm'],
  zTop: ['Top Z', 'mm'],
  side: ['Side'],
  points: ['Points'],
  entry: ['Entry'],
  direction: ['Cutting direction'],
  pitch: ['Pitch', 'mm'],
  firstCut: ['First pass depth', 'mm'],
  springPasses: ['Spring passes'],
  infeed: ['Infeed'],
  internal: ['Internal tool'],
  tabs: ['Tabs'],
  shape: ['Drawing'],
  tabWidth: ['Tab width', 'mm'],
  tabHeight: ['Tab height', 'mm'],
  // machine
  kind: ['Machine'],
  minRpm: ['Spindle min', 'rpm'],
  maxRpm: ['Spindle max', 'rpm'],
  maxFeed: ['Max feed', 'mm/min'],
  rapidRate: ['Rapid rate', 'mm/min'],
  xMode: ['X in G-code as'],
  spindleSync: ['Spindle sync (G33 threading)'],
  chuckDiameter: ['Chuck Ø', 'mm'],
  clearance: ['Clearance', 'mm'],
  accel: ['Acceleration', 'mm/s²'],
  junctionDeviation: ['Junction deviation', 'mm'],
  arcTolerance: ['Arc fitting tolerance (0 = lines only)', 'mm'],
  rampAngle: ['Ramp angle', '°'],
  noseRadius: ['Nose radius', 'mm'],
  // tools
  id: ['Number'],
  name: ['Name'],
  type: ['Type'],
  edgeLength: ['Cutting edge length', 'mm'],
  fluteLength: ['Flute length', 'mm'],
  flutes: ['Flutes'],
  centerCutting: ['Centre cutting'],
  toolMaterial: ['Tool material'],
  vc: ['Cutting speed', 'm/min'],
  chipload: ['Chip load', 'mm/tooth'],
  feedPerRev: ['Feed per rev', 'mm'],
  maxDoc: ['Max depth per pass', 'mm'],
};

const COLUMN_LABELS: Record<string, string> = { d: 'Ø', z: 'Z', x: 'X', y: 'Y', c: 'Chamfer', r: 'Radius' };

function fields(schema: Json, skip: string[]): Field[] {
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const out: Field[] = [];
  for (const [key, p] of Object.entries(props)) {
    if (skip.includes(key)) continue;
    const [label, unit] = LABELS[key] ?? [key];
    const base = { key, label, required: required.has(key), ...(unit ? { unit } : {}), ...(typeof p.description === 'string' ? { help: p.description } : {}), ...('default' in p ? { default: p.default } : {}) };
    if (key === 'tool') out.push({ ...base, kind: 'tool' });
    else if (key === 'shape') out.push({ ...base, kind: 'shape' });
    else if (Array.isArray(p.enum)) out.push({ ...base, kind: 'select', options: p.enum as string[] });
    else if (p.type === 'array') {
      const items = (p.items ?? {}) as Json;
      const req = new Set((items.required as string[] | undefined) ?? []);
      const columns = Object.keys((items.properties ?? {}) as Json).map((k) => ({ key: k, label: COLUMN_LABELS[k] ?? k.toUpperCase(), required: req.has(k) }));
      out.push({ ...base, kind: 'rows', columns });
    }
    else if (p.type === 'boolean') out.push({ ...base, kind: 'checkbox' });
    else if (p.type === 'integer') out.push({ ...base, kind: 'integer' });
    else if (p.type === 'number') out.push({ ...base, kind: 'number' });
    else out.push({ ...base, kind: 'text' });
  }
  // required first, then the optional overrides
  return [...out.filter((f) => f.required || f.default !== undefined), ...out.filter((f) => !f.required && f.default === undefined)];
}

const opSchema = z.toJSONSchema(Operation, { io: 'input', unrepresentable: 'any' }) as Json;
const variants = ((opSchema.oneOf ?? opSchema.anyOf) as Json[]) ?? [];

export function opFields(type: OpType): Field[] {
  const v = variants.find((x) => ((x.properties as Record<string, Json>).type as Json).const === type);
  return v ? fields(v, ['type', 'id']) : [];
}

export const toolFields: Field[] = fields(z.toJSONSchema(Tool, { io: 'input', unrepresentable: 'any' }) as Json, []);

/** Tool fields that mean nothing for a type of tool. */
const NOT_FOR: Record<string, string[]> = {
  turning: ['width', 'flutes', 'centerCutting', 'chipload'],
  boring: ['width', 'flutes', 'centerCutting', 'chipload'],
  grooving: ['diameter', 'internal', 'noseRadius', 'flutes', 'centerCutting', 'chipload', 'fluteLength'],
  threading: ['width', 'noseRadius', 'flutes', 'centerCutting', 'chipload', 'feedPerRev', 'maxDoc'],
  drill: ['internal', 'width', 'noseRadius', 'edgeLength', 'flutes', 'centerCutting', 'chipload', 'maxDoc'],
  endmill: ['internal', 'width', 'noseRadius', 'edgeLength', 'feedPerRev'],
};

/** The fields for one tool: those its type uses, and any it has a value for anyway. */
export function toolFieldsFor(tool: Record<string, unknown>): Field[] {
  const skip = NOT_FOR[tool.type as string] ?? [];
  return toolFields.filter((f) => !skip.includes(f.key) || tool[f.key] !== undefined);
}

/** zod issues keyed by their top-level field. */
export function issuesByField(e: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of e.issues) {
    const k = String(i.path[0] ?? '_');
    out[k] ??= i.message;
  }
  return out;
}

const machineSchema = z.toJSONSchema(Machine, { io: 'input', unrepresentable: 'any' }) as Json;

/** Machine settings (the travel envelope stays out of the form for now). */
export function machineFields(kind: MachineKind): Field[] {
  const latheOnly = ['xMode', 'spindleSync', 'chuckDiameter'];
  return fields(machineSchema, ['kind', 'envelope', ...(kind === 'mill' ? latheOnly : [])]).map((f) => ({ ...f, required: true }));
}
