/**
 * Speeds and feeds from the workpiece material and the tool (see materials.ts); a tool's own
 * cutting data overrides the table. Feeds are mm/min (G94): grblHAL's feed per revolution (G95)
 * needs a spindle encoder, so the "boring" subset avoids it.
 */
import { MATERIALS, cutKind, defaultToolMaterial, type MaterialId } from './materials.ts';
import type { Machine, Tool } from './schema.ts';

export interface Cutting {
  rpm: number;
  feed: number;
  /** Plunging / entry feed. */
  plunge: number;
  /** Depth per pass: radial on the lathe, axial on the mill (mm). */
  doc: number;
  /** Notes for the diagnostics, e.g. a clamped spindle speed. */
  notes: string[];
}

/** The cutting data a tool gets in a material, before the machine's limits. */
export interface CuttingData {
  /** m/min */
  vc: number;
  /** mm per tooth (endmill) or per revolution (everything else) */
  feed: number;
  /** mm per pass: radial (lathe), axial (mill) */
  doc: number;
  /** Which values came from the tool rather than the material table. */
  fromTool: { vc: boolean; feed: boolean; doc: boolean };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Spindle speed for a cutting speed vc (m/min) at a diameter (mm). */
export function rpmFor(vc: number, diameter: number): number {
  return (vc * 1000) / (Math.PI * Math.max(diameter, 0.1));
}

/** Cutting speed, feed and depth of cut for a tool in a material: the tool's values where it has them. */
export function cuttingData(tool: Tool, material: MaterialId = 'aluminium'): CuttingData {
  const m = MATERIALS[material];
  const kind = cutKind(tool.type);
  const tm = tool.toolMaterial ?? defaultToolMaterial(tool.type);
  const hss = tm === 'hss';
  const d = tool.diameter ?? 6;
  // boring bars stick out and chatter: slower and lighter than an outside tool
  const bar = tool.internal ? 0.8 : 1;
  const vc = tool.vc ?? Math.round(m.vc[kind][tm] * bar);
  let feed: number;
  if (tool.type === 'endmill') feed = tool.chipload ?? round3(m.mill * d * (hss ? 0.7 : 1));
  else if (tool.type === 'drill') feed = tool.feedPerRev ?? round3(m.drill * d);
  else if (tool.type === 'grooving') feed = tool.feedPerRev ?? m.grooveFeed;
  else feed = tool.feedPerRev ?? round3(m.turnFeed * bar);
  let doc: number;
  if (tool.type === 'endmill') doc = Math.min(round3(m.millDoc * d * (hss ? 0.7 : 1)), tool.fluteLength ?? Infinity);
  else doc = round3(m.turnDoc * (tool.internal ? 0.5 : 1));
  if (tool.maxDoc !== undefined) doc = Math.min(doc, tool.maxDoc);
  return { vc, feed, doc, fromTool: { vc: tool.vc !== undefined, feed: (tool.type === 'endmill' ? tool.chipload : tool.feedPerRev) !== undefined, doc: tool.maxDoc !== undefined } };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * @param diameter what sets the surface speed: the tool diameter on the mill, the largest
 *   workpiece diameter the operation cuts on the lathe (no G96 constant surface speed).
 */
export function cutting(
  tool: Tool,
  machine: Machine,
  diameter: number,
  override: { rpm?: number | undefined; feed?: number | undefined } = {},
  material: MaterialId = 'aluminium',
): Cutting {
  const notes: string[] = [];
  const data = cuttingData(tool, material);
  let rpm = override.rpm ?? rpmFor(data.vc, diameter);
  if (rpm > machine.maxRpm) {
    // the table's speeds for aluminium and plastics are above most hobby spindles: running at the
    // top speed is normal there, so only a speed someone set is worth a warning
    if (override.rpm !== undefined || data.fromTool.vc) notes.push(`spindle ${Math.round(rpm)} rpm limited to the machine's ${machine.maxRpm}`);
    rpm = machine.maxRpm;
  } else if (rpm < machine.minRpm) {
    notes.push(`spindle ${Math.round(rpm)} rpm raised to the machine's minimum ${machine.minRpm}`);
    rpm = machine.minRpm;
  }
  rpm = Math.round(rpm);

  let feed: number;
  if (override.feed !== undefined) feed = override.feed;
  else if (tool.type === 'endmill') feed = data.feed * (tool.flutes ?? 2) * rpm;
  else feed = data.feed * rpm;
  if (feed > machine.maxFeed) {
    notes.push(`feed ${Math.round(feed)} mm/min limited to the machine's ${machine.maxFeed}`);
    feed = machine.maxFeed;
  }
  feed = Math.max(1, Math.round(feed));
  const plunge = Math.max(1, Math.round(tool.type === 'drill' ? feed : feed * 0.35));
  return { rpm, feed, plunge, doc: data.doc, notes };
}

export const clampRpm = (rpm: number, m: Machine) => clamp(rpm, m.minRpm, m.maxRpm);
