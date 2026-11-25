/**
 * What this browser keeps between visits: the one place that reads and writes localStorage.
 * Storage can be missing (private window), full or hold something unreadable: reads then give the
 * default and writes are dropped, and the session goes on with what it has.
 */

/** The text kept under `key` (null: none, or storage unavailable). */
export function loadText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveText(key: string, text: string): void {
  try {
    localStorage.setItem(key, text);
  } catch {
    // not kept: it stays for this visit
  }
}

/** The JSON value kept under `key`, or `fallback` when there is none or it does not parse. Not checked: callers validate what they rely on. */
export function load<T>(key: string, fallback: T): T {
  const raw = loadText(key);
  if (raw === null) return fallback;
  try {
    return (JSON.parse(raw) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  saveText(key, JSON.stringify(value));
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing to forget
  }
}
