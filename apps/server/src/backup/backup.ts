import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase } from '../db/client.ts';

/**
 * Backups of the game database (GEN-037, ADR Hosting): SQLite's online backup API copies the live file
 * page by page while the server keeps writing, so nobody has to stop playing. Each copy is checked with
 * `PRAGMA integrity_check` before it gets its final name; a copy cut short (crash, kill) stays a `.tmp`
 * file that `listBackups` never returns and the next run deletes.
 */

export interface BackupResult {
  path: string;
  bytes: number;
  tookMs: number;
}

export interface BackupOptions {
  /** Pages copied per step; the event loop runs between steps (default 256 pages = 1 MiB at 4 KiB pages). */
  pagesPerStep?: number;
  /** Called after every step (tests count the steps). */
  onStep?: () => void;
  /** Q-185: the copy taken when this game ended. */
  gameEnd?: { gameId: string; status: 'finale' | 'game_over' };
}

/**
 * End-of-game copies (Q-185): `gameend-<finale|game_over>-<game id>-<time>.sqlite`. Their own prefix keeps them
 * out of `listBackups`, so the rotation (`keep`, 28 by default) never counts or deletes them.
 */
const GAME_END_PREFIX = 'gameend-';
const isGameEndName = (name: string) => name.startsWith(GAME_END_PREFIX) && name.endsWith(SUFFIX);

/** End-of-game backups in `dir`, newest first. */
export function listGameEndBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isGameEndName)
    .sort((a, b) => stamp(b).localeCompare(stamp(a)))
    .map((name) => join(dir, name));
}

/** The time part of a backup name (sorts as text). */
const stamp = (name: string) => /(\d{8}T\d{9}Z)/.exec(name)?.[1] ?? '';

const PREFIX = 'isekai-';
const SUFFIX = '.sqlite';
const TMP = '.tmp';

/** `isekai-20261122T120000123Z.sqlite`: sorts by time as text; an end-of-game copy is `gameend-<status>-<game>-<time>.sqlite`. */
function backupName(now: number, gameEnd?: BackupOptions['gameEnd']): string {
  const iso = new Date(now).toISOString(); // 2026-11-22T12:00:00.123Z
  const time = iso.replace(/[-:]/g, '').replace('.', '');
  if (!gameEnd) return `${PREFIX}${time}${SUFFIX}`;
  return `gameend-${gameEnd.status}-${gameEnd.gameId.replace(/[^A-Za-z0-9_-]/g, '_')}-${time}${SUFFIX}`;
}

const isBackupName = (name: string) => name.startsWith(PREFIX) && name.endsWith(SUFFIX);
const isAnyBackupName = (name: string) => isBackupName(name) || name.startsWith('gameend-');

export async function backupDatabase(sqlite: Database.Database, dir: string, now: number, options: BackupOptions = {}): Promise<BackupResult> {
  const started = performance.now();
  mkdirSync(dir, { recursive: true });
  // Copies left by a crash; an hour old so a backup still running in another process (the CLI) is not touched.
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (name.endsWith(TMP) && isAnyBackupName(name.slice(0, -TMP.length)) && statSync(file).mtimeMs < Date.now() - 3_600_000) rmSync(file, { force: true });
  }

  const name = backupName(now, options.gameEnd);
  let path = join(dir, name);
  for (let n = 1; existsSync(path); n++) path = join(dir, name.replace(SUFFIX, `-${n}${SUFFIX}`));
  const tmp = `${path}${TMP}`;
  const pagesPerStep = options.pagesPerStep ?? 256;
  try {
    await sqlite.backup(tmp, {
      progress: () => {
        options.onStep?.();
        return pagesPerStep;
      },
    });
    const problems = integrityProblems(tmp);
    if (problems.length > 0) throw new Error(`backup failed integrity_check: ${problems.join('; ')}`);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return { path, bytes: statSync(path).size, tookMs: Math.round(performance.now() - started) };
}

/** `PRAGMA integrity_check` of the file at `path`: [] when it is a sound SQLite database. */
export function integrityProblems(path: string): string[] {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    const problems = rows.map((r) => r.integrity_check).filter((r) => r !== 'ok');
    return rows.length === 0 ? ['integrity_check returned nothing'] : problems;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  } finally {
    db?.close();
  }
}

/** Rows per table (every table but SQLite's own), by table name. */
export function tableCounts(sqlite: Database.Database): Record<string, number> {
  const tables = sqlite
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  for (const { name } of tables) counts[name] = (sqlite.prepare(`select count(*) as n from "${name}"`).get() as { n: number }).n;
  return counts;
}

/** Finished backups in `dir`, newest first (other files and unfinished `.tmp` copies are left out). */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isBackupName)
    .sort()
    .reverse()
    .map((name) => join(dir, name));
}

/** Deletes all but the newest `keep` backups; returns what it deleted. */
export function pruneBackups(dir: string, keep: number): string[] {
  const old = listBackups(dir).slice(Math.max(0, keep));
  for (const path of old) rmSync(path, { force: true });
  return old;
}

export interface RestoreResult {
  target: string;
  /** Migrations the restored file needed to match this version of the server (0 for a backup of the same version). */
  migrationsApplied: number;
  counts: Record<string, number>;
}

/**
 * Restores `source` into a NEW file `target` (never over an existing one): checks the backup, copies it,
 * applies pending migrations, checks the copy again and returns its row counts. To use it, point
 * DB_PATH at `target` and restart the server.
 */
export async function restoreBackup(source: string, target: string): Promise<RestoreResult> {
  if (existsSync(target)) throw new Error(`"${target}" already exists; restore only into a new file`);
  const problems = integrityProblems(source);
  if (problems.length > 0) throw new Error(`"${source}" failed integrity_check: ${problems.join('; ')}`);

  mkdirSync(dirname(target), { recursive: true });
  const from = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await from.backup(target);
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  } finally {
    from.close();
  }

  const { sqlite, migrationsApplied } = openDatabase(target);
  try {
    const after = sqlite.pragma('integrity_check') as { integrity_check: string }[];
    if (after.some((r) => r.integrity_check !== 'ok')) throw new Error(`"${target}" failed integrity_check after restore`);
    return { target, migrationsApplied, counts: tableCounts(sqlite) };
  } finally {
    sqlite.close();
  }
}
