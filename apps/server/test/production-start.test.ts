import { CreateGameResponse, HealthResponse } from '@isekai/protocol';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/auth/pin.ts';
import { freePort, isListening, makeTempDir } from './helpers.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Railway's start command (.railway/railway.ts), run from the repo root like Railpack does. */
const START = ['apps/server/src/index.ts'];
const WEB = 'https://isekai-test.netlify.app';
const CREATE_CODE = 'test-create-code';
let createCodeHash = '';

/**
 * The environment Railway gives the service: NODE_ENV, PORT, the volume DB_PATH, WEB_ORIGIN and
 * CREATE_CODE_HASH (AI_PROVIDER=mock here, so no API key is needed); no HOST. A leftover BOOTSTRAP_INVITE_CODE from GEN-041a is set to show it does nothing.
 */
function railwayEnv(dbPath: string, port: number): NodeJS.ProcessEnv {
  const { HOST: _host, DB_PATH: _db, WEB_ORIGIN: _web, ...rest } = process.env;
  return { ...rest, NODE_ENV: 'production', PORT: String(port), DB_PATH: dbPath, WEB_ORIGIN: WEB, CREATE_CODE_HASH: createCodeHash, BOOTSTRAP_INVITE_CODE: 'TEST01', AI_PROVIDER: 'mock' };
}

/** `node apps/server/src/index.ts`: Node strips the types; no tsx at runtime. */
function startProduction(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(process.execPath, START, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  beforeAll(async () => {
    createCodeHash = await hashSecret(CREATE_CODE);
  });

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    if (child) await stop(child);
    child = undefined;
    cleanup();
  });

  // Q-169: spawns node twice (start waits ≤ 20 s each); slow under a full parallel `pnpm test`.
  it('serves /health on 0.0.0.0:$PORT, survives a hard restart and keeps the DB and sessions', { timeout: 60_000 }, async () => {
    const dbPath = join(dir, 'data', 'isekai.sqlite');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;

    child = await startProduction(railwayEnv(dbPath, port));
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(HealthResponse.parse(await health.json())).toEqual({ ok: true, db: 'connected' });
    const bootstrap = await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteCode: 'TEST01', name: 'Nok', pin: '1234' }),
    });
    expect(bootstrap.status).toBe(404);
    const created = await fetch(`${base}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB },
      body: JSON.stringify({ createCode: CREATE_CODE, gameName: 'test', mode: 'online', humanGm: false, name: 'Nok', pin: '1234' }),
    });
    expect(created.headers.get('access-control-allow-origin')).toBe(WEB);
    const { token } = CreateGameResponse.parse(await created.json());

    await stop(child);
    expect(existsSync(dbPath)).toBe(true);

    child = await startProduction(railwayEnv(dbPath, port));
    const again = await fetch(`${base}/health`);
    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });

    expect(again.status).toBe(200);
    expect(me.status).toBe(200);
  });

  it('exits 1 naming WEB_ORIGIN when it is missing, and nothing listens', { timeout: 60_000 }, async () => {
    const port = await freePort();
    const { WEB_ORIGIN: _omit, ...env } = railwayEnv(join(dir, 'isekai.sqlite'), port);

    const result = spawnSync(process.execPath, START, { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('WEB_ORIGIN');
    expect(await isListening(port)).toBe(false);
  });
});
