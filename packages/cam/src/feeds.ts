/**
 * Speeds and feeds from the tool's cutting data. Feeds are mm/min (G94): grblHAL's feed per
 * revolution (G95) needs a spindle encoder, so the "boring" subset avoids it.
 */
import type { Machine, Tool } from './schema.ts';

export interface Cutting {
  rpm: number;
  feed: number;
  /** Plunging / entry feed. */
  plunge: number;
  /** Notes for the diagnostics, e.g. a clamped spindle speed. */
  notes: string[];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Spindle speed for a cutting speed vc (m/min) at a diameter (mm). */
export function rpmFor(vc: number, diameter: number): number {
  return (vc * 1000) / (Math.PI * Math.max(diameter, 0.1));
}

/**
 * @param diameter what sets the surface speed: the tool diameter on the mill, the largest
 *   workpiece diameter the operation cuts on the lathe (no G96 constant surface speed).
 */
export function cutting(tool: Tool, machine: Machine, diameter: number, override: { rpm?: number | undefined; feed?: number | undefined } = {}): Cutting {
  const notes: string[] = [];
  let rpm = override.rpm ?? rpmFor(tool.vc, diameter);
  if (rpm > machine.maxRpm) {
    notes.push(`spindle ${Math.round(rpm)} rpm limited to the machine's ${machine.maxRpm}`);
    rpm = machine.maxRpm;
  } else if (rpm < machine.minRpm) {
    notes.push(`spindle ${Math.round(rpm)} rpm raised to the machine's minimum ${machine.minRpm}`);
    rpm = machine.minRpm;
  }
  rpm = Math.round(rpm);

  let feed: number;
  if (override.feed !== undefined) feed = override.feed;
  else if (tool.type === 'endmill') feed = (tool.chipload ?? 0.03) * (tool.flutes ?? 2) * rpm;
  else feed = (tool.feedPerRev ?? 0.1) * rpm;
  if (feed > machine.maxFeed) {
    notes.push(`feed ${Math.round(feed)} mm/min limited to the machine's ${machine.maxFeed}`);
    feed = machine.maxFeed;
  }
  feed = Math.max(1, Math.round(feed));
  const plunge = Math.max(1, Math.round(tool.type === 'drill' ? feed : feed * 0.35));
  return { rpm, feed, plunge, notes };
}

export const clampRpm = (rpm: number, m: Machine) => clamp(rpm, m.minRpm, m.maxRpm);
