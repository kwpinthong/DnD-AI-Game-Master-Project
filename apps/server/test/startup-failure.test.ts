import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.ts';
import { freePort, isListening, makeTempDir } from './helpers.ts';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// C5: Given the DB path is not writable / When start / Then the server does not start
// and the error names the path at fault.
describe('start with an unusable database path', { timeout: 60_000 }, () => {
  let dir = '';
  let cleanup = () => {};

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });

  afterEach(() => {
    cleanup();
  });

  it('rejects and names the path when the data directory cannot be created', async () => {
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'a file where the data directory should be');
    const dataDir = join(blocker, 'data');
    const port = await freePort();

    const attempt = startServer({ host: '127.0.0.1', port, dbPath: join(dataDir, 'isekai.sqlite') });

    await expect(attempt).rejects.toThrow(join(dataDir, 'isekai.sqlite'));
    expect(await isListening(port)).toBe(false);
  });

  it('rejects and names the path when the DB file is read-only', async () => {
    const dbPath = join(dir, 'isekai.sqlite');
    writeFileSync(dbPath, '');
    chmodSync(dbPath, 0o444);
    const port = await freePort();

    try {
      await expect(startServer({ host: '127.0.0.1', port, dbPath })).rejects.toThrow(dbPath);
      expect(await isListening(port)).toBe(false);
    } finally {
      chmodSync(dbPath, 0o644);
    }
  });

  it('exits the process with code 1 and prints the path on stderr', async () => {
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, '');
    const dataDir = join(blocker, 'data');

    const result = spawnSync(process.execPath, ['src/index.ts'], {
      cwd: serverDir,
      env: { ...process.env, DB_PATH: join(dataDir, 'isekai.sqlite'), PORT: String(await freePort()), HOST: '127.0.0.1' },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(dataDir, 'isekai.sqlite'));
  });
});
