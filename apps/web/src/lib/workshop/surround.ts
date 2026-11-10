/**
 * What is around the machine in the preview: painted surroundings (a workshop, a photo studio, a
 * night shift) or the user's own picture, as the background and as what the metal reflects.
 *
 * A picture twice as wide as high is taken for a 360° panorama (a phone's "photo sphere") and
 * surrounds the scene: it turns with the view. Any other picture stands behind the scene like a
 * backdrop, filling the view, and is still what the metal reflects.
 */
import * as THREE from 'three';

export type SurroundName = 'workshop' | 'studio' | 'night' | 'plain' | 'picture';

export const SURROUNDS: { name: SurroundName; label: string }[] = [
  { name: 'workshop', label: 'Workshop' },
  { name: 'studio', label: 'Studio' },
  { name: 'night', label: 'Night shift' },
  { name: 'plain', label: 'Plain' },
  { name: 'picture', label: 'Your picture' },
];

/** A painted panorama (2:1, the horizon in the middle). */
function paint(name: 'workshop' | 'studio' | 'night'): HTMLCanvasElement {
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const grad = (y0: number, y1: number, stops: [number, string][]) => {
    const gr = g.createLinearGradient(0, y0, 0, y1);
    for (const [t, col] of stops) gr.addColorStop(t, col);
    g.fillStyle = gr;
    g.fillRect(0, y0, W, y1 - y0);
  };
  const glow = (x: number, y: number, rx: number, ry: number, col: string, a = 1) => {
    for (const dx of [-W, 0, W]) {
      const gr = g.createRadialGradient(x + dx, y, 0, x + dx, y, 1);
      gr.addColorStop(0, col);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.save();
      g.globalAlpha = a;
      g.translate(x + dx, y);
      g.scale(rx, ry);
      g.translate(-(x + dx), -y);
      g.fillStyle = gr;
      g.fillRect(x + dx - 1, y - 1, 2, 2);
      g.restore();
    }
  };
  if (name === 'studio') {
    grad(0, H, [[0, '#f4f5f6'], [0.45, '#d5d9dc'], [0.5, '#b9bec2'], [1, '#6f767b']]);
    // soft boxes: one big overhead, two at the sides
    g.fillStyle = '#ffffff';
    g.fillRect(380, 20, 300, 70);
    glow(530, 60, 260, 110, 'rgba(255,255,255,0.9)');
    glow(140, 200, 120, 150, 'rgba(255,250,240,0.85)');
    glow(860, 190, 90, 130, 'rgba(235,242,255,0.7)');
    return c;
  }
  if (name === 'night') {
    grad(0, H, [[0, '#0b0e12'], [0.5, '#151a20'], [0.52, '#1c1f22'], [1, '#090a0b']]);
    // the machine lamp, warm, close; a monitor's glow; a window with the last of the dusk
    glow(560, 120, 90, 70, 'rgba(255,214,150,1)');
    glow(560, 120, 240, 170, 'rgba(255,190,110,0.35)');
    glow(180, 230, 70, 45, 'rgba(120,180,255,0.75)');
    g.fillStyle = '#1d2b45';
    g.fillRect(820, 150, 90, 70);
    glow(865, 185, 90, 60, 'rgba(70,100,170,0.45)');
    return c;
  }
  // the workshop: a pale ceiling with strip lights, plastered walls, a bank of windows, a grey painted floor
  grad(0, H * 0.5, [[0, '#cfd3d2'], [0.5, '#bfc4c1'], [1, '#a9aca6']]);
  grad(H * 0.5, H, [[0, '#6c7170'], [0.25, '#5a605f'], [1, '#3d4241']]);
  // strip lights
  for (const x of [120, 380, 640, 900]) {
    g.fillStyle = '#fffdf2';
    g.fillRect(x - 70, 48, 140, 10);
    glow(x, 54, 150, 50, 'rgba(255,252,235,0.75)');
  }
  // windows along one wall, daylight in them
  for (let i = 0; i < 4; i++) {
    const x = 560 + i * 70;
    g.fillStyle = '#cfe2f1';
    g.fillRect(x, 150, 56, 85);
    g.fillStyle = '#8f9690';
    g.fillRect(x + 26, 150, 3, 85);
    g.fillRect(x, 190, 56, 3);
  }
  glow(700, 190, 220, 110, 'rgba(225,238,250,0.45)');
  // a tool board and a shelf, as dark shapes
  g.fillStyle = '#7b6a55';
  g.fillRect(90, 160, 190, 70);
  g.fillStyle = '#4b4f52';
  for (let i = 0; i < 9; i++) g.fillRect(100 + i * 20, 170 + (i % 3) * 6, 8, 40);
  g.fillStyle = '#394046';
  g.fillRect(320, 175, 120, 81);
  // warm bounce off the floor near the windows
  glow(700, 330, 260, 60, 'rgba(210,205,190,0.25)');
  return c;
}

export interface Surround {
  /** For scene.background (null: see through to the page). */
  background: THREE.Texture | null;
  /** For scene.environment. */
  environment: THREE.Texture | null;
  /** A backdrop picture (not a panorama): keep it filling the view (see `cover`). */
  backdrop: boolean;
  /** How strongly the lights should shine (the night is dark). */
  light: number;
  dispose(): void;
}

/** A canvas of the picture, at most `max` pixels wide, optionally softened (so the part stands out against it). */
function prepared(img: CanvasImageSource & { width: number; height: number }, max: number, blur: number, dim = 1): HTMLCanvasElement {
  const k = Math.min(1, max / img.width);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(img.width * k));
  c.height = Math.max(2, Math.round(img.height * k));
  const g = c.getContext('2d')!;
  if (blur > 0) g.filter = `blur(${blur}px)`;
  // (drawn a little larger so the blur has no transparent rim)
  const m = blur * 2;
  g.drawImage(img, -m, -m, c.width + 2 * m, c.height + 2 * m);
  if (dim < 1) {
    g.filter = 'none';
    g.fillStyle = `rgba(0,0,0,${1 - dim})`;
    g.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

export function isPanorama(w: number, h: number): boolean {
  return Math.abs(w / h - 2) < 0.08;
}

/** Build the surroundings. `picture`: the user's, for 'picture'. */
export function makeSurround(renderer: THREE.WebGLRenderer, name: SurroundName, picture: (CanvasImageSource & { width: number; height: number }) | null, soften: boolean): Surround {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const made: THREE.Texture[] = [];
  const equirect = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    made.push(t);
    return t;
  };
  const env = (t: THREE.Texture) => {
    const e = pmrem.fromEquirectangular(t).texture;
    made.push(e);
    return e;
  };
  let out: Omit<Surround, 'dispose'>;
  if (name === 'picture' && picture) {
    if (isPanorama(picture.width, picture.height)) {
      const t = equirect(prepared(picture, 4096, 0));
      out = { background: t, environment: env(t), backdrop: false, light: 1 };
    } else {
      // behind the scene, softened a little; and wrapped around it for the reflections
      const back = new THREE.CanvasTexture(prepared(picture, 2048, soften ? 5 : 0, 0.92));
      back.colorSpace = THREE.SRGBColorSpace;
      made.push(back);
      out = { background: back, environment: env(equirect(prepared(picture, 1024, 8))), backdrop: true, light: 1 };
    }
  } else if (name === 'plain' || name === 'picture') {
    // nothing behind (the page's own gradient); a studio's light for the metal all the same
    out = { background: null, environment: env(equirect(paint('studio'))), backdrop: false, light: 1 };
  } else {
    const t = equirect(paint(name));
    out = { background: t, environment: env(t), backdrop: false, light: name === 'night' ? 0.55 : 1 };
  }
  pmrem.dispose();
  return { ...out, dispose: () => made.forEach((t) => t.dispose()) };
}

/** Make a backdrop picture fill a view of aspect `aspect` without squeezing it (cut at the sides or top and bottom). */
export function cover(t: THREE.Texture, aspect: number): void {
  const img = t.image as { width: number; height: number };
  const a = img.width / img.height;
  if (a > aspect) {
    t.repeat.set(aspect / a, 1);
    t.offset.set((1 - aspect / a) / 2, 0);
  } else {
    t.repeat.set(1, a / aspect);
    t.offset.set(0, (1 - a / aspect) / 2);
  }
}

// ---- keeping the user's picture (IndexedDB: too big for localStorage) ----

const DB = 'swarf';
const STORE = 'files';
const KEY = 'surround';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function savePicture(blob: Blob | null): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      if (blob) tx.objectStore(STORE).put(blob, KEY);
      else tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    d.close();
  } catch {
    // not kept: it stays for this visit
  }
}

export async function loadPicture(): Promise<Blob | null> {
  try {
    const d = await db();
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve((r.result as Blob | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
    d.close();
    return blob;
  } catch {
    return null;
  }
}
