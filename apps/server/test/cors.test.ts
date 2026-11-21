import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

// Q-031: the web app is hosted on another origin (Netlify), so /health must allow that origin only.
describe('CORS for the web origin', () => {
  let server: RunningServer | undefined;
  let cleanup = () => {};

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function start() {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(tmp.dir, 'isekai.sqlite'),
      webOrigins: ['https://isekai.example.app'],
    });
    return server;
  }

  it('allows GET /health from the configured web origin', async () => {
    const { url } = await start();

    const res = await fetch(`${url}/health`, { headers: { Origin: 'https://isekai.example.app' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://isekai.example.app');
  });

  it('lets the web origin send the bearer token to /api/me (preflight)', async () => {
    const { url } = await start();

    const res = await fetch(`${url}/api/me`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://isekai.example.app',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });

    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://isekai.example.app');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  });

  it('does not allow an origin that is not configured', async () => {
    const { url } = await start();

    const res = await fetch(`${url}/health`, { headers: { Origin: 'https://evil.example.com' } });

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
