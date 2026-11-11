/**
 * Where in the app the user is: at the desk, working out the job with the assistant ("job"), or
 * at the machine, running it ("machine"). Kept between visits.
 */
export type Mode = 'job' | 'machine';

class Ui {
  mode = $state<Mode>('job');
  constructor() {
    try {
      if (localStorage.getItem('swarf.mode') === 'machine') this.mode = 'machine';
    } catch {
      // the default
    }
  }
  go(m: Mode): void {
    this.mode = m;
    try {
      localStorage.setItem('swarf.mode', m);
    } catch {
      // not kept
    }
  }
}

export const ui = new Ui();
