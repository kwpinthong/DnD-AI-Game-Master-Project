import { HealthResponse } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

// C2: Given the server is running / When GET /health / Then 200 and the DB is reachable.
describe('GET /health', () => {
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
    server = await startServer({ host: '127.0.0.1', port: 0, dbPath: join(tmp.dir, 'isekai.sqlite') });
    return server;
  }

  it('answers 200 and reports the database as connected', async () => {
    const { url } = await start();

    const res = await fetch(`${url}/health`);

    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body).toEqual({ ok: true, db: 'connected' });
  });

  it('answers 503 with db "error" when the database stops answering', async () => {
    const running = await start();
    running.db.close();

    const res = await fetch(`${running.url}/health`);

    expect(res.status).toBe(503);
    expect(HealthResponse.parse(await res.json())).toEqual({ ok: false, db: 'error' });
  });
});
