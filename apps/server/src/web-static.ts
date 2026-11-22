import type { FastifyInstance } from 'fastify';
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const NOT_FOUND = { code: 'not_found', message: 'ไม่พบหน้านี้' };

function fileAt(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * One service for the API and the built web app (Q-162): serves `dist` at /, the page shell (index.html) for
 * every other GET that is not /api or /health, and a JSON 404 for unknown /api paths. Vite's hashed files
 * under /assets/ are cached for a year, everything else (index.html included) is revalidated. The folder is
 * read per request, so the server starts without it (then every unknown path is a JSON 404).
 */
export function registerWebStatic(app: FastifyInstance, distDir: string): void {
  const root = resolve(distDir);

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    const api = path === '/api' || path.startsWith('/api/') || path === '/health';
    if (api || (request.method !== 'GET' && request.method !== 'HEAD')) return reply.code(404).send(NOT_FOUND);

    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return reply.code(404).send(NOT_FOUND);
    }
    // Refuse anything that could leave `root`: encoded separators, NUL, and a resolved path outside it.
    const target = resolve(root, `.${decoded}`);
    const inside = !decoded.includes('\0') && !decoded.includes('\\') && (target === root || target.startsWith(root + sep));

    let file: string | undefined;
    if (inside && fileAt(target)) file = target;
    else if (!extname(decoded)) file = resolve(root, 'index.html'); // a page path: the SPA decides
    if (!file || !fileAt(file)) return reply.code(404).send(NOT_FOUND);

    const hashed = file.startsWith(resolve(root, 'assets') + sep);
    return reply
      .header('content-type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
      .header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(createReadStream(file));
  });
}
