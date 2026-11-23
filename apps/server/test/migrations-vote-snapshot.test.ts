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
const index = journal.entries.findIndex((e) => e.tag.endsWith('_vote_snapshot'));

describe('migration vote_snapshot (GEN-189)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it('C4: is additive: no DROP, DELETE or ALTER … DROP', () => {
    expect(index).toBeGreaterThan(0);
    const code = readFileSync(join(migrationsFolder, `${journal.entries[index]!.tag}.sql`), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b/i);
  });

  it('C4: votes and pairs stored before the migration are all kept; the new table starts empty', () => {
    expect(index).toBeGreaterThan(0);
    const out = join(dir, 'drizzle-partial');
    mkdirSync(join(out, 'meta'), { recursive: true });
    const entries = journal.entries.slice(0, index);
    for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
    writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));

    const sqlite = new Database(join(dir, 'isekai.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: out });
    sqlite.prepare("insert into game (id, invite_code, name, created_at) values ('g1', 'ABC123', 'เกม', 1)").run();
    sqlite.prepare("insert into member (id, game_id, name, name_key, pin_hash, role, created_at) values ('m1', 'g1', 'm1', 'm1', 'x', 'player', 1)").run();
    sqlite.prepare("insert into response_vote (game_id, member_id, source_ref, vote, updated_at, reasons) values ('g1', 'm1', 'entry-3', 'down', 9, '[\"too_long\"]')").run();
    sqlite.prepare("insert into response_correction (game_id, entry_id, original, edited, scene, created_at) values ('g0', 7, 'เดิม', 'แก้', 'feed', 5)").run();
    const before = {
      votes: sqlite.prepare('select * from response_vote').all(),
      pairs: sqlite.prepare('select * from response_correction').all(),
      members: sqlite.prepare('select * from member').all(),
    };

    migrate(drizzle(sqlite), { migrationsFolder });
    expect({
      votes: sqlite.prepare('select * from response_vote').all(),
      pairs: sqlite.prepare('select * from response_correction').all(),
      members: sqlite.prepare('select * from member').all(),
    }).toEqual(before);
    expect(sqlite.prepare('select count(*) as n from vote_snapshot').get()).toEqual({ n: 0 });
    // No foreign key: a snapshot outlives its game.
    expect(sqlite.prepare("select * from pragma_foreign_key_list('vote_snapshot')").all()).toEqual([]);
    sqlite.close();
  });
});
