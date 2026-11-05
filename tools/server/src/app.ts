/**
 * Serves the built app (apps/web/dist) so the page and the server share localhost. Static files
 * only; anything that is not a file gets index.html.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

export function appHandler(dir: string | null) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (!dir) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('The app is not built: run npm run build, or open the dev server (npm run dev).');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) && file !== dir) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) file = join(dir, 'index.html');
    } catch {
      file = join(dir, 'index.html');
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'max-age=31536000, immutable' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
