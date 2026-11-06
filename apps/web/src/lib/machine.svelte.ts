/**
 * The connected controller: one streamer over Web Serial, its live status and the console.
 */
import { RT, SimGrbl, Streamer, type JobState, type ProbeResult, type Reply, type Status, type Transport } from '@swarf/grbl';
import { simWorld } from './simworld.ts';
import { store } from './store.svelte.ts';
import { openSerial, serialSupported } from './serial.ts';
import { openWebSocket } from './websocket.ts';

const URL_KEY = 'swarf.grblUrl';

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
  /** Network address of a grblHAL board (ws://host:81), remembered. */
  url = $state<string>((() => {
    try {
      return localStorage.getItem(URL_KEY) ?? '';
    } catch {
      return '';
    }
  })());
  #s: Streamer | null = null;
  /** The last probing result (machine coordinates as the controller reports them). */
  probe = $state<ProbeResult | null>(null);
  /** Connected to the simulated controller (the simulated camera and probe world go with it). */
  simulated = $state(false);

  #log(l: ConsoleLine): void {
    this.console = [...this.console.slice(-199), l];
  }

  /** Connect over USB (Web Serial), to `url` over the network, or to a simulated controller. */
  async connect(how: boolean | 'sim' = false, kind: 'lathe' | 'mill' = 'mill'): Promise<void> {
    if (this.#s) return;
    const network = how === true;
    try {
      let t: Transport & { label: string };
      if (how === 'sim') {
        // work zero somewhere in the travel, the tool waiting above the work
        const sim =
          kind === 'lathe'
            ? new SimGrbl({ lathe: true, wco: [-60, 0, -150], mpos: [-60 + 20, 0, -150 + 15] })
            : new SimGrbl({ wco: [-200, -120, -80], mpos: [-200 + 40, -120 + 25, -80 + 30] });
        // the simulated reality sits where this work zero was at the start
        simWorld.origin = [...sim.wco] as [number, number, number];
        sim.contact = (p) => simWorld.contact(store.job, p);
        // what the simulated camera sees: the machine where it really is (not the last status report), the laser as switched
        simWorld.truth = { pos: () => [...sim.pos] as [number, number, number], laser: () => sim.flood };
        this.simulated = true;
        t = sim;
      } else if (network) {
        const [address, protocol] = this.url.trim().split(/\s+/);
        if (!address) throw new Error('Give the controller\'s address, e.g. ws://192.168.1.50:81');
        try {
          localStorage.setItem(URL_KEY, this.url.trim());
        } catch {
          // not remembered
        }
        t = await openWebSocket(/^wss?:\/\//.test(address) ? address : `ws://${address}`, protocol);
      } else t = await openSerial();
      this.label = t.label;
      this.#s = new Streamer(t, {
        status: (s) => (this.status = s),
        probe: (p) => (this.probe = p),
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

  /** One line and the controller's answer to it (for routines that must know it went through). */
  async request(line: string): Promise<Reply> {
    if (!this.#s) return { ok: false, message: 'Not connected.' };
    try {
      return await this.#s.request(line);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async disconnect(): Promise<void> {
    await this.#s?.close();
    this.#s = null;
    this.connected = false;
    this.simulated = false;
    simWorld.truth = null;
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
  jogCancel = () => this.#s?.override(RT.jogCancel);
}

export const machine = new Machine();
if (typeof window !== "undefined") (window as unknown as { __swarfMachine?: Machine }).__swarfMachine = machine;
