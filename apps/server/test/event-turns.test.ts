import { defaultScenario, type RoomServerMessage, type Scenario } from '@isekai/protocol';
import { SeededRng, phaseStep, turnNumber, type PhaseState, type TurnPoint } from '@isekai/rules';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder, openDatabase, type OpenedDatabase } from '../src/db/client.ts';
import { game } from '../src/db/schema.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { copyTemplateForGame, getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import { buildEventContext, foreshadowingFor } from '../src/timeline/context.ts';
import { advanceTimeline, getTimeline } from '../src/timeline/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

/** GEN-096 (Q-159): an event starts / ends on a given turn of its first / last period. */

const GAME = 'game-a';
type Event = Scenario['timeline'][number];

function withEvent(db: OpenedDatabase['db'], id: string, patch: Partial<Event>): void {
  const scenario = getGameScenario(db, GAME)!;
  const timeline = scenario.timeline.map((e) => (e.id === id ? { ...e, ...patch } : e));
  const updated = updateGameScenario(db, GAME, { ...scenario, timeline });
  if (!updated.ok) throw new Error(JSON.stringify(updated));
}

describe('GEN-096 event start / end turn on the timeline', () => {
  let opened: OpenedDatabase;
  let cleanup = () => {};

  beforeEach(() => {
    const temp = makeTempDir();
    cleanup = temp.cleanup;
    opened = openDatabase(join(temp.dir, 'isekai.sqlite'));
    opened.db.insert(game).values({ id: GAME, inviteCode: 'CODEA', createdAt: 1 }).run();
    copyTemplateForGame(opened.db, GAME);
  });

  afterEach(() => {
    opened.sqlite.close();
    cleanup();
  });

  const status = (id: string) => getTimeline(opened.db, GAME)!.events.find((e) => e.id === id)!.status;
  const activeAt = (day: number, phase: Event['phase']) => buildEventContext(opened.db, GAME, day, phase).active.map((e) => e.id);

  it('C1: day 7 HESPERION startTurn 2 is not active on turn 1 and becomes active on turn 2', () => {
    withEvent(opened.db, 'd7-kidnapping', { startTurn: 2 });
    expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 1 })).toMatchObject({ ok: true, activated: [] });
    expect(status('d7-kidnapping')).toBe('pending');
    expect(activeAt(7, 'HESPERION')).toEqual([]);

    expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 2 })).toMatchObject({ ok: true, activated: ['d7-kidnapping'] });
    expect(status('d7-kidnapping')).toBe('active');
    expect(activeAt(7, 'HESPERION')).toEqual(['d7-kidnapping']);
  });

  it('C1: a period point without a turn is turn 1', () => {
    withEvent(opened.db, 'd7-kidnapping', { startTurn: 2 });
    advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION' });
    expect(status('d7-kidnapping')).toBe('pending');
    expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 2 })).toMatchObject({ activated: ['d7-kidnapping'] });
  });

  it('C2: endTurn 1 ends the event when turn 1 of its end period closes', () => {
    withEvent(opened.db, 'd12-meteor', { endTurn: 1 });
    advanceTimeline(opened.db, GAME, { day: 12, phase: 'NOCTHERION', turn: 1 });
    expect(status('d12-meteor')).toBe('active');
    expect(advanceTimeline(opened.db, GAME, { day: 12, phase: 'NOCTHERION', turn: 2 })).toMatchObject({ ok: true, resolved: ['d12-meteor'] });
    expect(getTimeline(opened.db, GAME)!.events.find((e) => e.id === 'd12-meteor')).toMatchObject({ status: 'resolved', outcomeSource: 'default' });
    const context = buildEventContext(opened.db, GAME, 12, 'NOCTHERION');
    expect(context.active).toEqual([]);
    expect(context.past.map((e) => e.id)).toContain('d12-meteor');
  });

  it('C2: a one-period event with endTurn 1 is over on turn 2 of that period', () => {
    withEvent(opened.db, 'd7-kidnapping', { endTurn: 1 });
    advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 1 });
    expect(status('d7-kidnapping')).toBe('active');
    expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 2 })).toMatchObject({ resolved: ['d7-kidnapping'] });
    expect(activeAt(7, 'HESPERION')).toEqual([]);
  });

  it('C3: an event without the fields is active for both turns of each period, as before', () => {
    const event = getGameScenario(opened.db, GAME)!.timeline.find((e) => e.id === 'd7-kidnapping')!;
    expect(event).toMatchObject({ startTurn: 1, endTurn: 2 });
    expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 1 })).toMatchObject({ activated: ['d7-kidnapping'] });
    expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 2 })).toEqual({ ok: true, activated: [], resolved: [] });
    expect(status('d7-kidnapping')).toBe('active');
    expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'NOCTHERION', turn: 1 })).toMatchObject({ resolved: ['d7-kidnapping'] });
  });

  it('turn 1 after turn 2 of the same period is backwards; the same turn again changes nothing', () => {
    advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 2 });
    expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 1 })).toMatchObject({ ok: false, code: 'backwards' });
    expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 2 })).toEqual({ ok: true, activated: [], resolved: [] });
  });

  it('C5: foreshadowing keeps its time (the morning before) when the event starts on turn 2', () => {
    withEvent(opened.db, 'd7-kidnapping', { startTurn: 2 });
    const scenario = getGameScenario(opened.db, GAME)!;
    expect(foreshadowingFor(scenario, 6, 'EOSORIA').map((f) => f.eventId)).toEqual(['d7-kidnapping']);
    advanceTimeline(opened.db, GAME, { day: 6, phase: 'EOSORIA', turn: 1 });
    expect(buildEventContext(opened.db, GAME, 6, 'EOSORIA').foreshadowing.map((f) => f.eventId)).toEqual(['d7-kidnapping']);
  });
});

interface Journal {
  entries: { idx: number; tag: string }[];
}

describe('GEN-096 C6: a game saved before the turn fields loads and plays on', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it('old scenario JSON + old timeline cursor: same events, and the timeline moves by turn from there', () => {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;
    const turnsMigration = journal.entries.findIndex((e) => e.tag.endsWith('_event_turns'));
    expect(turnsMigration).toBeGreaterThan(0);
    const partial = join(dir, 'drizzle-partial');
    mkdirSync(join(partial, 'meta'), { recursive: true });
    const entries = journal.entries.slice(0, turnsMigration);
    for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(partial, `${e.tag}.sql`));
    writeFileSync(join(partial, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));

    const dbPath = join(dir, 'isekai.sqlite');
    const sqlite = new Database(dbPath);
    migrate(drizzle(sqlite), { migrationsFolder: partial });
    const s = defaultScenario() as unknown as { timeline: Record<string, unknown>[] };
    for (const e of s.timeline) {
      delete e.startTurn;
      delete e.endTurn;
    }
    sqlite.prepare("insert into game (id, invite_code, created_at) values (?, 'OLD123', 1)").run(GAME);
    sqlite.prepare('insert into game_scenario (game_id, schema_version, data, updated_at) values (?, 1, ?, 1)').run(GAME, JSON.stringify(s));
    sqlite.prepare("insert into game_timeline (game_id, day, phase, ended, updated_at) values (?, 7, 'HESPERION', 0, 1)").run(GAME);
    sqlite.prepare("insert into game_event_state (game_id, event_id, status, activated_at, updated_at) values (?, 'd7-kidnapping', 'active', 1, 1)").run(GAME);
    for (const id of ['d1-bread', 'd5-disaster']) {
      sqlite
        .prepare("insert into game_event_state (game_id, event_id, status, outcome, outcome_source, activated_at, resolved_at, updated_at) values (?, ?, 'resolved', 'x', 'default', 1, 1, 1)")
        .run(GAME, id);
    }
    sqlite.close();

    const opened = openDatabase(dbPath);
    try {
      const timeline = getTimeline(opened.db, GAME)!;
      expect(timeline.at).toEqual({ day: 7, phase: 'HESPERION' });
      expect(timeline.events.find((e) => e.id === 'd7-kidnapping')!.status).toBe('active');
      expect(getGameScenario(opened.db, GAME)!.timeline.every((e) => e.startTurn === 1 && e.endTurn === 2)).toBe(true);
      // The old cursor counts as turn 1: turn 2 of the same period moves on, and nothing changes.
      expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION', turn: 2 })).toEqual({ ok: true, activated: [], resolved: [] });
      expect(advanceTimeline(opened.db, GAME, { day: 7, phase: 'NOCTHERION', turn: 1 })).toMatchObject({ ok: true, resolved: ['d7-kidnapping'] });
    } finally {
      opened.sqlite.close();
    }
  });
});

/** Plays the engine forward to `to` (everyone acts; in NOCTHERION everyone sleeps), as if the turns were played. */
function advance(state: PhaseState, to: TurnPoint): PhaseState {
  let s = state;
  for (let guard = 0; guard < 200 && turnNumber(s) < turnNumber(to); guard++) {
    for (const id of s.order) {
      const action = { text: 'เดินเล่น', visibility: 'public' as const, rest: s.phase === 'NOCTHERION' };
      const r = phaseStep(s, { type: 'submit', playerId: id, action }, new SeededRng(1));
      if (!r.ok) throw new Error(r.error.code);
      s = r.state;
    }
    const r = phaseStep(s, { type: 'resolved', results: {} }, new SeededRng(1));
    if (!r.ok) throw new Error(r.error.code);
    s = r.state;
  }
  return s;
}

describe('GEN-096 in the play room: the timeline follows each turn', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    server = await startTestServer(dataDir, { phaseResolver: { resolve: async () => ({}) } });
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  const gameOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;

  it('C1: turn 1 of day 7 HESPERION resolves → turn 2 starts and the startTurn 2 event becomes active', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameOf(t);
    const scenario = getGameScenario(server!.orm, gameId)!;
    const timeline = scenario.timeline.map((e) => (e.id === 'd7-kidnapping' ? { ...e, startTurn: 2 as const } : e));
    expect(updateGameScenario(server!.orm, gameId, { ...scenario, timeline }).ok).toBe(true);
    const to = { day: 7, phase: 'HESPERION', turn: 1 } as const;
    savePhaseState(server!.orm, gameId, advance(ensurePhaseState(server!.orm, gameId, CLOCK), to), CLOCK);
    advanceTimeline(server!.orm, gameId, to, CLOCK);
    const status = () => getTimeline(server!.orm, gameId)!.events.find((e) => e.id === 'd7-kidnapping')!.status;
    expect(status()).toBe('pending');

    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const client = await openRoom(server!, { token: seat.token });
      sockets.push(client);
      await client.waitFor(isReady);
      clients.push(client);
    }
    for (const client of clients) {
      const from = client.messages.length;
      client.action('เดินเล่นแถวโบสถ์', 'public');
      expect(await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
    await clients[0]!.waitFor(
      (m: RoomServerMessage) => m.type === 'room' && m.day === 7 && m.phase === 'HESPERION' && m.turn === 2 && m.status === 'collecting',
    );
    expect(status()).toBe('active');
  });
});
