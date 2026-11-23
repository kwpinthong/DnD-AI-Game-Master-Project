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
const copyIndex = journal.entries.findIndex((e) => e.tag.endsWith('_ruling_vote_copy'));
const sqlOf = (i: number) => readFileSync(join(migrationsFolder, `${journal.entries[i]!.tag}.sql`), 'utf8').replace(/\r\n/g, '\n');

function partialMigrations(dir: string, count: number): string {
  const out = join(dir, 'drizzle-partial');
  mkdirSync(join(out, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return out;
}

describe('migration ruling_vote_copy (GEN-171 C7)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it('is additive: no DROP, DELETE or ALTER … DROP', () => {
    expect(copyIndex).toBeGreaterThan(0);
    const code = sqlOf(copyIndex)
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b/i);
  });

  it('C7: 3 old ruling_vote rows become 3 response_vote rows vote = up, ref ruling-…; the old rows stay', () => {
    const sqlite = new Database(join(dir, 'isekai.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: partialMigrations(dir, copyIndex) });
    sqlite.prepare('insert into game (id, invite_code, name, created_at) values (?, ?, ?, ?)').run('g1', 'ABC123', 'เกม', 1);
    const add = sqlite.prepare("insert into member (id, game_id, name, name_key, pin_hash, role, created_at) values (?, 'g1', ?, ?, 'x', 'player', 1)");
    for (const m of ['m1', 'm2']) add.run(m, m, m);
    const like = sqlite.prepare("insert into ruling_vote (game_id, member_id, source_ref, created_at) values ('g1', ?, ?, ?)");
    like.run('m1', '1-EOSORIA-1-1', 10);
    like.run('m2', '1-EOSORIA-1-1', 11);
    like.run('m1', '3-NOCTHERION-2-4', 12);
    // A newer vote already in response_vote is kept as it is.
    sqlite.prepare("insert into response_vote values ('g1', 'm2', 'entry-5', 'down', 9)").run();

    migrate(drizzle(sqlite), { migrationsFolder });
    expect(sqlite.prepare("select member_id, source_ref, vote, updated_at from response_vote where source_ref like 'ruling-%' order by updated_at").all()).toEqual([
      { member_id: 'm1', source_ref: 'ruling-1-EOSORIA-1-1', vote: 'up', updated_at: 10 },
      { member_id: 'm2', source_ref: 'ruling-1-EOSORIA-1-1', vote: 'up', updated_at: 11 },
      { member_id: 'm1', source_ref: 'ruling-3-NOCTHERION-2-4', vote: 'up', updated_at: 12 },
    ]);
    expect(sqlite.prepare("select vote from response_vote where source_ref = 'entry-5'").get()).toEqual({ vote: 'down' });
    expect((sqlite.prepare('select count(*) as n from ruling_vote').get() as { n: number }).n).toBe(3);

    // Running its SQL again changes nothing.
    sqlite.exec(sqlOf(copyIndex));
    expect((sqlite.prepare('select count(*) as n from response_vote').get() as { n: number }).n).toBe(4);
    sqlite.close();
  });
});
