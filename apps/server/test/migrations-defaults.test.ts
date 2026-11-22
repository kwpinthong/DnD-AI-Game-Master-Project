import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder, openDatabase } from '../src/db/client.ts';
import { makeTempDir } from './helpers.ts';

/**
 * GEN-037 C6: a DB made by an older version (stopped after any migration) is migrated by the current
 * server. Every row of every table is still there with the same values, and every column added since
 * holds its default. Rows are generic (one value per column type), so a new migration is covered
 * without changing this test.
 */

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function migrationsUpTo(dir: string, count: number): string {
  const out = join(dir, `drizzle-${count}`);
  mkdirSync(join(out, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return out;
}

const userTables = (db: Database.Database) =>
  (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name").all() as { name: string }[]).map(
    (t) => t.name,
  );
const columnsOf = (db: Database.Database, table: string) => db.prepare(`pragma table_info("${table}")`).all() as Column[];

/**
 * The one data change a migration makes on purpose: 0012_time_periods renames the 3 old phases to periods.
 * Before it, a `phase` column held MORNING / AFTERNOON / NIGHT.
 */
const TIME_MIGRATION = journal.entries.findIndex((e) => e.tag.endsWith('_time_periods'));
const PHASE_RENAMED: Record<string, string> = { MORNING: 'EOSORIA' };

function valueFor(column: Column, row: number, appliedCount: number): unknown {
  if (column.name === 'phase') return appliedCount <= TIME_MIGRATION ? 'MORNING' : 'EOSORIA';
  const type = column.type.toUpperCase();
  if (type.includes('INT')) return row + 1;
  if (type.includes('REAL')) return row + 0.5;
  if (type.includes('BLOB')) return Buffer.from([row]);
  return `v${row}-${column.name}`;
}

/**
 * Fills every table with 2 rows and returns them per table. A foreign key column gets the value of the
 * column it references in the parent's row with the same index, so every reference holds (a table rebuild
 * re-inserts with foreign keys on). Inserted with foreign keys off only because of the insert order.
 */
function fill(db: Database.Database, appliedCount: number): Record<string, Record<string, unknown>[]> {
  db.pragma('foreign_keys = OFF');
  const foreignKeys = (table: string) => db.prepare(`pragma foreign_key_list("${table}")`).all() as { table: string; from: string; to: string }[];
  const resolve = (table: string, column: string, row: number): unknown => {
    const fk = foreignKeys(table).find((f) => f.from === column);
    if (fk) return resolve(fk.table, fk.to, row);
    return valueFor(columnsOf(db, table).find((c) => c.name === column)!, row, appliedCount);
  };
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of userTables(db)) {
    const columns = columnsOf(db, table);
    rows[table] = [0, 1].map((row) => Object.fromEntries(columns.map((c) => [c.name, resolve(table, c.name, row)])));
    const names = columns.map((c) => `"${c.name}"`).join(', ');
    const insert = db.prepare(`insert into "${table}" (${names}) values (${columns.map(() => '?').join(', ')})`);
    for (const row of rows[table]!) insert.run(...columns.map((c) => row[c.name]));
  }
  return rows;
}

const sortRows = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).sort();

describe('C6: migrating a DB from an older version keeps its data and gives new fields their default', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  beforeAll(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterAll(() => cleanup());

  // Stopped after migration 1, 2, ... up to the one before the latest.
  const points = Array.from({ length: journal.entries.length - 1 }, (_, i) => i + 1);
  it.each(points)('DB after %i migrations', (count) => {
    const dbPath = join(dir, `old-${count}.sqlite`);
    const old = new Database(dbPath);
    migrate(drizzle(old), { migrationsFolder: migrationsUpTo(dir, count) });
    const before = fill(old, count);
    const oldColumns = Object.fromEntries(Object.keys(before).map((t) => [t, columnsOf(old, t).map((c) => c.name)]));
    old.close();

    const { sqlite, migrationsApplied } = openDatabase(dbPath);
    try {
      expect(migrationsApplied).toBe(journal.entries.length - count);
      expect(sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      for (const [table, rows] of Object.entries(before)) {
        const now = columnsOf(sqlite, table);
        expect(now.length, `${table} still exists`).toBeGreaterThan(0);
        const after = sqlite.prepare(`select * from "${table}"`).all() as Record<string, unknown>[];
        expect(after, `${table} row count`).toHaveLength(rows.length);

        // Old columns: the same values (bar the deliberate phase rename).
        const kept = oldColumns[table]!.filter((c) => now.some((n) => n.name === c));
        const project = (r: Record<string, unknown>, migrated: boolean) =>
          Object.fromEntries(
            kept.map((c) => {
              const v = r[c];
              const value = Buffer.isBuffer(v) ? [...v] : v;
              return [c, !migrated && c === 'phase' && typeof value === 'string' ? (PHASE_RENAMED[value] ?? value) : value];
            }),
          );
        expect(sortRows(after.map((r) => project(r, true))), `${table} values`).toEqual(sortRows(rows.map((r) => project(r, false))));

        // New columns: their default (or, for a NOT NULL one without a default, a value the migration chose).
        for (const column of now.filter((n) => !oldColumns[table]!.includes(n.name))) {
          const expected = column.dflt_value === null ? null : (sqlite.prepare(`select ${column.dflt_value} as v`).get() as { v: unknown }).v;
          for (const row of after) {
            if (column.dflt_value === null && column.notnull) expect(row[column.name], `${table}.${column.name}`).not.toBeNull();
            else expect(row[column.name], `${table}.${column.name}`).toEqual(expected);
          }
        }
      }
    } finally {
      sqlite.close();
    }
  });
});
