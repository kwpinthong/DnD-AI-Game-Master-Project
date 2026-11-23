import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client.ts';
import { makeTempDir } from './helpers.ts';

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;
/** Found by name because the dispatcher may renumber it at merge. */
const index = journal.entries.findIndex((e) => e.tag.endsWith('_late_join'));

describe('migration late_join (ISK-015 C16)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it('is additive: no DROP, DELETE or ALTER … DROP', () => {
    expect(index).toBeGreaterThan(0);
    const code = readFileSync(join(migrationsFolder, `${journal.entries[index]!.tag}.sql`), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    // `ON DELETE cascade` of a new table's foreign key is fine; a DELETE statement is not.
    expect(code).not.toMatch(/\bdrop\b|\bdelete\s+from\b|\balter\b/i);
  });

  it('a started game from before keeps its members and state; nobody is a late joiner', () => {
    expect(index).toBeGreaterThan(0);
    const out = join(dir, 'drizzle-partial');
    mkdirSync(join(out, 'meta'), { recursive: true });
    const entries = journal.entries.slice(0, index);
    for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
    writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));

    const sqlite = new Database(join(dir, 'isekai.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: out });
    sqlite.prepare("insert into game (id, invite_code, name, started_at, created_at) values ('g1', 'ABC123', 'เกม', 5, 1)").run();
    sqlite.prepare("insert into member (id, game_id, name, name_key, pin_hash, role, created_at) values ('m1', 'g1', 'm1', 'm1', 'x', 'player', 1)").run();
    sqlite.prepare("insert into game_phase (game_id, state, updated_at) values ('g1', '{\"day\":4}', 9)").run();
    const before = { members: sqlite.prepare('select * from member').all(), phase: sqlite.prepare('select * from game_phase').all() };

    migrate(drizzle(sqlite), { migrationsFolder });
    // toMatchObject: later migrations may add columns (ISK-017 ready_at); every old value must stay.
    expect({ members: sqlite.prepare('select * from member').all(), phase: sqlite.prepare('select * from game_phase').all() }).toMatchObject(before);
    expect(sqlite.prepare('select count(*) as n from late_join').get()).toEqual({ n: 0 });
    sqlite.close();
  });
});
