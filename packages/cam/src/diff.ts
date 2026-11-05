/**
 * What changed between two versions of a job, in words: the review card after an assistant turn.
 */
import { opLabel } from './generate.ts';
import type { Job, Operation } from './schema.ts';

export interface JobDiff {
  added: { id: string; label: string }[];
  removed: { id: string; label: string }[];
  changed: { id: string; label: string; fields: string[] }[];
  /** Operations kept but in another order. */
  reordered: boolean;
  /** Stock, tools, machine, material, name. */
  other: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function fieldChanges(a: Operation, b: Operation): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === 'id') continue;
    const x = (a as Record<string, unknown>)[k];
    const y = (b as Record<string, unknown>)[k];
    if (same(x, y)) continue;
    const show = (v: unknown) => (v === undefined ? '–' : typeof v === 'object' ? 'edited' : String(v));
    out.push(typeof x === 'object' || typeof y === 'object' ? `${k} edited` : `${k} ${show(x)} → ${show(y)}`);
  }
  return out;
}

export function diffJobs(before: Job, after: Job): JobDiff {
  const old = new Map(before.operations.map((o) => [o.id!, o]));
  const now = new Map(after.operations.map((o) => [o.id!, o]));
  const d: JobDiff = { added: [], removed: [], changed: [], reordered: false, other: [] };
  for (const o of after.operations) {
    const prev = old.get(o.id!);
    if (!prev) d.added.push({ id: o.id!, label: opLabel(o) });
    else if (!same(prev, o)) d.changed.push({ id: o.id!, label: opLabel(o), fields: fieldChanges(prev, o) });
  }
  for (const o of before.operations) if (!now.has(o.id!)) d.removed.push({ id: o.id!, label: opLabel(o) });
  const kept = (ops: Operation[], other: Map<string, Operation>) => ops.filter((o) => other.has(o.id!)).map((o) => o.id);
  d.reordered = !same(kept(before.operations, now), kept(after.operations, old));
  if (!same(before.stock, after.stock)) d.other.push('stock');
  if (!same(before.tools, after.tools)) {
    const ids = new Set([...before.tools, ...after.tools].map((t) => t.id));
    for (const id of ids) {
      const a = before.tools.find((t) => t.id === id);
      const b = after.tools.find((t) => t.id === id);
      if (!a) d.other.push(`tool T${id} added`);
      else if (!b) d.other.push(`tool T${id} removed`);
      else if (!same(a, b)) d.other.push(`tool T${id} changed`);
    }
  }
  if (!same(before.machine, after.machine)) d.other.push('machine settings');
  if (before.material !== after.material) d.other.push('material');
  if (before.name !== after.name) d.other.push('name');
  return d;
}

export const isEmptyDiff = (d: JobDiff) => !d.added.length && !d.removed.length && !d.changed.length && !d.reordered && !d.other.length;
