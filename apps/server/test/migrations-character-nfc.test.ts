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

/** Where the GEN-094 migration sits; found by name because the dispatcher renumbers it at merge. */
const nfcIndex = journal.entries.findIndex((e) => e.tag.endsWith('_character_nfc'));

/** A migrations folder holding only the first `count` migrations, to build a DB at that point. */
function partialMigrations(dir: string, count: number): string {
  const out = join(dir, 'drizzle-partial');
  mkdirSync(join(out, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return out;
}

/** What GEN-047 stored: NFKC splits ำ (U+0E33) into ํ + า (U+0E4D U+0E32). */
const nfkc = (text: string) => text.normalize('NFKC');

describe('migration character_nfc (GEN-094 C2)', () => {
  let dir = '';
  let cleanup = () => {};
  let sqlite: Database.Database | undefined;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
    cleanup();
  });

  it('exists', () => {
    expect(nfcIndex).toBeGreaterThan(0);
  });

  it('turns NFKC character text back into NFC and leaves every other value alone', () => {
    sqlite = new Database(join(dir, 'isekai.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: partialMigrations(dir, nfcIndex) });
    sqlite.prepare('insert into game (id, invite_code, created_at) values (?, ?, ?)').run('g1', 'ABC123', 1);
    const addMember = sqlite.prepare(
      'insert into member (id, game_id, name, name_key, pin_hash, created_at) values (?, ?, ?, ?, ?, ?)',
    );
    addMember.run('m1', 'g1', nfkc('คำแก้ว'), nfkc('คำแก้ว'), 'hash', 2);
    addMember.run('m2', 'g1', 'ลิน', 'ลิน', 'hash', 2);
    const addCharacter = sqlite.prepare(
      `insert into character (member_id, created_at, name, appearance, personality, hp, hp_max, karma, coins, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    addCharacter.run('m1', 10, nfkc('คำแก้ว'), nfkc('ผิวคล้ำ ตาดำ\nผมสั้น'), nfkc('ทำอะไรช้า แต่จำแม่น ก่ำ'), 87, 120, -3, 15, 20);
    addCharacter.run('m2', 11, 'ลิน', 'ผ้าคลุมเทา', 'พูดน้อย', 100, 100, 0, 0, null);
    const before = sqlite.prepare('select * from character order by member_id').all() as Record<string, unknown>[];
    expect(before[0]!.name).toBe('คําแก้ว');

    migrate(drizzle(sqlite), { migrationsFolder });

    const after = sqlite.prepare('select * from character order by member_id').all() as Record<string, unknown>[];
    expect(after).toEqual([
      { ...before[0], name: 'คำแก้ว', appearance: 'ผิวคล้ำ ตาดำ\nผมสั้น', personality: 'ทำอะไรช้า แต่จำแม่น ก่ำ' },
      before[1],
    ]);
    expect(String(after[0]!.name)).toContain('ำ');
    // Player names (member) are a separate rule and stay as they were.
    expect(sqlite.prepare('select name, name_key from member order by id').all()).toEqual([
      { name: nfkc('คำแก้ว'), name_key: nfkc('คำแก้ว') },
      { name: 'ลิน', name_key: 'ลิน' },
    ]);
  });
});
