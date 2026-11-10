/** How the preview looks: the surroundings and the effects, as the user set them (kept in the browser). */
import { loadPicture, savePicture, type SurroundName } from './surround.ts';

const KEY = 'swarf.look';

interface Saved {
  asked?: boolean;
  surround: SurroundName;
  chips: boolean;
  coolant: boolean;
  shadows: boolean;
  sound: boolean;
  soften: boolean;
}

const DEFAULTS: Saved = { surround: 'workshop', chips: true, coolant: false, shadows: true, sound: false, soften: true };

class Look {
  surround = $state<SurroundName>(DEFAULTS.surround);
  chips = $state(DEFAULTS.chips);
  coolant = $state(DEFAULTS.coolant);
  shadows = $state(DEFAULTS.shadows);
  sound = $state(DEFAULTS.sound);
  /** Soften the user's picture a little, so the part stands out against it. */
  soften = $state(DEFAULTS.soften);
  /** The user's picture, decoded (null: none). */
  picture = $state<ImageBitmap | null>(null);
  error = $state('');
  /** The user has set the shadows themselves (else they are left off where the picture is drawn in software). */
  asked = false;

  constructor() {
    try {
      const s = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>) };
      this.surround = s.surround;
      this.chips = s.chips;
      this.coolant = s.coolant;
      this.shadows = s.shadows;
      this.soften = s.soften;
      this.asked = !!s.asked;
      // sound never starts by itself
    } catch {
      // defaults
    }
    if (typeof indexedDB !== 'undefined')
      void loadPicture().then(async (b) => {
        if (b) this.picture = await createImageBitmap(b).catch(() => null);
        if (!this.picture && this.surround === 'picture') this.surround = 'workshop';
      });
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ surround: this.surround, chips: this.chips, coolant: this.coolant, shadows: this.shadows, sound: false, soften: this.soften, asked: this.asked } satisfies Saved));
    } catch {
      // not kept
    }
  }

  /** A picture dropped or chosen: it becomes the surroundings. */
  async usePicture(file: Blob): Promise<void> {
    this.error = '';
    if (!file.type.startsWith('image/')) {
      this.error = 'That is not a picture (JPEG, PNG or WebP).';
      return;
    }
    try {
      const bmp = await createImageBitmap(file);
      this.picture?.close();
      this.picture = bmp;
      this.surround = 'picture';
      this.save();
      void savePicture(file);
    } catch {
      this.error = 'The picture could not be read.';
    }
  }

  removePicture(): void {
    this.picture?.close();
    this.picture = null;
    if (this.surround === 'picture') this.surround = 'workshop';
    this.save();
    void savePicture(null);
  }
}

export const look = new Look();
