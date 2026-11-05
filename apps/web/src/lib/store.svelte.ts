/**
 * App state: the job (persisted in this browser), its analysis, undo history and the API choice.
 */
import { EXAMPLES, Job, analyze, emit, type Analysis, type Emitted } from '@swarf/cam';
import { API_SERVICES, type ApiChoice } from '@swarf/agent';

const JOB_KEY = 'swarf.job';
const API_KEY = 'swarf.api';

function load<T>(key: string, parse: (v: unknown) => T | null, fallback: () => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const v = parse(JSON.parse(raw));
      if (v) return v;
    }
  } catch {
    // storage unavailable or corrupt: start fresh
  }
  return fallback();
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private window or full storage: the session still works
  }
}

class Store {
  job = $state<Job>(load(JOB_KEY, (v) => Job.safeParse(v).data ?? null, () => EXAMPLES.lathe()));
  history = $state<Job[]>([]);
  api = $state<ApiChoice>(
    load<ApiChoice>(API_KEY, (v) => (v && typeof v === 'object' && 'service' in v ? (v as ApiChoice) : null), () => ({ service: 'anthropic', baseURL: '', apiKey: '', model: API_SERVICES[0]!.models[0]! })),
  );
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
