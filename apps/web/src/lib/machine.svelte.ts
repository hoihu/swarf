/**
 * The connected controller: one streamer over Web Serial, its live status and the console.
 */
import { Recorder, recorded } from './record.ts';
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
  /** The simulated machine ran into something (the last time, in words). */
  crash = $state('');
  /**
   * The probe input has been seen closed since connecting: the circuit works. (Probing with a
   * broken wire drives the cutter into the plate.) The simulated one always works.
   */
  probeTested = $state(false);
  /** The controller stopped answering (cable, power, network). */
  lost = $state(false);

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
            ? new SimGrbl({ lathe: true, wco: [-60, 0, -150], mpos: [-60 + 20, 0, -150 + 15], speed: simWorld.speed })
            : new SimGrbl({ wco: [-200, -120, -80], mpos: [-200 + 40, -120 + 25, -80 + 30], speed: simWorld.speed });
        // the simulated reality sits where this work zero was at the start
        simWorld.origin = [...sim.wco] as [number, number, number];
        sim.contact = (p) => simWorld.contact(store.job, p);
        // the simulated machine runs into things instead of stopping at them: say so
        simWorld.crashes = [];
        if (kind === 'mill')
          sim.onStep = (p, m) => {
            const n = simWorld.crashes.length;
            simWorld.watch(store.job, p, m.jog ? 'jog' : m.rapid ? 'rapid' : 'feed');
            const c = simWorld.crashes[n];
            if (c) {
              this.crash = `Simulated crash: the tool ran into the ${c.what} on a ${c.move} at X${(c.at[0] - sim.wco[0]).toFixed(1)} Y${(c.at[1] - sim.wco[1]).toFixed(1)} Z${(c.at[2] - sim.wco[2]).toFixed(1)}.`;
              this.record.ev(this.crash);
              this.#log({ dir: 'note', text: this.crash });
            }
          };
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
      this.record.ev(`connected: ${t.label}`);
      this.#s = new Streamer(recorded(t, this.record), {
        status: (s) => {
          // (the overrides come only with some reports: keep the last ones)
          this.status = s.ov || !this.status?.ov ? s : { ...s, ov: this.status.ov };
          if (s.pins?.includes('P')) this.probeTested = true;
        },
        probe: (p) => (this.probe = p),
        progress: (a, total, src) => {
          this.acked = a;
          this.total = total;
          // (a program started in the middle: its lines as numbered in the whole program)
          this.line = this.#lineMap ? (this.#lineMap[src] ?? src) : src;
        },
        job: (state, message) => {
          this.record.ev(`program: ${state}${message ? ` (${message})` : ''}`);
          this.job = state;
          if (message) {
            this.message = message;
            this.#log({ dir: 'note', text: message });
          } else if (state === 'running') this.message = '';
          if (state === 'paused') this.message = 'Held. Resume goes on; Stop ends the program.';
          if (state === 'waiting') this.message = 'Tool change: the program waits and the machine is free. Change the tool, carry the zero over to it ("Tool changes" under Setting up: a stored offset, the tool setter, or touch it off by hand), then Resume. The tool then rises straight up to the travel height before it goes anywhere.';
          if (state === 'done') this.message = 'Program finished.';
        },
        link: (lost) => {
          this.lost = lost;
          this.record.ev(lost ? 'the controller stopped answering' : 'the controller answers again');
          if (lost) this.#log({ dir: 'note', text: 'The controller does not answer any more.' });
        },
        log: (dir, text) => this.#log({ dir, text }),
      });
      this.connected = true;
      this.probeTested = how === 'sim';
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
    this.record.ev('disconnected');
    await this.#s?.close();
    this.#s = null;
    this.connected = false;
    this.simulated = false;
    this.lost = false;
    this.crash = '';
    this.probeTested = false;
    simWorld.truth = null;
    this.status = null;
    this.job = 'idle';
  }

  #lineMap: number[] | null = null;
  /**
   * `firstToolLoaded`: the user has just confirmed it, so the program's pause for loading it is
   * passed over. `lineMap`: for a program that is the rest of a longer one, each of its lines'
   * number in the whole one (so the G-code tab and the preview show the right place).
   */
  async run(gcode: string, firstToolLoaded = false, lineMap: number[] | null = null): Promise<void> {
    if (!this.#s) return;
    try {
      this.acked = 0;
      this.line = -1;
      this.#lineMap = lineMap;
      this.record.ev(`Run pressed: ${gcode.split('\n').length} lines${lineMap ? ', starting in the middle' : ''}${firstToolLoaded ? ', first tool already in' : ''}; job "${store.job.name}"`);
      await this.#s.run(gcode, { skipLeadingPause: firstToolLoaded });
    } catch (e) {
      this.message = e instanceof Error ? e.message : String(e);
      this.record.ev(`run refused: ${this.message}`);
    }
  }

  async send(line: string): Promise<void> {
    try {
      await this.#s?.send(line);
    } catch (e) {
      this.message = e instanceof Error ? e.message : String(e);
    }
  }

  /** A line for the console that is neither sent nor received. */
  note(text: string): void {
    this.record.ev(text);
    this.#log({ dir: 'note', text });
  }
  hold = () => this.#s?.hold();
  async resume(): Promise<void> {
    try {
      await this.#s?.resume();
    } catch (e) {
      this.message = e instanceof Error ? e.message : String(e);
    }
  }
  /** Stop everything: nothing more is sent, motion is held, then the controller reset (spindle off). */
  stop = () => {
    this.record.ev('Stop pressed');
    return this.#s?.stop();
  };

  feed = (cmd: 'feed100' | 'feedPlus10' | 'feedMinus10') => this.#s?.override(RT[cmd]);
  jogCancel = () => this.#s?.override(RT.jogCancel);

  /** Everything sent and received since the page was opened, with times (record.ts). */
  record = new Recorder();

  /**
   * The record as a text file's contents: what build and browser this is, the session, and at the
   * end the controller's settings and state (asked for now, when it is idle) and the job, so that
   * what happened can be followed and tried again elsewhere.
   */
  async logText(): Promise<string> {
    const idle = this.connected && this.status?.state === 'Idle' && this.job !== 'running' && this.job !== 'paused';
    if (idle) {
      this.record.ev('asked for the log: build info, settings, offsets and modes follow');
      for (const q of ['$I', '$$', '$#', '$G']) {
        try {
          await this.#s?.send(q);
        } catch {
          // whatever it answers is in the record
        }
      }
      await new Promise((r) => setTimeout(r, 700));
    } else this.record.ev(this.connected ? 'asked for the log while the controller was busy: its settings were not asked for' : 'asked for the log while not connected');
    const job = $state.snapshot(store.job);
    const head = [
      'swarf session log',
      `saved: ${new Date().toISOString()}`,
      `build: ${typeof __SWARF_BUILD__ === 'string' ? __SWARF_BUILD__ : 'dev'}`,
      `browser: ${navigator.userAgent}`,
      `connection: ${this.connected ? this.label : 'not connected'}${this.simulated ? ' (simulated)' : ''}`,
      `job: ${job.name} (${job.machine.kind}), ${job.operations.length} operations; checks: ${store.analysis.diagnostics.map((d) => d.code).join(' ') || 'clean'}`,
      'lines: seconds since the page was opened, > sent, < received, # what the app did. Status polls are left out; a status report repeated unchanged is counted.',
    ];
    return this.record.text(head, ['---- the job (File > Open a job reads this, saved on its own as .json) ----', JSON.stringify({ swarf: 'job', version: 1, job })]);
  }
  /** Spindle speed override (the controller keeps it between 10 and 200 %). */
  spindleOv = (cmd: 'spindle100' | 'spindlePlus10' | 'spindleMinus10' | 'spindlePlus1' | 'spindleMinus1') => this.#s?.override(RT[cmd]);
}

export const machine = new Machine();
if (typeof window !== "undefined") (window as unknown as { __swarfMachine?: Machine }).__swarfMachine = machine;
