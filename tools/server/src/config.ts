/**
 * ~/.swarf/server.json: the access key that lets the app tab connect. Created on first start,
 * readable only by the user. SWARF_HOME moves the directory (tests).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  accessKey: string;
}

export const configDir = () => process.env.SWARF_HOME ?? join(homedir(), '.swarf');
export const configPath = () => join(configDir(), 'server.json');

export function loadConfig(): Config {
  const path = configPath();
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    if (typeof c.accessKey === 'string' && c.accessKey.length >= 16) return { accessKey: c.accessKey };
  } catch {
    // missing or unreadable: write a new one
  }
  const cfg: Config = { accessKey: randomUUID() };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return cfg;
}

/** The built app (apps/web/dist) of this checkout, if it has been built. */
export function appDir(): string | null {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/web/dist');
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

/** The dev server's address (npm run dev). */
export const DEV_APP = 'http://localhost:5173';
