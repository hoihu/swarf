import { afterEach, describe, expect, it, vi } from 'vitest';
import { load, loadText, remove, save, saveText } from '../src/lib/persist.ts';

function fakeStorage(): Map<string, string> {
  const m = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the browser keeps', () => {
  it('a missing or unparsable value gives the default', () => {
    const m = fakeStorage();
    expect(load('swarf.none', { a: 1 })).toEqual({ a: 1 });
    m.set('swarf.bad', '{not json');
    expect(load('swarf.bad', [])).toEqual([]);
    m.set('swarf.null', 'null');
    expect(load('swarf.null', 'x')).toBe('x');
  });

  it('a value comes back as it was saved, JSON or plain text', () => {
    const m = fakeStorage();
    save('swarf.view', { lathe: { d: [1, 2, 3] } });
    expect(load('swarf.view', {})).toEqual({ lathe: { d: [1, 2, 3] } });
    saveText('swarf.mode', 'machine');
    expect(m.get('swarf.mode')).toBe('machine');
    expect(loadText('swarf.mode')).toBe('machine');
    remove('swarf.mode');
    expect(loadText('swarf.mode')).toBeNull();
  });

  it('storage that is not there or refuses writes changes nothing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(load('swarf.job', 7)).toBe(7);
    expect(loadText('swarf.mode')).toBeNull();
    expect(() => save('swarf.job', {})).not.toThrow();
    expect(() => remove('swarf.job')).not.toThrow();
  });
});
