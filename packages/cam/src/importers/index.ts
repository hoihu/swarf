/**
 * A drawing file → a Shape for the job: DXF or SVG by content, placed on the stock so it fits
 * (kept where it is if it already lies on the stock, else moved to a 5 mm margin).
 */
import { bbox } from '../geom2d.ts';
import type { Job, Shape } from '../schema.ts';
import { importDxf } from './dxf.ts';
import { importSvg } from './svg.ts';

export function importDrawing(name: string, text: string, job: Job): { shape: Shape; notes: string[] } {
  const svg = /<svg[\s>]/i.test(text.slice(0, 4000)) || /\.svg$/i.test(name);
  const r = svg ? importSvg(text) : importDxf(text);
  if (!r.paths.length) throw new Error(`${name}: no lines, arcs or curves found${r.notes.length ? ` (${r.notes.join('; ')})` : ''}.`);
  const notes = [...r.notes];
  if (!svg) notes.unshift(`Units: ${r.units}.`);
  const b = bbox(r.paths.map((p) => p.pts))!;
  const stock = job.stock.kind === 'block' ? job.stock : null;
  const fits = stock ? b.minX >= 0 && b.minY >= 0 && b.maxX <= stock.x && b.maxY <= stock.y : true;
  const at = fits ? { x: 0, y: 0 } : { x: 5 - b.minX, y: 5 - b.minY };
  if (!fits) notes.push(`Placed with its corner 5 mm in from the stock corner (moved by X${at.x.toFixed(2)} Y${at.y.toFixed(2)}).`);
  if (stock && (b.maxX - b.minX > stock.x || b.maxY - b.minY > stock.y)) notes.push(`The drawing (${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} mm) is larger than the stock.`);
  const used = new Set(job.shapes.map((s) => s.id));
  let n = 1;
  while (used.has(`s${n}`)) n++;
  return { shape: { id: `s${n}`, name, paths: r.paths, at }, notes };
}
