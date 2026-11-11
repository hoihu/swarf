/**
 * The job as a file (save, open) and the tool library: the user's own cutters, kept in this
 * browser, put into any job, and carried to another computer as a file.
 */
import { Library, dropTool, jobFile, keepTool, libraryFile, openJobFile, openLibraryFile, takeTool, type MachineKind, type Tool } from '@swarf/cam';
import { machine } from './machine.svelte.ts';
import { store } from './store.svelte.ts';

const KEY = 'swarf.library';

export const fileName = (name: string, ext: string) => `${name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'job'}${ext}`;

export function download(name: string, text: string, type = 'application/json'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

class Files {
  /** What the last open or save came to, for the user. */
  message = $state<{ text: string; bad: boolean } | null>(null);
  /** The setup sheet is showing. */
  sheet = $state(false);
  library = $state<Library>(this.#load());
  #timer: ReturnType<typeof setTimeout> | undefined;

  #load(): Library {
    try {
      return Library.safeParse(JSON.parse(localStorage.getItem(KEY) ?? '[]')).data ?? [];
    } catch {
      return [];
    }
  }
  #keep(lib: Library): void {
    this.library = lib;
    try {
      localStorage.setItem(KEY, JSON.stringify(lib));
    } catch {
      // not kept: it stays for this visit
    }
  }
  say(text: string, bad = false): void {
    this.message = { text, bad };
    clearTimeout(this.#timer);
    if (!bad) this.#timer = setTimeout(() => (this.message = null), 4000);
  }

  saveJob(): void {
    download(fileName(store.job.name, '.swarf.json'), jobFile($state.snapshot(store.job) as typeof store.job));
    this.say(`Saved ${fileName(store.job.name, '.swarf.json')} to your downloads.`);
  }

  /** Open a job file's text as the job (the one in hand goes on the undo stack). */
  openJob(name: string, text: string): boolean {
    if (machine.job === 'running' || machine.job === 'paused' || machine.job === 'waiting') {
      this.say('A program is under way on the machine: stop it before opening another job.', true);
      return false;
    }
    try {
      const job = openJobFile(text);
      store.replace(job);
      this.say(`Opened ${name}: ${job.name}. Undo brings the job before back.`);
      return true;
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
      return false;
    }
  }

  async openJobFrom(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.openJob(file.name, await file.text());
  }

  // ---- the tool library
  toolsFor(kind: MachineKind): Tool[] {
    return this.library.filter((e) => e.kind === kind).map((e) => e.tool);
  }
  keepTool(kind: MachineKind, tool: Tool): void {
    this.#keep(keepTool($state.snapshot(this.library) as Library, kind, $state.snapshot(tool) as Tool));
  }
  dropTool(kind: MachineKind, name: string): void {
    this.#keep(dropTool($state.snapshot(this.library) as Library, kind, name));
  }
  /** Put a library tool into the job; the number it got. */
  takeTool(tool: Tool): number {
    const r = takeTool($state.snapshot(store.job) as typeof store.job, $state.snapshot(tool) as Tool);
    store.set(r.job);
    return r.id;
  }
  saveLibrary(): void {
    download('swarf-tools.json', libraryFile($state.snapshot(this.library) as Library));
  }
  /** Add a library file's tools to the library (same name and machine: the file's wins). How many came in. */
  importLibrary(text: string): number {
    try {
      const got = openLibraryFile(text);
      let lib = $state.snapshot(this.library) as Library;
      for (const e of got) lib = keepTool(lib, e.kind, e.tool);
      this.#keep(lib);
      this.say(`${got.length} tool${got.length === 1 ? '' : 's'} from the file are in the library.`);
      return got.length;
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
      return 0;
    }
  }
  async importLibraryFrom(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.importLibrary(await file.text());
  }
}

export const files = new Files();
if (typeof window !== 'undefined') Object.assign(window, { __swarfFiles: files });
