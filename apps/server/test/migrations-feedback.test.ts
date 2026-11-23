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
const index = journal.entries.findIndex((e) => e.tag.endsWith('_feedback'));

describe('migration feedback (ISK-010)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it('C13: is additive: no DROP, DELETE or ALTER', () => {
    expect(index).toBeGreaterThan(0);
    const code = readFileSync(join(migrationsFolder, `${journal.entries[index]!.tag}.sql`), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(code).toMatch(/CREATE TABLE `feedback`/);
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b|\balter\b/i);
  });

  it('C13: a DB with a game keeps all its data; the feedback tables start empty and have no foreign keys', () => {
    expect(index).toBeGreaterThan(0);
    const out = join(dir, 'drizzle-partial');
    mkdirSync(join(out, 'meta'), { recursive: true });
    const entries = journal.entries.slice(0, index);
    for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
    writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));

    const sqlite = new Database(join(dir, 'isekai.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: out });
    sqlite.prepare("insert into game (id, invite_code, name, created_at) values ('g1', 'ABC123', 'เกมเดิม', 1)").run();
    sqlite.prepare("insert into member (id, game_id, name, name_key, pin_hash, role, created_at) values ('m1', 'g1', 'นก', 'นก', 'x', 'player', 1)").run();
    sqlite.prepare("insert into game_phase (game_id, state, updated_at) values ('g1', '{}', 2)").run();
    const before = {
      games: sqlite.prepare('select * from game').all(),
      members: sqlite.prepare('select * from member').all(),
      phases: sqlite.prepare('select * from game_phase').all(),
    };

    migrate(drizzle(sqlite), { migrationsFolder });
    expect({
      games: sqlite.prepare('select * from game').all(),
      members: sqlite.prepare('select * from member').all(),
      phases: sqlite.prepare('select * from game_phase').all(),
    }).toEqual(before);
    expect(sqlite.prepare('select count(*) as n from feedback').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('select count(*) as n from feedback_audit').get()).toEqual({ n: 0 });
    // Kept for good: deleting a game never takes its reports with it.
    expect(sqlite.prepare("select * from pragma_foreign_key_list('feedback')").all()).toEqual([]);
    sqlite.close();
  });
});
