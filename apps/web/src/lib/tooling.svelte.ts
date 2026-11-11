/**
 * Tool changes on the connected machine: which tool the work zero is right for, the change under
 * way, and the two ways of carrying the zero over to the new tool (tooling.ts): stored offsets
 * and the tool setter. Under Setting up, in the machine mode (ToolPanel.svelte).
 */
import { machine } from './machine.svelte.ts';
import { simWorld } from './simworld.ts';
import { store } from './store.svelte.ts';
import { learned, measureOnSetter, shifted, zAfterChange, type Setter, type SetterPort, type ToolOffset, type V3 } from './tooling.ts';

const KEY = 'swarf.setter';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);

class Tooling {
  /** The tool the work zero is right for (null: not known). */
  active = $state<number | null>(null);
  /** The tool being changed to (null: no change under way). */
  pending = $state<number | null>(null);
  /** The mill's tool setter (machine coordinates: needs the machine homed the same way every time). */
  setter = $state<Setter | null>(null);
  /** The setter has a reading for the active tool. */
  hasReading = $state(false);
  busy = $state(false);
  error = $state('');
  note = $state('');
  /** The work offset when the change began (the zero right for the tool before). */
  #wcoThen: V3 | null = null;
  /** The active tool's reading on the setter (machine Z). */
  #reading: number | null = null;

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Setter | null;
      if (s && [s.x, s.y, s.z, s.depth].every(Number.isFinite)) this.setter = s;
    } catch {
      // none
    }
  }

  get lathe(): boolean {
    return store.job.machine.kind === 'lathe';
  }
  /** Physical X per X as the controller counts it. */
  get #xScale(): number {
    return this.lathe && store.job.machine.xMode === 'diameter' ? 0.5 : 1;
  }
  #wco(): V3 | null {
    const s = machine.status;
    return s?.mpos && s.wpos ? (s.mpos.map((v, i) => v - s.wpos![i]!) as V3) : null;
  }
  offsetOf(id: number | null): ToolOffset | null {
    return store.job.tools.find((t) => t.id === id)?.offset ?? null;
  }
  #free(): boolean {
    this.error = '';
    if (!machine.connected || machine.status?.state !== 'Idle' || machine.job === 'running' || machine.job === 'paused') {
      this.error = 'The controller must be idle (and no program lines under way).';
      return false;
    }
    return true;
  }

  /** The connection went, or the controller lost its place: nothing is known any more. */
  forget(): void {
    this.active = this.pending = null;
    this.#wcoThen = null;
    this.#reading = null;
    this.hasReading = false;
    this.note = '';
  }

  /** The zero is right for this tool (said by the user, or at the start of a program). */
  setActive(id: number | null): void {
    if (id !== this.active) {
      this.#reading = null;
      this.hasReading = false;
    }
    this.active = id;
    this.pending = null;
    this.#wcoThen = null;
  }

  /** A tool change begins: the tool comes out, `id` goes in. The zero is still the old tool's. */
  begin(id: number): void {
    this.error = '';
    this.note = '';
    if (id === this.active) {
      this.pending = null;
      return;
    }
    this.pending = id;
    this.#wcoThen = this.#wco();
  }

  #done(note: string): void {
    this.active = this.pending ?? this.active;
    this.pending = null;
    this.#wcoThen = null;
    this.note = note;
  }

  /** Make a tool the reference the others' offsets are counted from. */
  makeReference(id: number): void {
    store.set({ ...store.job, tools: store.job.tools.map((t) => (t.id === id ? { ...t, offset: { x: 0, z: 0 } } : t)) });
  }
  forgetOffset(id: number): void {
    store.set({ ...store.job, tools: store.job.tools.map((t) => (t.id === id ? (({ offset: _o, ...rest }) => rest)(t) : t)) });
  }

  /** Move the work zero by the stored offsets: from the tool it was right for to the one now in. */
  async applyStored(): Promise<void> {
    if (!this.#free() || this.pending === null) return;
    const from = this.offsetOf(this.active);
    const to = this.offsetOf(this.pending);
    const w = machine.status?.wpos;
    if (!from || !to || !w) {
      this.error = !to ? `T${this.pending} has no stored offset yet.` : `The tool before (${this.active === null ? 'not known' : `T${this.active}`}) has no stored offset: the zero cannot be carried over from it.`;
      return;
    }
    const s = shifted(w as V3, from, to, this.#xScale);
    const r = await machine.request(this.lathe ? `G10 L20 P1 X${n3(s.x)} Z${n3(s.z)}` : `G10 L20 P1 Z${n3(s.z)}`);
    if (!r.ok) {
      this.error = r.message ?? 'The controller refused it.';
      return;
    }
    const id = this.pending;
    this.#reading = null;
    this.hasReading = false;
    this.#done(`Zero moved for T${id}: ${this.lathe ? `X ${(to.x - from.x >= 0 ? '+' : '') + n3((to.x - from.x) / this.#xScale)}, ` : ''}Z ${(to.z - from.z >= 0 ? '+' : '') + n3(to.z - from.z)}.`);
  }

  /** The new tool has been touched off by hand: the zero is right for it. `keep`: store how it sits against the tool before. */
  touchedOff(keep: boolean): void {
    this.error = '';
    if (this.pending === null) return;
    const id = this.pending;
    let note = `Zero taken as right for T${id}.`;
    if (keep) {
      const from = this.offsetOf(this.active);
      const now = this.#wco();
      if (!from || !this.#wcoThen || !now) {
        this.error = 'Nothing to compare with: the tool before has no stored offset (make one tool the reference first).';
        return;
      }
      const o = learned(from, this.#wcoThen, now, this.#xScale);
      const round = (v: number) => Math.round(v * 1000) / 1000;
      store.set({ ...store.job, tools: store.job.tools.map((t) => (t.id === id ? { ...t, offset: { x: this.lathe ? round(o.x) : 0, z: round(o.z) } } : t)) });
      note = `T${id}'s offset stored: ${this.lathe ? `X ${n3(o.x)} (radius), ` : ''}Z ${n3(o.z)} against the reference.`;
    }
    this.#reading = null;
    this.hasReading = false;
    this.#done(note);
  }

  /** The setter is under the tool now: remember where, and to come down from this height. */
  setterHere(): void {
    const m = machine.status?.mpos;
    if (!m) return;
    this.setter = { x: m[0]!, y: m[1]!, z: m[2]!, depth: 60 };
    this.#reading = null;
    this.hasReading = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.setter));
    } catch {
      // not kept
    }
  }
  /** The simulated mill's setter (the simulator knows where it stands). */
  useSimulatedSetter(): void {
    const at = simWorld.setterAt(store.job);
    if (!at || !simWorld.origin) return;
    this.setter = { x: simWorld.origin[0] + at.x, y: simWorld.origin[1] + at.y, z: simWorld.origin[2] + at.top + 30, depth: 50 };
  }
  removeSetter(): void {
    this.setter = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      // nothing
    }
  }

  /**
   * Touch the tool in the spindle on the setter. With a change under way and a reading of the
   * tool before: Z zero is moved by the difference. Otherwise the reading is only taken (this
   * tool's zero is right already).
   */
  async measure(): Promise<void> {
    if (!this.#free() || !this.setter) return;
    if ((machine.status?.spindle ?? 0) > 0) return void (this.error = 'The spindle is on: stop it first.');
    if (!machine.probeTested) return void (this.error = 'Test the circuit first: press the setter by hand until the probe input reads closed.');
    if (machine.status?.pins?.includes('P')) return void (this.error = 'The probe input is closed already.');
    const port: SetterPort = {
      request: (l) => machine.request(l),
      mpos: () => [...machine.status!.mpos!] as V3,
      wco: () => this.#wco()!,
      probe: () => machine.probe as { mpos: V3; ok: boolean } | null,
      clearProbe: () => (machine.probe = null),
      settle: async () => {
        await sleep(120);
        for (let i = 0; i < 3000 && machine.status?.state !== 'Idle'; i++) await sleep(40);
        await sleep(450);
      },
    };
    this.busy = true;
    this.note = '';
    try {
      const now = await measureOnSetter(this.setter, port);
      const then = this.#reading;
      if (this.pending !== null && then !== null) {
        const z = zAfterChange(machine.status!.wpos![2]!, then, now);
        const r = await machine.request(`G10 L20 P1 Z${n3(z)}`);
        if (!r.ok) throw new Error(r.message ?? 'The controller refused the new zero.');
        const id = this.pending;
        this.#done(`T${id} is ${n3(Math.abs(now - then))} mm ${now > then ? 'longer' : 'shorter'} than the tool before: Z zero moved by that.`);
      } else if (this.pending !== null) {
        this.error = 'There is no reading of the tool before, so nothing to compare with: touch this tool off on the work, say so below, then measure it here as the one to go on from.';
        return;
      } else this.note = `Reading taken${this.active !== null ? ` for T${this.active}` : ''}: the next tool measured here gets its Z zero from the difference.`;
      this.#reading = now;
      this.hasReading = true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }
}

export const tooling = new Tooling();
if (typeof window !== 'undefined') (window as unknown as { __swarfTooling?: Tooling }).__swarfTooling = tooling;
