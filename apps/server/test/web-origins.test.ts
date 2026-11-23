import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { RunningServer } from '../src/server.ts';
import { startServer } from '../src/server.ts';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { makeTempDir } from './helpers.ts';
import { openRoom, type RoomClient } from './room-client.ts';
import { CREATE_CODE, startedTable } from './visibility-fixture.ts';

// GEN-133: two dev browsers on different origins (localhost and 127.0.0.1) can play on one dev server.
const A = 'http://localhost:5173';
const B = 'http://127.0.0.1:5173';

describe('GEN-133 several WEB_ORIGIN origins', { timeout: 60_000 }, () => {
  let server: RunningServer | undefined;
  let cleanup = () => {};
  const sockets: RoomClient[] = [];
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  it('C1: WS and CORS pass from both listed origins and a third origin is refused', async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    const config = loadConfig({ DB_PATH: `${tmp.dir}/isekai.sqlite`, PORT: '0', WEB_ORIGIN: `${A}, ${B}/` });
    expect(config.webOrigins).toEqual([A, B]);
    server = await startServer(config, { ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null });
    const url = server.url;
    for (const origin of [A, B]) {
      const res = await fetch(`${url}/health`, { headers: { Origin: origin } });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
    const evil = await fetch(`${url}/health`, { headers: { Origin: 'http://localhost:9999' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('C1: the room socket is accepted from both origins and 403 from a third', async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${tmp.dir}/isekai.sqlite`, webOrigins: [A, B], createCodeHash: await hashPin(CREATE_CODE) },
      { ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null },
    );
    const t = await startedTable(server, false);
    for (const origin of [A, B]) sockets.push(await openRoom(server, { token: t.a.token, headers: { origin } }));
    await expect(openRoom(server, { token: t.a.token, headers: { origin: 'http://localhost:9999' } })).rejects.toThrow();
  });

  it('C2: production keeps the strict rule (WEB_ORIGIN required, only what is listed, no wildcard)', () => {
    const prod = { NODE_ENV: 'production', DB_PATH: '/data/x.sqlite' };
    expect(() => loadConfig(prod)).toThrow(/WEB_ORIGIN/);
    expect(loadConfig({ ...prod, WEB_ORIGIN: 'https://x.netlify.app' }).webOrigins).toEqual(['https://x.netlify.app']);
    expect(() => loadConfig({ ...prod, WEB_ORIGIN: '*' })).toThrow(/WEB_ORIGIN/);
    expect(loadConfig({}).webOrigins).toEqual(['http://localhost:5173']);
  });
});
