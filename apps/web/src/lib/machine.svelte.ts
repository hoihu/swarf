/**
 * The connected controller: one streamer over Web Serial, its live status and the console.
 */
import { RT, Streamer, type JobState, type Status } from '@swarf/grbl';
import { openSerial, serialSupported } from './serial.ts';

export interface ConsoleLine {
  dir: 'in' | 'out' | 'note';
  text: string;
}

class Machine {
  connected = $state(false);
  label = $state('');
  status = $state<Status | null>(null);
  job = $state<JobState>('idle');
  message = $state('');
  acked = $state(0);
  total = $state(0);
  /** Program line (0-based) of the last acknowledged block. */
  line = $state(-1);
  console = $state<ConsoleLine[]>([]);
  readonly supported = serialSupported();
  #s: Streamer | null = null;

  #log(l: ConsoleLine): void {
    this.console = [...this.console.slice(-199), l];
  }

  async connect(): Promise<void> {
    if (this.#s) return;
    try {
      const t = await openSerial();
      this.label = t.label;
      this.#s = new Streamer(t, {
        status: (s) => (this.status = s),
        progress: (a, total, src) => {
          this.acked = a;
          this.total = total;
          this.line = src;
        },
        job: (state, message) => {
          this.job = state;
          if (message) {
            this.message = message;
            this.#log({ dir: 'note', text: message });
          } else if (state === 'running') this.message = '';
          if (state === 'paused' && this.status?.state === 'Hold') this.message = 'Paused. If this is a tool change (M0): change the tool, touch off, then Resume.';
          if (state === 'done') this.message = 'Program finished.';
        },
        log: (dir, text) => this.#log({ dir, text }),
      });
      this.connected = true;
      // ask for build info: the OPT line tells the receive buffer size
      await this.#s.send('$I');
    } catch (e) {
      this.message = e instanceof Error ? e.message : String(e);
    }
  }

  async disconnect(): Promise<void> {
    await this.#s?.close();
    this.#s = null;
    this.connected = false;
    this.status = null;
    this.job = 'idle';
  }

  async run(gcode: string): Promise<void> {
    if (!this.#s) return;
    try {
      this.acked = 0;
      this.line = -1;
      await this.#s.run(gcode);
    } catch (e) {
      this.message = e instanceof Error ? e.message : String(e);
    }
  }

  async send(line: string): Promise<void> {
    try {
      await this.#s?.send(line);
    } catch (e) {
      this.message = e instanceof Error ? e.message : String(e);
    }
  }

  hold = () => this.#s?.hold();
  resume = () => this.#s?.resume();
  stop = () => this.#s?.stop();
  feed = (cmd: 'feed100' | 'feedPlus10' | 'feedMinus10') => this.#s?.override(RT[cmd]);
}

export const machine = new Machine();
