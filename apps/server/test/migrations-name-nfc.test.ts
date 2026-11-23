import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPin } from '../src/auth/pin.ts';
import { migrationsFolder } from '../src/db/client.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;

/** Where the GEN-106 migration sits; found by name because the dispatcher renumbers it at merge. */
const nfcIndex = journal.entries.findIndex((e) => e.tag.endsWith('_name_nfc'));

/** A migrations folder holding only the first `count` migrations, to build a DB at that point. */
function partialMigrations(dir: string, count: number): string {
  const out = join(dir, 'drizzle-partial');
  mkdirSync(join(out, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return out;
}

/** What GEN-025/GEN-018 stored: NFKC splits ำ (U+0E33) into ํ + า (U+0E4D U+0E32). */
const nfkc = (text: string) => text.normalize('NFKC');
const GAME_SPLIT = nfkc('เกมคำสาป');

describe('migration name_nfc (GEN-106 C3, C4, C5)', () => {
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

  /** A DB as production has it: pre-migration schema, members stored NFKC. */
  async function oldDb(): Promise<string> {
    const dbPath = join(dir, 'isekai.sqlite');
    const sqlite = new Database(dbPath);
    migrate(drizzle(sqlite), { migrationsFolder: partialMigrations(dir, nfcIndex) });
    const pin = await hashPin('1234');
    sqlite.prepare('insert into game (id, invite_code, name, created_at) values (?, ?, ?, ?)').run('g1', 'ABC123', GAME_SPLIT, 1);
    sqlite.prepare('insert into game (id, invite_code, name, created_at) values (?, ?, ?, ?)').run('g2', 'DEF456', 'Plain', 1);
    const add = sqlite.prepare(
      'insert into member (id, game_id, name, name_key, pin_hash, role, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    );
    add.run('m1', 'g1', nfkc('คำแก้ว'), nfkc('คำแก้ว'), pin, 'player', 2);
    add.run('m2', 'g1', 'Nok', 'nok', pin, 'player', 3);
    add.run('m3', 'g1', 'ลิน', 'ลิน', pin, 'gm', 4);
    // Collision: the split name and the composed name of the same word in one game.
    add.run('m4', 'g2', nfkc('ทำ'), nfkc('ทำ'), pin, 'player', 5);
    add.run('m5', 'g2', 'ทำ', 'ทำ', pin, 'player', 6);
    sqlite.close();
    return dbPath;
  }

  it('exists', () => {
    expect(nfcIndex).toBeGreaterThan(0);
  });

  it('C3: boots on a copy of an old DB, joins split ำ, keeps every row, skips a colliding pair', { timeout: 60_000 }, async () => {
    const dbPath = await oldDb();
    server = await startServer({ host: '127.0.0.1', port: 0, dbPath });
    expect((await fetch(`${server.url}/health`)).status).toBe(200);

    expect(server.db.prepare('select id, name, name_key, role, created_at from member order by id').all()).toEqual([
      { id: 'm1', name: 'คำแก้ว', name_key: 'คำแก้ว', role: 'player', created_at: 2 },
      { id: 'm2', name: 'Nok', name_key: 'nok', role: 'player', created_at: 3 },
      { id: 'm3', name: 'ลิน', name_key: 'ลิน', role: 'gm', created_at: 4 },
      // m4 would collide with m5: both stay as they were.
      { id: 'm4', name: nfkc('ทำ'), name_key: nfkc('ทำ'), role: 'player', created_at: 5 },
      { id: 'm5', name: 'ทำ', name_key: 'ทำ', role: 'player', created_at: 6 },
    ]);
    expect(server.db.prepare('select id, name from game order by id').all()).toEqual([
      { id: 'g1', name: 'เกมคำสาป' },
      { id: 'g2', name: 'Plain' },
    ]);

    // C4: a new member typing the migrated name is the same member (no second row; wrong PIN refused).
    const join = (name: string, pin: string) =>
      fetch(`${server!.url}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteCode: 'ABC123', name, pin }),
      });
    expect((await join('คำแก้ว', '9999')).status).not.toBe(200);
    expect((server.db.prepare('select count(*) as n from member where game_id = ?').get('g1') as { n: number }).n).toBe(3);
    // C5: the old name + old PIN still enters the same member, typed composed or split.
    for (const typed of ['คำแก้ว', nfkc('คำแก้ว')]) {
      const res = await join(typed, '1234');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { created: boolean; member: { id: string; name: string } };
      expect(body.created).toBe(false);
      expect(body.member).toMatchObject({ id: 'm1', name: 'คำแก้ว' });
    }
  });

  it('is idempotent: running its SQL again changes nothing', { timeout: 60_000 }, async () => {
    const dbPath = await oldDb();
    server = await startServer({ host: '127.0.0.1', port: 0, dbPath });
    const snapshot = () => JSON.stringify([server!.db.prepare('select * from member').all(), server!.db.prepare('select * from game').all()]);
    const before = snapshot();
    const entry = journal.entries[nfcIndex]!;
    const sql = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) server.db.exec(statement);
    expect(snapshot()).toBe(before);
  });
});
