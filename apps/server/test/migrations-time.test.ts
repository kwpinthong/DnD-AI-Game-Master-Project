import { defaultScenario, parseScenario } from '@isekai/protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isEntry, isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, startTestServer } from './visibility-fixture.ts';

/** GEN-063 C8: a game stored with the 3-phase model (DB at the migration before 0011_time_periods) opens on the new clock. */

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;
const TIME_MIGRATION = journal.entries.findIndex((e) => e.tag.endsWith('_time_periods'));

function migrationsBefore(dir: string, count: number): string {
  const out = join(dir, 'drizzle-partial');
  mkdirSync(join(out, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return out;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const LEGACY = { EOSORIA: 'MORNING', SOLARION: 'AFTERNOON', HESPERION: 'NIGHT' } as Record<string, string>;

/** The default scenario as GEN-045..062 stored it: MORNING / AFTERNOON / NIGHT. */
function legacyScenarioJson(): string {
  const s = defaultScenario();
  return JSON.stringify({ ...s, timeline: s.timeline.map((e) => ({ ...e, phase: LEGACY[e.phase] ?? e.phase })) });
}

/** What the GEN-052 engine saved: day 3 Night, B has sent, A has not. */
const legacyState = {
  day: 3,
  phase: 'NIGHT',
  status: 'collecting',
  order: ['m-a', 'm-b'],
  players: {
    'm-a': { id: 'm-a', hp: 90, stamina: 14, condition: 'awake', mustSubmit: true, secretDay: 3, sleepBonus: 0, knockedOut: null },
    'm-b': { id: 'm-b', hp: 100, stamina: 22, condition: 'awake', mustSubmit: true, secretDay: null, sleepBonus: 0, knockedOut: null },
  },
  submissions: { 'm-b': { text: 'นอนที่โรงเตี๊ยม "คืนนี้" phase:"MORNING"', visibility: 'public', rest: true, restAtInn: true } },
  staminaMax: 30,
  hpMax: 100,
};

describe('GEN-063 C8 migration of games stored with 3 phases', { timeout: 60_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  function buildOldDb(): void {
    expect(TIME_MIGRATION).toBeGreaterThan(0);
    const sqlite = new Database(join(dir, 'isekai.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: migrationsBefore(dir, TIME_MIGRATION) });
    const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    run("insert into game (id, invite_code, name, mode, owner_member_id, started_at, created_at) values ('g1', 'OLD123', 'เกมเก่า', 'online', 'm-a', 1, 1)");
    for (const [id, name, token] of [
      ['m-a', 'ลิน', 'tok-a'],
      ['m-b', 'ดาริน', 'tok-b'],
    ]) {
      run('insert into member (id, game_id, name, name_key, pin_hash, created_at) values (?, ?, ?, ?, ?, 1)', id, 'g1', name, name, 'x');
      run('insert into session (token_hash, member_id, created_at, expires_at) values (?, ?, 1, ?)', sha256(token!), id, CLOCK + 86_400_000);
      run('insert into character (member_id, created_at, name, appearance, personality) values (?, 1, ?, ?, ?)', id, name, 'ผ้าคลุมเทา', 'เงียบ');
    }
    run('insert into game_scenario (game_id, schema_version, data, updated_at) values (?, 1, ?, 1)', 'g1', legacyScenarioJson());
    run("insert into game_timeline (game_id, day, phase, ended, updated_at) values ('g1', 3, 'NIGHT', 0, 1)");
    run('insert into game_phase (game_id, state, updated_at) values (?, ?, 1)', 'g1', JSON.stringify(legacyState));
    run("insert into phase_action (game_id, day, phase, member_id, text, visibility, submitted_at) values ('g1', 3, 'AFTERNOON', 'm-a', 'ไปตลาด', 'public', 1)");
    run("insert into phase_action (game_id, day, phase, member_id, text, visibility, submitted_at) values ('g1', 3, 'NIGHT', 'm-b', ?, 'public', 2)", legacyState.submissions['m-b'].text);
    run("insert into room_entry (id, game_id, kind, day, phase, location_id, text, created_at) values (1, 'g1', 'narration', 3, 'AFTERNOON', null, 'คุณเดินถึงตลาด', 1)");
    run("insert into room_entry_recipient (entry_id, member_id) values (1, 'm-a')");
    run(
      "insert into ai_usage (game_id, day, phase, purpose, provider, model, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd_micros, ok, attempt, latency_ms, created_at) values ('g1', 3, 'MORNING', 'gm_adjudicate', 'mock', 'mock', 1, 0, 0, 1, 0, 1, 1, 1, 1)",
    );
    sqlite.close();
  }

  it('the server starts, the rows are on the new clock and the game plays on over the room', async () => {
    buildOldDb();
    server = await startTestServer(dir);
    expect(server.migrationsApplied).toBe(journal.entries.length - TIME_MIGRATION);
    const db = server.db;

    expect(db.prepare('select day, phase, turn, rest, text from phase_action order by submitted_at').all()).toEqual([
      { day: 3, phase: 'SOLARION', turn: 1, rest: 0, text: 'ไปตลาด' },
      { day: 3, phase: 'HESPERION', turn: 1, rest: 0, text: legacyState.submissions['m-b'].text },
    ]);
    expect(db.prepare('select day, phase, turn from room_entry').all()).toEqual([{ day: 3, phase: 'SOLARION', turn: 1 }]);
    expect(db.prepare('select day, phase from game_timeline').all()).toEqual([{ day: 3, phase: 'HESPERION' }]);
    expect(db.prepare('select phase, turn from ai_usage').all()).toEqual([{ phase: 'EOSORIA', turn: null }]);

    const stored = JSON.parse((db.prepare("select state from game_phase where game_id = 'g1'").get() as { state: string }).state);
    expect(stored).toMatchObject({ day: 3, phase: 'HESPERION', turn: 1 });
    // Player text that looks like a phase key is left alone.
    expect(stored.submissions['m-b'].text).toBe(legacyState.submissions['m-b'].text);
    const scenarioData = (db.prepare("select data from game_scenario where game_id = 'g1'").get() as { data: string }).data;
    expect(scenarioData).not.toMatch(/"phase":"(MORNING|AFTERNOON|NIGHT)"/);
    const scenario = parseScenario(JSON.parse(scenarioData));
    if (!scenario.ok) throw new Error(JSON.stringify(scenario.errors));
    expect(scenario.scenario.timeline.map((e) => e.phase)).toEqual(defaultScenario().timeline.map((e) => e.phase));

    const timeline = await caller(server)('GET', '/api/game/timeline', { token: 'tok-a' });
    expect(timeline.status).toBe(200);
    expect(timeline.body).toMatchObject({ at: { day: 3, phase: 'HESPERION' } });

    // The room opens at day 3 HESPERION turn 1; B's action stood, so only A sends.
    const a = await openRoom(server, { token: 'tok-a' });
    sockets.push(a);
    await a.waitFor(isReady);
    expect(a.entries()).toEqual([expect.objectContaining({ day: 3, phase: 'SOLARION', turn: 1, text: 'คุณเดินถึงตลาด' })]);
    const room = a.lastRoom()!;
    expect(room).toMatchObject({ day: 3, phase: 'HESPERION', turn: 1, status: 'collecting' });
    expect(Object.fromEntries(room.members.map((m) => [m.memberId, m.submitted]))).toEqual({ 'm-a': false, 'm-b': true });
    // The day Secret A used on day 3 still counts.
    expect(room.you.secretUsed).toBe(true);

    a.action('เดินกลับโรงเตี๊ยม', 'public');
    await a.waitFor((m) => m.type === 'room' && m.day === 3 && m.phase === 'HESPERION' && m.turn === 2 && m.status === 'collecting');
    await a.waitFor(isEntry);
  });
});
