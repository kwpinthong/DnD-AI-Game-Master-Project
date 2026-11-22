import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client.ts';
import { makeTempDir } from './helpers.ts';

/** GEN-078 Q-263: `phase_action.seq` — actions stored before the column get their number by creation order, per game. */

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;
const SEQ_MIGRATION = journal.entries.findIndex((e) => e.tag.endsWith('_phase_action_seq'));

function migrationsBefore(dir: string, count: number): string {
  const out = join(dir, 'drizzle-partial');
  mkdirSync(join(out, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return out;
}

describe('GEN-078 Q-263 migration: phase_action.seq', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it('backfills existing actions 1..n per game by creation order (submitted_at, then insert order)', () => {
    expect(SEQ_MIGRATION).toBeGreaterThan(0);
    const sqlite = new Database(join(dir, 'isekai.sqlite'));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: migrationsBefore(dir, SEQ_MIGRATION) });
      sqlite.pragma('foreign_keys = OFF');
      const add = sqlite.prepare(
        "insert into phase_action (game_id, day, phase, turn, member_id, text, visibility, rest, submitted_at) values (?, ?, 'EOSORIA', 1, ?, ?, 'public', 0, ?)",
      );
      // Inserted out of time order; two rows of g1 share a time (insert order breaks the tie).
      add.run('g1', 2, 'm-a', 'g1 ที่สาม', 300);
      add.run('g1', 1, 'm-b', 'g1 ที่หนึ่ง', 100);
      add.run('g2', 1, 'm-x', 'g2 ที่สอง', 250);
      add.run('g1', 1, 'm-a', 'g1 ที่สอง', 100);
      add.run('g2', 1, 'm-y', 'g2 ที่หนึ่ง', 50);

      migrate(drizzle(sqlite), { migrationsFolder });
      const rows = sqlite.prepare('select game_id as g, text, seq from phase_action order by game_id, seq').all();
      expect(rows).toEqual([
        { g: 'g1', text: 'g1 ที่หนึ่ง', seq: 1 },
        { g: 'g1', text: 'g1 ที่สอง', seq: 2 },
        { g: 'g1', text: 'g1 ที่สาม', seq: 3 },
        { g: 'g2', text: 'g2 ที่หนึ่ง', seq: 1 },
        { g: 'g2', text: 'g2 ที่สอง', seq: 2 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
