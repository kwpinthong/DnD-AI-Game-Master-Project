import Database from 'better-sqlite3';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { backupDatabase, integrityProblems, listBackups, listGameEndBackups, pruneBackups } from '../src/backup/backup.ts';
import { hashPin } from '../src/auth/pin.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, CREATE_CODE, startedTable } from './visibility-fixture.ts';

/** GEN-037 Q-185: one backup when a game ends, named as such and outside the rotating `keep`. */

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('end-of-game backup files', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it('are named gameend-<status>-<game>-<time>.sqlite and never listed or pruned with the rotating ones', async () => {
    const sqlite = new Database(join(dir, 'live.sqlite'));
    sqlite.exec('create table t (x)');
    const backups = join(dir, 'backups');
    try {
      await backupDatabase(sqlite, backups, Date.UTC(2026, 10, 22, 12));
      await backupDatabase(sqlite, backups, Date.UTC(2026, 10, 22, 13));
      const ended = await backupDatabase(sqlite, backups, Date.UTC(2026, 10, 22, 14), { gameEnd: { gameId: 'g/../1 x', status: 'game_over' } });
      expect(basename(ended.path)).toBe('gameend-game_over-g____1_x-20261122T140000000Z.sqlite');
      expect(integrityProblems(ended.path)).toEqual([]);
      expect(listBackups(backups).map((p) => basename(p))).toEqual(['isekai-20261122T130000000Z.sqlite', 'isekai-20261122T120000000Z.sqlite']);
      expect(listGameEndBackups(backups)).toEqual([ended.path]);
      pruneBackups(backups, 0);
      expect(listBackups(backups)).toEqual([]);
      expect(listGameEndBackups(backups)).toEqual([ended.path]);
    } finally {
      sqlite.close();
    }
  });
});

describe('the server takes one when the game ends', { timeout: 60_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];
  const lines: string[] = [];

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    lines.length = 0;
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  it('day 12 NOCTHERION turn 2 closes → finale → one gameend-finale backup holding the ended game; keep is untouched', async () => {
    const backups = join(dir, 'backups');
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(dir, 'isekai.sqlite'), createCodeHash: await hashPin(CREATE_CODE), backup: { dir: backups, intervalMs: 3_600_000, keep: 1 } },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, backupLog: (line) => lines.push(line) },
    );
    await until(() => listBackups(backups).length === 1);
    const t = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    savePhaseState(server.orm, gameId, { ...ensurePhaseState(server.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2 }, CLOCK);
    expect(listGameEndBackups(backups)).toEqual([]);

    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const c = await openRoom(server, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      clients.push(c);
    }
    for (const c of clients) c.action('รอฟ้าสาง', 'public');
    for (const c of clients) await c.waitFor((m) => m.type === 'room' && m.status === 'finale');

    await until(() => listGameEndBackups(backups).length === 1);
    const [file] = listGameEndBackups(backups);
    expect(basename(file!)).toMatch(new RegExp(`^gameend-finale-${gameId}-\\d{8}T\\d{9}Z\\.sqlite$`));
    const copy = new Database(file!, { readonly: true });
    try {
      const state = JSON.parse((copy.prepare('select state from game_phase where game_id = ?').get(gameId) as { state: string }).state) as { status: string };
      expect(state.status).toBe('finale');
    } finally {
      copy.close();
    }
    // Not one of the rotating copies: keep 1 still holds the start backup.
    expect(listBackups(backups)).toHaveLength(1);
    expect(lines.filter((l) => l.includes('game end'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('รอฟ้าสาง');
  });
});
