import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { backupDatabase, integrityProblems } from './backup.ts';

// `pnpm db:backup`: one backup of DB_PATH into BACKUP_DIR (default backups/ next to the DB), now.
// Safe while the server runs: it uses SQLite's online backup API on its own connection.
try {
  const config = loadConfig(process.env);
  const dir = config.backup?.dir ?? resolve(dirname(config.dbPath), 'backups');
  const sqlite = new Database(config.dbPath, { fileMustExist: true });
  sqlite.pragma('busy_timeout = 5000');
  try {
    const result = await backupDatabase(sqlite, dir, Date.now());
    const problems = integrityProblems(result.path);
    console.log(`[isekai-server] backup ${result.path} (${result.bytes} bytes, ${result.tookMs} ms, integrity_check ${problems.length === 0 ? 'ok' : problems.join('; ')})`);
  } finally {
    sqlite.close();
  }
} catch (error) {
  console.error(`[isekai-server] backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
