import Database from 'better-sqlite3';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDatabase, integrityProblems, listBackups, pruneBackups, restoreBackup, tableCounts } from '../src/backup/backup.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import type { RoomClient } from './room-client.ts';
import { dumpTables, fourPlayerTable, playFirstTurn, sendAction } from './resume-fixture.ts';
import { CLOCK, startTestServer } from './visibility-fixture.ts';

/** GEN-037 C4 + C5: online backup (SQLite backup API) of the live DB, integrity_check, restore into a new file. */
describe('backup and restore (GEN-037)', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    server = await startTestServer(dir);
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  it('C4: a backup restored into a new DB file has the same number of rows in every table', async () => {
    const t = await fourPlayerTable(server!);
    await playFirstTurn(server!, t, sockets);
    const before = tableCounts(server!.db);
    // The played turn filled the tables this task is about.
    for (const table of ['game', 'member', 'character', 'game_phase', 'phase_action', 'room_entry', 'room_entry_recipient', 'gm_turn', 'ai_usage', 'game_event_state', 'game_timeline', 'character_presence']) {
      expect(before[table], table).toBeGreaterThan(0);
    }

    const backup = await backupDatabase(server!.db, join(dir, 'backups'), CLOCK);
    expect(existsSync(backup.path)).toBe(true);
    expect(integrityProblems(backup.path)).toEqual([]);

    const target = join(dir, 'restored', 'isekai.sqlite');
    const restored = await restoreBackup(backup.path, target);
    expect(restored.migrationsApplied).toBe(0);
    expect(restored.counts).toEqual(before);
    expect(Object.keys(restored.counts).length).toBeGreaterThan(20);

    // Same rows, not only the same counts.
    const copy = new Database(target, { readonly: true });
    try {
      expect(tableCounts(copy)).toEqual(before);
      expect(dumpTables(copy)).toEqual(dumpTables(server!.db));
    } finally {
      copy.close();
    }
  });

  it('C4: restore never overwrites an existing DB file and refuses a broken backup', async () => {
    const backup = await backupDatabase(server!.db, join(dir, 'backups'), CLOCK);
    await expect(restoreBackup(backup.path, server!.dbPath)).rejects.toThrow(/already exists/);

    const broken = join(dir, 'broken.sqlite');
    writeFileSync(broken, 'not a database at all');
    await expect(restoreBackup(broken, join(dir, 'new.sqlite'))).rejects.toThrow(/integrity|not a database/i);
    expect(existsSync(join(dir, 'new.sqlite'))).toBe(false);
  });

  it('C5: a backup taken while players are acting succeeds and passes integrity_check', async () => {
    const t = await fourPlayerTable(server!);
    const clients = await playFirstTurn(server!, t, sockets);

    // Players keep changing their turn-2 action (each one is a write) for as long as the backup runs.
    let writes = 0;
    let running = true;
    const playing = (async () => {
      for (let i = 0; running; i++) {
        const client = clients[i % 3]!;
        expect(await sendAction(client, `เปลี่ยนใจครั้งที่ ${i}`)).toEqual({ type: 'action_accepted' });
        writes++;
      }
    })();
    // Let the players start before the backup does.
    while (writes < 3) await new Promise((r) => setTimeout(r, 5));
    const writesAtStart = writes;

    let steps = 0;
    const backup = await backupDatabase(server!.db, join(dir, 'backups'), CLOCK, {
      pagesPerStep: 1,
      onStep: () => {
        steps++;
      },
    });
    const writesDuring = writes - writesAtStart;
    running = false;
    await playing;

    expect(steps).toBeGreaterThan(1);
    expect(writesDuring).toBeGreaterThan(0);
    expect(integrityProblems(backup.path)).toEqual([]);
    const copy = new Database(backup.path, { readonly: true });
    try {
      expect((copy.prepare('select count(*) as n from member').get() as { n: number }).n).toBe(4);
      expect((copy.prepare('select count(*) as n from phase_action where turn = 2').get() as { n: number }).n).toBeGreaterThan(0);
    } finally {
      copy.close();
    }
  });

  it('keeps only the newest backups (retention) and ignores other files', async () => {
    const backups = join(dir, 'backups');
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await backupDatabase(server!.db, backups, CLOCK + i * 3_600_000)).path);
    writeFileSync(join(backups, 'notes.txt'), 'keep me');
    expect(listBackups(backups)).toEqual([...made].reverse());

    const removed = pruneBackups(backups, 3);
    expect(removed.sort()).toEqual(made.slice(0, 2).sort());
    expect(listBackups(backups)).toEqual(made.slice(2).reverse());
    expect(readdirSync(backups)).toContain('notes.txt');
  });
});
