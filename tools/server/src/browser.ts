/**
 * Opening the app: in Chrome or Edge if there is one, since only they can talk to a machine over
 * USB (Web Serial; the server does not open serial ports), else in the default browser.
 */
import { spawn, spawnSync } from 'node:child_process';

export interface BrowserCommand {
  name: string;
  cmd: string;
  args: string[];
  /** It has Web Serial (USB to the controller). */
  serial: boolean;
}

/** The ways to open `url`, best first, for this platform. */
export function browserCommands(platform: NodeJS.Platform, url: string): BrowserCommand[] {
  if (platform === 'darwin')
    return [
      { name: 'Chrome', cmd: 'open', args: ['-a', 'Google Chrome', url], serial: true },
      { name: 'Edge', cmd: 'open', args: ['-a', 'Microsoft Edge', url], serial: true },
      { name: 'Chromium', cmd: 'open', args: ['-a', 'Chromium', url], serial: true },
      { name: 'the default browser', cmd: 'open', args: [url], serial: false },
    ];
  if (platform === 'win32')
    // `start` finds chrome.exe and msedge.exe by their registered names; the URL quoted for cmd's sake
    return [
      { name: 'Chrome', cmd: 'cmd', args: ['/c', 'start', '""', 'chrome', `"${url}"`], serial: true },
      { name: 'Edge', cmd: 'cmd', args: ['/c', 'start', '""', 'msedge', `"${url}"`], serial: true },
      { name: 'the default browser', cmd: 'cmd', args: ['/c', 'start', '""', `"${url}"`], serial: false },
    ];
  return [
    ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].map((cmd) => ({ name: cmd, cmd, args: [url], serial: true })),
    { name: 'the default browser', cmd: 'xdg-open', args: [url], serial: false },
  ];
}

/** Is this way there? (macOS: the app is installed; Windows: the program is registered; Linux: the command is on the PATH.) */
function present(c: BrowserCommand, platform: NodeJS.Platform): boolean {
  if (!c.serial) return true;
  if (platform === 'darwin') return spawnSync('open', ['-Ra', c.args[1]!], { stdio: 'ignore' }).status === 0;
  if (platform === 'win32') {
    const exe = c.args[3] === 'chrome' ? 'chrome.exe' : 'msedge.exe';
    const key = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
    return spawnSync('reg', ['query', key], { stdio: 'ignore' }).status === 0 || spawnSync('reg', ['query', key.replace('HKLM', 'HKCU')], { stdio: 'ignore' }).status === 0;
  }
  return spawnSync('sh', ['-c', `command -v ${c.cmd}`], { stdio: 'ignore' }).status === 0;
}

/** Open `url` in the best browser there is; says which (and if it cannot reach a machine over USB). */
export function openBrowser(url: string, log: (msg: string) => void): void {
  const c = browserCommands(process.platform, url).find((b) => present(b, process.platform))!;
  log(c.serial ? `opening the app in ${c.name}` : `opening the app in the default browser; to connect a machine over USB, open it in Chrome or Edge`);
  spawn(c.cmd, c.args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' })
    .on('error', () => log(`could not open a browser; open ${url}`))
    .unref();
}
