import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/** Which build this is, for the logs people send in. */
function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [svelte()],
  define: { __SWARF_BUILD__: JSON.stringify(`${commit()} ${new Date().toISOString().slice(0, 10)}`) },
  build: { target: 'es2022' },
});
