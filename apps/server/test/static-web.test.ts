import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

// One Railway service serves the API and the built web app from the same origin (Q-162).
describe('serving apps/web/dist', () => {
  let server: RunningServer | undefined;
  let cleanup = () => {};

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function start(withDist = true) {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    const dist = join(tmp.dir, 'dist');
    if (withDist) {
      mkdirSync(join(dist, 'assets'), { recursive: true });
      writeFileSync(join(dist, 'index.html'), '<!doctype html><title>isekai</title><div id="root"></div>');
      writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
      writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    }
    writeFileSync(join(tmp.dir, 'secret.txt'), 'TOP-SECRET');
    server = await startServer({ host: '127.0.0.1', port: 0, dbPath: join(tmp.dir, 'isekai.sqlite') }, { webDistDir: dist });
    return server;
  }

  /** GET with the path sent exactly as given (fetch would normalise `..`). */
  function raw(url: string, path: string): Promise<{ status: number; body: string }> {
    const { hostname, port } = new URL(url);
    return new Promise((resolve, reject) => {
      const req = request({ hostname, port, path, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('serves index.html at / without caching it', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('id="root"');
  });

  it('serves hashed assets with a long immutable cache and the right type', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const icon = await fetch(`${url}/favicon.svg`);
    expect(icon.headers.get('content-type')).toContain('image/svg+xml');
    expect(icon.headers.get('cache-control')).toBe('no-cache');
    await Promise.all([res.text(), icon.text()]);
  });

  it('falls back to index.html for page paths such as /admin', async () => {
    const { url } = await start();
    for (const path of ['/admin', '/some/deep/page']) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('id="root"');
    }
  });

  it('keeps /health and answers unknown /api paths with a 404 JSON, never index.html', async () => {
    const { url } = await start();
    expect((await (await fetch(`${url}/health`)).json()) as unknown).toEqual({ ok: true, db: 'connected' });
    for (const [method, path] of [['GET', '/api/nope'], ['POST', '/api/nope'], ['GET', '/api']] as const) {
      const res = await fetch(`${url}${path}`, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toMatchObject({ code: 'not_found' });
    }
  });

  it('answers 404 for a missing file with an extension (not index.html)', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/assets/missing.js`)).status).toBe(404);
  });

  it('does not read files outside dist (path traversal)', async () => {
    const { url } = await start();
    for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/assets/..%2f..%2fsecret.txt', '/%00']) {
      const res = await raw(url, path);
      expect(res.body).not.toContain('TOP-SECRET');
    }
  });

  it('still starts without a dist folder and answers 404 JSON', async () => {
    const { url } = await start(false);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
  });
});
