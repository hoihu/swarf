import { describe, expect, it } from 'vitest';
import { browserCommands } from '../src/browser.ts';

describe('opening the app in a browser that can reach the machine over USB (Web Serial)', () => {
  const url = 'http://localhost:7790/#connect=k@7790';
  it('tries Chrome first, then Edge, then the default browser (macOS)', () => {
    const c = browserCommands('darwin', url);
    expect(c[0]).toEqual({ name: 'Chrome', cmd: 'open', args: ['-a', 'Google Chrome', url], serial: true });
    expect(c[1]!.name).toBe('Edge');
    expect(c.at(-1)).toEqual({ name: 'the default browser', cmd: 'open', args: [url], serial: false });
  });
  it('on Windows starts Chrome or Edge by name through the shell', () => {
    const c = browserCommands('win32', url);
    expect(c[0]!.args).toEqual(['/c', 'start', '""', 'chrome', `"${url}"`]);
    expect(c[1]!.args).toContain('msedge');
  });
  it('on Linux looks for the Chrome, Chromium and Edge commands', () => {
    const names = browserCommands('linux', url).map((c) => c.cmd);
    expect(names.slice(0, 4)).toEqual(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
    expect(names.at(-1)).toBe('xdg-open');
  });
});
