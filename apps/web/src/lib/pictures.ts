/** A picture for the assistant (a photo of a part, a sketch): made small enough to send, as JPEG. */

export interface Attached {
  data: string;
  mimeType: string;
  /** For showing it in the chat. */
  url: string;
  name: string;
}

/** The size a picture is sent at: the longer side at most `max` pixels (never enlarged). */
export function fitted(w: number, h: number, max = 1568): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export async function prepare(file: Blob, name = 'picture'): Promise<Attached> {
  if (!file.type.startsWith('image/')) throw new Error(`${name} is not a picture.`);
  let bmp: ImageBitmap;
  try {
    // (phones store photos turned, with a note saying so: honour it)
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`${name} cannot be read as a picture (HEIC photos: export as JPEG first).`);
  }
  const { w, h } = fitted(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  // (a white ground under drawings with transparency)
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const url = c.toDataURL('image/jpeg', 0.85);
  return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/jpeg', url, name };
}
