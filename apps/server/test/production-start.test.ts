import { HealthResponse, JoinResponse } from '@isekai/protocol';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freePort, isListening, makeTempDir } from './helpers.ts';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = 'https://isekai-test.netlify.app';

/** The environment Railway gives the service: NODE_ENV, PORT, the volume DB_PATH and WEB_ORIGIN; no HOST. */
function railwayEnv(dbPath: string, port: number): NodeJS.ProcessEnv {
  const { HOST: _host, DB_PATH: _db, WEB_ORIGIN: _web, ...rest } = process.env;
  return { ...rest, NODE_ENV: 'production', PORT: String(port), DB_PATH: dbPath, WEB_ORIGIN: WEB, BOOTSTRAP_INVITE_CODE: 'TEST01' };
}

/** `pnpm start` of @isekai/server is `node src/index.ts` (Node strips the types; no tsx at runtime). */
function startProduction(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['src/index.ts'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('listening on')) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${out}`));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill(); // on Windows this is a hard kill, like a crash
  });
}

// C6 (local part): Given the service restarts / Then the DB file is still there and the server
// answers /health again by itself; C5: a session made before the restart is still valid.
describe('production start (NODE_ENV=production, node on src)', { timeout: 60_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let child: ChildProcess | undefined;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    if (child) await stop(child);
    child = undefined;
    cleanup();
  });

  it('serves /health on 0.0.0.0:$PORT, survives a hard restart and keeps the DB and sessions', async () => {
    const dbPath = join(dir, 'data', 'isekai.sqlite');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;

    child = await startProduction(railwayEnv(dbPath, port));
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(HealthResponse.parse(await health.json())).toEqual({ ok: true, db: 'connected' });
    const joined = await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB },
      body: JSON.stringify({ inviteCode: 'TEST01', name: 'Nok', pin: '1234' }),
    });
    expect(joined.headers.get('access-control-allow-origin')).toBe(WEB);
    const { token } = JoinResponse.parse(await joined.json());

    await stop(child);
    expect(existsSync(dbPath)).toBe(true);

    child = await startProduction(railwayEnv(dbPath, port));
    const again = await fetch(`${base}/health`);
    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });

    expect(again.status).toBe(200);
    expect(me.status).toBe(200);
  });

  it('exits 1 naming WEB_ORIGIN when it is missing, and nothing listens', async () => {
    const port = await freePort();
    const { WEB_ORIGIN: _omit, ...env } = railwayEnv(join(dir, 'isekai.sqlite'), port);

    const result = spawnSync(process.execPath, ['src/index.ts'], { cwd: serverDir, env, encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('WEB_ORIGIN');
    expect(await isListening(port)).toBe(false);
  });
});
