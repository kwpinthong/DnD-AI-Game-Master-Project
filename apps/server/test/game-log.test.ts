import { CreateGameResponse, GameLogResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { advanceTimeline } from '../src/timeline/store.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { makeTempDir } from './helpers.ts';
import type { RoomClient } from './room-client.ts';
import { dumpTables, enterRoom, fourPlayerTable, playFirstTurn, type FourTable } from './resume-fixture.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, startTestServer } from './visibility-fixture.ts';

/** GEN-037 C3: GET /api/game/log, the read-only summary + log of the caller's game, also after it ended. */
describe('game summary / log (GEN-037)', { timeout: 120_000 }, () => {
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

  async function getLog(token: string | undefined) {
    return caller(server!)('GET', '/api/game/log', token === undefined ? {} : { token });
  }

  /** Ends the game the way the engine does after day 12 NOCTHERION turn 2: status finale, timeline ended. */
  function endGame(t: FourTable) {
    const state = ensurePhaseState(server!.orm, t.gameId, CLOCK);
    savePhaseState(server!.orm, t.gameId, { ...state, status: 'finale' }, CLOCK);
    expect(advanceTimeline(server!.orm, t.gameId, 'end', CLOCK)).toMatchObject({ ok: true });
  }

  async function replayOf(seat: { token: string }) {
    const client = await enterRoom(server!, seat, sockets);
    const entries = client.entries();
    await client.close();
    return entries;
  }

  it('C3: a finished game opens as a summary + log: members, timeline, and only the entries this player got', async () => {
    const t = await fourPlayerTable(server!, 'เกมที่จบแล้ว');
    await playFirstTurn(server!, t, sockets);
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    const replays = [await replayOf(t.seats[0]), await replayOf(t.seats[1])];
    endGame(t);

    const res = await getLog(t.seats[0].token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // GEN-059: once ended, karma appears only inside the secret reveal.
    expect(forbiddenKeysIn(res.body).filter((path) => !path.startsWith('reveal.'))).toEqual([]);
    const log = GameLogResponse.parse(res.body);
    expect(log.game).toMatchObject({ id: t.gameId, name: 'เกมที่จบแล้ว', mode: 'online', status: 'ended', endReason: 'finale' });
    expect(log.game.at).toEqual({ day: 1, phase: 'EOSORIA', turn: 2 });
    expect(log.you).toEqual({ memberId: t.seats[0].memberId, role: 'player' });
    expect(log.members).toEqual([
      { name: 'นก', role: 'player' },
      { name: 'บี', role: 'player' },
      { name: 'ซี', role: 'player' },
      { name: 'ดี', role: 'player' },
    ]);
    expect(log.timeline.view).toBe('player');
    expect(log.timeline.ended).toBe(true);
    expect(log.timeline.events.length).toBeGreaterThan(0);
    for (const event of log.timeline.events) expect(Object.keys(event).sort()).toEqual(['day', 'id', 'phase', 'status', 'title']);
    expect(log.entries).toEqual(replays[0]);

    // B's log is B's: none of A's private narration.
    const other = GameLogResponse.parse((await getLog(t.seats[1].token)).body);
    expect(other.entries).toEqual(replays[1]);
    const narrationOf = (entries: typeof log.entries) => entries.filter((e) => e.kind === 'narration').map((e) => e.seq);
    expect(narrationOf(other.entries).filter((seq) => narrationOf(log.entries).includes(seq))).toEqual([]);
  });

  it('reading the log changes nothing, during play too (status playing)', async () => {
    const t = await fourPlayerTable(server!);
    await playFirstTurn(server!, t, sockets);
    const before = dumpTables(server!.db);
    const log = GameLogResponse.parse((await getLog(t.seats[2].token)).body);
    expect(log.game).toMatchObject({ status: 'playing', endReason: null, at: { day: 1, phase: 'EOSORIA', turn: 2 } });
    expect(dumpTables(server!.db)).toEqual(before);
  });

  it('a game that ended in game_over says so', async () => {
    const t = await fourPlayerTable(server!);
    const state = ensurePhaseState(server!.orm, t.gameId, CLOCK);
    savePhaseState(server!.orm, t.gameId, { ...state, status: 'game_over' }, CLOCK);
    expect(GameLogResponse.parse((await getLog(t.seats[0].token)).body).game).toMatchObject({ status: 'ended', endReason: 'game_over' });
  });

  it('in the lobby: status lobby, no point on the clock, no entries; it does not start the clock either', async () => {
    const created = await caller(server!)('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'ยังไม่เริ่ม', mode: 'online', humanGm: false, name: 'นก', pin: '1234' },
    });
    const game = CreateGameResponse.parse(created.body);
    const log = GameLogResponse.parse((await getLog(game.token)).body);
    expect(log.game).toMatchObject({ status: 'lobby', at: null, startedAt: null, endReason: null });
    expect(log.entries).toEqual([]);
    expect(server!.db.prepare('select count(*) as n from game_phase').get()).toEqual({ n: 0 });
  });

  it('the Human GM gets the GM timeline (outcomes) and the entries sent to the GM', async () => {
    const t = await startedTable(server!, true);
    const log = GameLogResponse.parse((await getLog(t.gm!.token)).body);
    expect(log.you.role).toBe('gm');
    expect(log.timeline.view).toBe('gm');
    expect(log.members.map((m) => m.role)).toEqual(['gm', 'player', 'player', 'player']);
  });

  it('needs a session', async () => {
    expect((await getLog(undefined)).status).toBe(401);
    expect((await getLog('not-a-token')).status).toBe(401);
  });
});
