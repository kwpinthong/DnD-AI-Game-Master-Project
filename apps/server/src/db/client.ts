import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.ts';

export const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

export type Db = BetterSQLite3Database<typeof schema>;

/** The database at `dbPath` cannot be created, opened, written or migrated. */
export class DatabaseUnavailableError extends Error {
  readonly dbPath: string;

  constructor(dbPath: string, cause: unknown) {
    super(`Cannot use the database at "${dbPath}": ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'DatabaseUnavailableError';
    this.dbPath = dbPath;
  }
}

export interface OpenedDatabase {
  sqlite: Database.Database;
  db: Db;
  dbPath: string;
  /** Migrations applied by this open (0 when the DB was already up to date). */
  migrationsApplied: number;
}

/**
 * Creates the DB file (and its directory) if needed, checks it is writable, and applies pending
 * migrations. Drizzle records applied migrations in `__drizzle_migrations`, so each runs once per file.
 */
export function openDatabase(dbPath: string): OpenedDatabase {
  let sqlite: Database.Database | undefined;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    if (existsSync(dbPath)) accessSync(dbPath, constants.W_OK);
    sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    const before = countApplied(sqlite);
    migrate(db, { migrationsFolder });
    return { sqlite, db, dbPath, migrationsApplied: countApplied(sqlite) - before };
  } catch (error) {
    sqlite?.close();
    throw new DatabaseUnavailableError(dbPath, error);
  }
}

function countApplied(sqlite: Database.Database): number {
  const table = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = '__drizzle_migrations'")
    .get();
  if (!table) return 0;
  return (sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n;
}
