import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { backupDatabase, listBackups, pruneBackups, type BackupResult } from './backup.ts';

export interface BackupConfig {
  /** Where the copies go; on Railway inside the volume (/data/backups). */
  dir: string;
  intervalMs: number;
  /** How many of the newest copies are kept. */
  keep: number;
}

export interface BackupSchedule {
  /** Stops the timer, waits for a running backup, then takes the shutdown one. */
  stop(): Promise<void>;
  last(): BackupResult | undefined;
  /** Backups this schedule finished. */
  taken(): number;
}

export interface BackupScheduleOptions extends BackupConfig {
  sqlite: Database.Database;
  /** Names the files (epoch ms). */
  now: () => number;
  /** One line per backup: path, size, time. Never data from the DB. */
  log: (line: string) => void;
}

/**
 * The backup job inside the server process (GEN-037): one right after start unless the newest copy is
 * younger than the interval (restarts do not pile up copies), then one per interval, and one at shutdown.
 * A failed backup is logged and the game goes on; the next interval tries again.
 */
export function startBackupSchedule(options: BackupScheduleOptions): BackupSchedule {
  let running: Promise<void> = Promise.resolve();
  let last: BackupResult | undefined;
  let taken = 0;
  let stopped = false;

  function run(reason: string): Promise<void> {
    running = running.then(async () => {
      try {
        const result = await backupDatabase(options.sqlite, options.dir, options.now());
        last = result;
        taken++;
        const removed = pruneBackups(options.dir, options.keep);
        options.log(`[backup] ${reason}: ${result.path} (${result.bytes} bytes, ${result.tookMs} ms), removed ${removed.length} old`);
      } catch (error) {
        options.log(`[backup] ${reason} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return running;
  }

  const newest = listBackups(options.dir)[0];
  const age = newest === undefined ? Infinity : Date.now() - statSync(newest).mtimeMs;
  const first = age >= options.intervalMs ? setTimeout(() => void run('start'), 0) : undefined;
  const timer = setInterval(() => {
    if (!stopped) void run('scheduled');
  }, options.intervalMs);
  first?.unref();
  timer.unref();

  return {
    async stop() {
      if (stopped) return running;
      stopped = true;
      if (first) clearTimeout(first);
      clearInterval(timer);
      await run('shutdown');
    },
    last: () => last,
    taken: () => taken,
  };
}
