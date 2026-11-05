/**
 * Parsing what grbl/grblHAL says: status reports, ok/error, alarms, messages, the welcome line.
 * See the grbl 1.1 interface docs; grblHAL keeps the same format and adds fields we ignore.
 */

export type MachineState = 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep' | 'Tool' | 'Unknown';

export interface Status {
  state: MachineState;
  /** Sub-state, e.g. Hold:0 (complete) / Hold:1 (in progress). */
  sub?: number;
  /** Work position (computed from MPos − WCO when the controller reports MPos). */
  wpos?: [number, number, number];
  mpos?: [number, number, number];
  feed?: number;
  spindle?: number;
  /** Overrides in percent: feed, rapid, spindle. */
  ov?: [number, number, number];
  /** Planner blocks / RX bytes free. */
  buf?: [number, number];
  pins?: string;
}

export type Incoming =
  | { kind: 'ok' }
  | { kind: 'error'; code: number }
  | { kind: 'alarm'; code: number }
  | { kind: 'status'; status: Status }
  | { kind: 'welcome'; text: string }
  | { kind: 'msg'; text: string }
  | { kind: 'other'; text: string };

const xyz = (s: string): [number, number, number] | undefined => {
  const n = s.split(',').map(Number);
  return n.length >= 3 && n.slice(0, 3).every(Number.isFinite) ? [n[0]!, n[1]!, n[2]!] : undefined;
};

/** One status report `<Idle|MPos:0.000,0.000,0.000|FS:0,0|…>`; `wco` is the last work offset seen. */
export function parseStatus(line: string, wco?: [number, number, number]): { status: Status; wco?: [number, number, number] } | null {
  const m = /^<([^>]*)>$/.exec(line.trim());
  if (!m) return null;
  const [head, ...fields] = m[1]!.split('|');
  const [state, sub] = head!.split(':');
  const known = ['Idle', 'Run', 'Hold', 'Jog', 'Alarm', 'Door', 'Check', 'Home', 'Sleep', 'Tool'];
  const status: Status = { state: (known.includes(state!) ? state : 'Unknown') as MachineState };
  if (sub !== undefined && sub !== '') status.sub = Number(sub);
  let newWco = wco;
  for (const f of fields) {
    const i = f.indexOf(':');
    const key = i < 0 ? f : f.slice(0, i);
    const val = i < 0 ? '' : f.slice(i + 1);
    switch (key) {
      case 'MPos': {
        const p = xyz(val);
        if (p) status.mpos = p;
        break;
      }
      case 'WPos': {
        const p = xyz(val);
        if (p) status.wpos = p;
        break;
      }
      case 'WCO': {
        const p = xyz(val);
        if (p) newWco = p;
        break;
      }
      case 'FS':
      case 'F': {
        const [feed, spindle] = val.split(',').map(Number);
        if (Number.isFinite(feed)) status.feed = feed!;
        if (Number.isFinite(spindle)) status.spindle = spindle!;
        break;
      }
      case 'Ov': {
        const o = xyz(val);
        if (o) status.ov = o;
        break;
      }
      case 'Bf': {
        const [a, b] = val.split(',').map(Number);
        if (Number.isFinite(a) && Number.isFinite(b)) status.buf = [a!, b!];
        break;
      }
      case 'Pn':
        status.pins = val;
        break;
    }
  }
  if (!status.wpos && status.mpos && newWco) status.wpos = [status.mpos[0] - newWco[0], status.mpos[1] - newWco[1], status.mpos[2] - newWco[2]];
  return newWco ? { status, wco: newWco } : { status };
}

export function classify(line: string, wco?: [number, number, number]): { incoming: Incoming; wco?: [number, number, number] } {
  const t = line.trim();
  if (t === 'ok') return { incoming: { kind: 'ok' } };
  let m = /^error:(\d+)/i.exec(t);
  if (m) return { incoming: { kind: 'error', code: Number(m[1]) } };
  m = /^ALARM:(\d+)/i.exec(t);
  if (m) return { incoming: { kind: 'alarm', code: Number(m[1]) } };
  const s = parseStatus(t, wco);
  if (s) return { incoming: { kind: 'status', status: s.status }, ...(s.wco ? { wco: s.wco } : {}) };
  if (/^Grbl(HAL)?\s/i.test(t)) return { incoming: { kind: 'welcome', text: t } };
  m = /^\[MSG:(.*)\]$/.exec(t);
  if (m) return { incoming: { kind: 'msg', text: m[1]! } };
  return { incoming: { kind: 'other', text: t } };
}

/** The common grbl error and alarm codes, for messages a person can act on. */
export const ERRORS: Record<number, string> = {
  1: 'G-code word without a letter',
  2: 'bad number format',
  3: 'unknown $ command',
  9: 'locked by an alarm: unlock ($X) or home first',
  15: 'jog target outside the soft limits',
  20: 'unsupported G-code command',
  22: 'feed rate not set',
  33: 'invalid target for this motion',
  38: 'tool number too large',
};

export const ALARMS: Record<number, string> = {
  1: 'hard limit triggered: position lost, re-home',
  2: 'motion target outside the soft limits',
  3: 'reset while in motion: position lost, re-home',
  4: 'probe fail',
  6: 'homing failed: reset during the cycle',
  8: 'homing failed: could not clear the limit switch',
  9: 'homing failed: limit switch not found',
  10: 'emergency stop',
};
