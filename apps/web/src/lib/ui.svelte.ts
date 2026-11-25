/**
 * Where in the app the user is: at the desk, working out the job with the assistant ("job"), or
 * at the machine, running it ("machine"). Kept between visits.
 */
import { loadText, saveText } from './persist.ts';

export type Mode = 'job' | 'machine';

class Ui {
  mode = $state<Mode>('job');
  constructor() {
    if (loadText('swarf.mode') === 'machine') this.mode = 'machine';
  }
  go(m: Mode): void {
    this.mode = m;
    saveText('swarf.mode', m);
  }
}

export const ui = new Ui();
