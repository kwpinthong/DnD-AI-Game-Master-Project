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
const index = journal.entries.findIndex((e) => e.tag.endsWith('_dialogue_jobs'));

describe('migration dialogue_jobs (GEN-128)', () => {
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
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b/i);
  });

  it('a turn stored before the column has no dialogue left to redo', () => {
    const out = join(dir, 'drizzle-partial');
    mkdirSync(join(out, 'meta'), { recursive: true });
    const entries = journal.entries.slice(0, index);
    for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
    writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));

    const sqlite = new Database(join(dir, 'isekai.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: out });
    sqlite.prepare("insert into game (id, invite_code, name, created_at) values ('g1', 'ABC123', 'เกม', 1)").run();
    sqlite.prepare("insert into gm_turn (game_id, day, phase, turn, status, proposal, rolls, updated_at) values ('g1', 1, 'EOSORIA', 1, 'applied', '{}', '[]', 1)").run();

    migrate(drizzle(sqlite), { migrationsFolder });
    expect(sqlite.prepare('select status, dialogue from gm_turn').all()).toEqual([{ status: 'applied', dialogue: null }]);
    sqlite.close();
  });
});
