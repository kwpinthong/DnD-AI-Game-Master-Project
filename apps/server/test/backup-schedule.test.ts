import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrityProblems, listBackups, tableCounts } from '../src/backup/backup.ts';
import { loadConfig } from '../src/config.ts';
import { loadAiConfig } from '../src/ai/config.ts';
import type { BackupConfig } from '../src/backup/schedule.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { startTestServer } from './visibility-fixture.ts';

function startWithBackup(dir: string, backup: BackupConfig): Promise<RunningServer> {
  return startServer(
    { host: '127.0.0.1', port: 0, dbPath: join(dir, 'isekai.sqlite'), backup },
    { ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, backupLog: () => {} },
  );
}

/** GEN-037: the backup job inside the server (interval + retention + one at shutdown) and the backup / restore CLIs. */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('backup config (env)', () => {
  const prod = { NODE_ENV: 'production', WEB_ORIGIN: 'https://x.netlify.app', DB_PATH: '/data/isekai.sqlite' };

  it('defaults: every 6 hours, keep 28 (7 days), next to the DB in backups/', () => {
    const config = loadConfig(prod);
    expect(config.backup).toEqual({ dir: join(dirname(config.dbPath), 'backups'), intervalMs: 6 * 3_600_000, keep: 28 });
  });

  it('BACKUP_DIR, BACKUP_INTERVAL_HOURS and BACKUP_KEEP change it; interval 0 turns it off', () => {
    const config = loadConfig({ ...prod, BACKUP_DIR: '/data/elsewhere', BACKUP_INTERVAL_HOURS: '0.5', BACKUP_KEEP: '3' });
    expect(config.backup).toMatchObject({ intervalMs: 1_800_000, keep: 3 });
    expect(config.backup?.dir.replace(/\\/g, '/')).toMatch(/\/data\/elsewhere$/);
    expect(loadConfig({ ...prod, BACKUP_INTERVAL_HOURS: '0' }).backup).toBeUndefined();
  });

  it.each([
    ['BACKUP_INTERVAL_HOURS', 'often'],
    ['BACKUP_INTERVAL_HOURS', '-1'],
    ['BACKUP_KEEP', '0'],
    ['BACKUP_KEEP', '2.5'],
  ])('refuses %s=%s with the variable name', (name, value) => {
    expect(() => loadConfig({ ...prod, [name]: value })).toThrow(name);
  });
});

describe('backup job in the server', { timeout: 60_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function boot(intervalMs: number, keep: number) {
    const backups = join(dir, 'backups');
    server = await startWithBackup(dir, { dir: backups, intervalMs, keep });
    return backups;
  }

  it('takes one at start when there is none, then one per interval, keeping only `keep`', async () => {
    const backups = await boot(150, 2);
    await until(() => listBackups(backups).length >= 1);
    await until(() => (server!.backups?.taken() ?? 0) >= 4);
    expect(listBackups(backups)).toHaveLength(2);
    for (const file of listBackups(backups)) expect(integrityProblems(file)).toEqual([]);
  });

  it('takes a last one when the server shuts down', async () => {
    const backups = await boot(3_600_000, 5);
    await until(() => listBackups(backups).length === 1);
    server!.db.prepare("insert into app_meta (key, value) values ('gen037', 'after-first-backup')").run();
    await server!.close();
    server = undefined;
    const latest = listBackups(backups);
    expect(latest).toHaveLength(2);
    const copy = new Database(latest[0]!, { readonly: true });
    try {
      expect(copy.prepare("select value from app_meta where key = 'gen037'").get()).toEqual({ value: 'after-first-backup' });
    } finally {
      copy.close();
    }
  });

  it('does not take one at start when the newest is younger than the interval', async () => {
    const backups = await boot(3_600_000, 5);
    await until(() => listBackups(backups).length === 1);
    await server!.close(); // + the shutdown one = 2
    server = await startWithBackup(dir, { dir: backups, intervalMs: 3_600_000, keep: 5 });
    await new Promise((r) => setTimeout(r, 300));
    expect(listBackups(backups)).toHaveLength(2);
  });
});

describe('backup / restore CLIs', { timeout: 60_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const run = (script: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [`apps/server/src/backup/${script}`, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });

  it('db:backup copies the DB of a running server into BACKUP_DIR; db:restore makes a new DB with the same counts', async () => {
    server = await startTestServer(dir);
    const backups = join(dir, 'manual');
    const made = run('backup-cli.ts', [], { DB_PATH: server.dbPath, BACKUP_DIR: backups });
    expect(made.status, made.stderr).toBe(0);
    const [file] = listBackups(backups);
    expect(file).toBeDefined();
    expect(made.stdout).toContain(file!);

    const target = join(dir, 'restored.sqlite');
    const restored = run('restore-cli.ts', [file!, target]);
    expect(restored.status, restored.stderr).toBe(0);
    expect(existsSync(target)).toBe(true);
    const copy = new Database(target, { readonly: true });
    try {
      expect(tableCounts(copy)).toEqual(tableCounts(server.db));
    } finally {
      copy.close();
    }
    expect(restored.stdout).toContain('member');

    const again = run('restore-cli.ts', [file!, target]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already exists');
    expect(run('restore-cli.ts', []).status).toBe(1);
  });
});
