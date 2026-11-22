import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;

/** A migrations folder holding only the first `count` migrations, to build a DB at that point. */
function partialMigrations(dir: string, count: number): string {
  const out = join(dir, 'drizzle-partial');
  mkdirSync(join(out, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return out;
}

describe('migrations from the DB deployed on Railway (0000 + 0001)', () => {
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

  it('migration tags are numbered in order with no duplicate number', () => {
    const numbers = journal.entries.map((e) => e.tag.slice(0, 4));
    expect(numbers).toEqual(journal.entries.map((_, i) => String(i).padStart(4, '0')));
  });

  // Q-169: starts the real server twice on a migrated file DB; slow under a full parallel `pnpm test`.
  it('applies every later migration once and keeps existing game/member/session rows', { timeout: 60_000 }, async () => {
    const dbPath = join(dir, 'isekai.sqlite');
    const sqlite = new Database(dbPath);
    migrate(drizzle(sqlite), { migrationsFolder: partialMigrations(dir, 2) });
    sqlite.prepare('insert into game (id, invite_code, created_at) values (?, ?, ?)').run('g1', 'ABC123', 1);
    sqlite
      .prepare('insert into member (id, game_id, name, name_key, pin_hash, created_at) values (?, ?, ?, ?, ?, ?)')
      .run('m1', 'g1', 'Nok', 'nok', 'hash', 2);
    sqlite.prepare('insert into session (token_hash, member_id, created_at, expires_at) values (?, ?, ?, ?)').run('t1', 'm1', 3, 4);
    sqlite.close();

    server = await startServer({ host: '127.0.0.1', port: 0, dbPath });
    expect(server.migrationsApplied).toBe(journal.entries.length - 2);
    const db = server.db;
    expect((db.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n).toBe(
      journal.entries.length,
    );
    expect(db.prepare('select id, invite_code from game').all()).toEqual([{ id: 'g1', invite_code: 'ABC123' }]);
    expect(db.prepare('select id, name, role, kicked_at from member').all()).toEqual([
      { id: 'm1', name: 'Nok', role: 'player', kicked_at: null },
    ]);
    expect(db.prepare('select token_hash, member_id from session').all()).toEqual([{ token_hash: 't1', member_id: 'm1' }]);
    await server.close();

    server = await startServer({ host: '127.0.0.1', port: 0, dbPath });
    expect(server.migrationsApplied).toBe(0);
  });
});
