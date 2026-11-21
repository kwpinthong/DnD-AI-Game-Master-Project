import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

const journalPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', 'meta', '_journal.json');
const migrationCount = (JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] }).entries.length;

function readDb<T>(dbPath: string, query: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

const appliedMigrations = (dbPath: string) =>
  readDb(dbPath, (db) => (db.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n);

describe('database migrations at start', () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const start = async () => {
    server = await startServer({ host: '127.0.0.1', port: 0, dataDir });
    return server;
  };

  it('C3: creates the DB file and applies every migration when no DB exists', async () => {
    const dbPath = join(dataDir, 'isekai.sqlite');
    expect(existsSync(dbPath)).toBe(false);
    expect(migrationCount).toBeGreaterThan(0);

    const running = await start();
    await running.close();
    server = undefined;

    expect(running.dbPath).toBe(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    expect(running.migrationsApplied).toBe(migrationCount);
    expect(appliedMigrations(dbPath)).toBe(migrationCount);
    const tables = readDb(dbPath, (db) =>
      (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((t) => t.name),
    );
    expect(tables).toContain('app_meta');
  });

  it('C4: a second start applies nothing and keeps existing rows', async () => {
    const first = await start();
    first.db
      .prepare('insert into app_meta (key, value) values (?, ?)')
      .run('created_by', 'GEN-023 test');
    await first.close();

    const second = await start();
    await second.close();
    server = undefined;

    expect(second.migrationsApplied).toBe(0);
    expect(appliedMigrations(second.dbPath)).toBe(migrationCount);
    const rows = readDb(second.dbPath, (db) => db.prepare('select key, value from app_meta').all());
    expect(rows).toEqual([{ key: 'created_by', value: 'GEN-023 test' }]);
  });
});
