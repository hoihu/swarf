/**
 * Forms from the job schema: each operation type's (and the tool's) JSON schema becomes a list
 * of fields. Labels and units live here; validation stays with zod.
 */
import { z } from 'zod';
import { Operation, Tool, type OpType } from '@swarf/cam';

export interface Field {
  key: string;
  label: string;
  kind: 'number' | 'integer' | 'text' | 'select' | 'checkbox' | 'points' | 'tool';
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
  points: ['Holes'],
  entry: ['Entry'],
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
  vc: ['Cutting speed', 'm/min'],
  chipload: ['Chip load', 'mm/tooth'],
  feedPerRev: ['Feed per rev', 'mm'],
  maxDoc: ['Max depth per pass', 'mm'],
};

function fields(schema: Json, skip: string[]): Field[] {
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const out: Field[] = [];
  for (const [key, p] of Object.entries(props)) {
    if (skip.includes(key)) continue;
    const [label, unit] = LABELS[key] ?? [key];
    const base = { key, label, required: required.has(key), ...(unit ? { unit } : {}), ...(typeof p.description === 'string' ? { help: p.description } : {}), ...('default' in p ? { default: p.default } : {}) };
    if (key === 'tool') out.push({ ...base, kind: 'tool' });
    else if (Array.isArray(p.enum)) out.push({ ...base, kind: 'select', options: p.enum as string[] });
    else if (p.type === 'array') out.push({ ...base, kind: 'points' });
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

/** zod issues keyed by their top-level field. */
export function issuesByField(e: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of e.issues) {
    const k = String(i.path[0] ?? '_');
    out[k] ??= i.message;
  }
  return out;
}
