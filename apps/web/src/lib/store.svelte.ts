/**
 * App state: the job (persisted in this browser), its analysis, undo history and the API choice.
 */
import { EXAMPLES, Job, analyze, emit, type Analysis, type Emitted } from '@swarf/cam';
import { API_SERVICES, isHarnessId, type ApiChoice, type HarnessId } from '@swarf/agent';
import { load, save } from './persist.ts';

const JOB_KEY = 'swarf.job';
const API_KEY = 'swarf.api';
const ENGINE_KEY = 'swarf.engine';

/** Who answers the chat: a coding agent's CLI through the local server, a model API with the user's key, or whichever is there (the CLI first). */
export type Engine = 'auto' | 'local' | 'api';

function keptApi(): ApiChoice | null {
  const v = load<unknown>(API_KEY, null);
  return v && typeof v === 'object' && 'service' in v ? (v as ApiChoice) : null;
}

function keptEngine(): Engine | null {
  const v = load<unknown>(ENGINE_KEY, null);
  return v === 'local' || v === 'api' || v === 'auto' ? v : null;
}

function keptHarness(): HarnessId | null {
  const v = load<unknown>('swarf.harness', null);
  return isHarnessId(v) ? v : null;
}

function keptModels(): Partial<Record<HarnessId, string>> | null {
  const v = load<unknown>('swarf.models', null);
  return v && typeof v === 'object' ? (v as Partial<Record<HarnessId, string>>) : null;
}

class Store {
  job = $state<Job>(Job.safeParse(load(JOB_KEY, null)).data ?? EXAMPLES.lathe());
  history = $state<Job[]>([]);
  api = $state<ApiChoice>(keptApi() ?? { service: 'anthropic', baseURL: '', apiKey: '', model: API_SERVICES[0]!.models[0]! });
  engine = $state<Engine>(keptEngine() ?? 'auto');
  /** Which coding agent on this computer answers. */
  harness = $state<HarnessId>(keptHarness() ?? 'claude');
  /** Model per coding agent ('' or missing = the CLI's default). */
  models = $state<Partial<Record<HarnessId, string>>>(keptModels() ?? {});

  /** The model for the chosen coding agent ('' = its default). */
  get model(): string {
    return this.models[this.harness] ?? '';
  }

  setEngine(e: Engine, harness: HarnessId, models: Partial<Record<HarnessId, string>>): void {
    this.engine = e;
    this.harness = harness;
    this.models = models;
    save(ENGINE_KEY, e);
    save('swarf.harness', harness);
    save('swarf.models', models);
  }

  /** Bumped when the user switches to another job: a running agent turn must not edit the new one. */
  epoch = $state(0);
  /** Selected operation id (highlighted in the list and the preview). */
  selected = $state<string | null>(null);

  analysis: Analysis = $derived(analyze(this.job));
  gcode: Emitted = $derived(emit(this.job, this.analysis.program));

  /** Replace the job; the previous one goes on the undo stack. */
  set(job: Job, undoable = true): void {
    if (undoable) this.history = [...this.history.slice(-49), $state.snapshot(this.job) as Job];
    this.job = job;
    save(JOB_KEY, job);
  }

  /** Start over with another job (example or empty). */
  replace(job: Job): void {
    this.epoch++;
    this.selected = null;
    this.set(job);
  }

  /** Take another setup of the same job in hand (or add one): undoable, and a running agent turn stops editing. */
  setup(job: Job): void {
    this.replace(job);
  }

  /** Mark the current job as an undo point without changing it (before an agent turn). */
  checkpoint(): void {
    this.history = [...this.history.slice(-49), $state.snapshot(this.job) as Job];
  }

  undo(): void {
    const prev = this.history.at(-1);
    if (!prev) return;
    this.history = this.history.slice(0, -1);
    this.job = prev;
    save(JOB_KEY, prev);
  }

  setApi(api: ApiChoice): void {
    this.api = api;
    save(API_KEY, api);
  }
}

export const store = new Store();
// for tests: the job in hand
if (typeof window !== 'undefined') Object.assign(window, { __swarfStore: store, __swarfJob: Job });
