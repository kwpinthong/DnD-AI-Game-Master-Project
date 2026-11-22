import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.ts';
import { makeTempDir } from './helpers.ts';

/**
 * GEN-037 C7: the process is killed (SIGKILL; TerminateProcess on Windows) in the middle of writing. The
 * next start opens the DB, it passes integrity_check, every transaction that committed is there in full,
 * and the one that was cut off left nothing.
 */
const writer = join(import.meta.dirname, 'fixtures', 'kill-writer.ts');

function killMidWrite(dbPath: string, afterCommits: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writer, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let last = 0;
    let killed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const lines = out.split('\n');
      out = lines.pop() ?? '';
      for (const line of lines) {
        const n = /^committed (\d+)$/.exec(line.trim());
        if (n) last = Number(n[1]);
      }
      if (!killed && last >= afterCommits) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.once('exit', (code, signal) => {
      if (!killed) return reject(new Error(`writer exited by itself (${code ?? signal}): ${err}`));
      resolve(last);
    });
  });
}

describe('C7: killed in the middle of a write (GEN-037)', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it.each([1, 2, 3])('run %i: the DB opens, passes integrity_check and keeps every committed transaction whole', async (run) => {
    const dbPath = join(dir, `isekai-${run}.sqlite`);
    const committed = await killMidWrite(dbPath, 40 + run * 25);
    expect(committed).toBeGreaterThanOrEqual(40);

    const { sqlite, migrationsApplied } = openDatabase(dbPath);
    try {
      expect(migrationsApplied).toBe(0);
      expect(sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      const perTx = sqlite
        .prepare("select substr(key, 1, instr(substr(key, 6), '-') + 4) as tx, count(*) as n from app_meta where key like 'kill-%' group by tx")
        .all() as { tx: string; n: number }[];
      // Every transaction the writer reported as committed is there...
      expect(perTx.length).toBeGreaterThanOrEqual(committed);
      // ...and no transaction is there in part (at most the one that committed just before the kill was not reported yet).
      expect(perTx.length).toBeLessThanOrEqual(committed + 1);
      for (const { tx, n } of perTx) expect(n, tx).toBe(40);
    } finally {
      sqlite.close();
    }
  });
});
