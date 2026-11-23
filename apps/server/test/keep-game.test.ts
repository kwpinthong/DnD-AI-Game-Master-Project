import { SeededRng, phaseStep, turnNumber, type PhaseState, type TurnPoint } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import type { RoomClient } from './room-client.ts';
import { atTurn, enterRoom, fourPlayerTable, playFirstTurn, sendAction, type FourTable } from './resume-fixture.ts';
import { caller, CLOCK, startTestServer } from './visibility-fixture.ts';

/**
 * GEN-112: the game is kept in SQLite after every turn; "leave" only leaves the screen (the server keeps the
 * game, its members and the owner), and deleting a game is its own owner-only call that must be confirmed.
 */

function advance(state: PhaseState, to: TurnPoint): PhaseState {
  let s = state;
  for (let guard = 0; guard < 200 && turnNumber(s) < turnNumber(to); guard++) {
    if (s.status === 'collecting') {
      for (const id of s.order) {
        if (s.submissions[id]) continue;
        const action = { text: 'เดินเล่น', visibility: 'public' as const, rest: s.phase === 'NOCTHERION' };
        const r = phaseStep(s, { type: 'submit', playerId: id, action }, new SeededRng(1));
        if (!r.ok) throw new Error(r.error.code);
        s = r.state;
      }
    }
    const r = phaseStep(s, { type: 'resolved', results: {} }, new SeededRng(1));
    if (!r.ok) throw new Error(r.error.code);
    s = r.state;
  }
  return s;
}

describe('GEN-112 the game is kept', { timeout: 120_000 }, () => {
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

  const closeSockets = () => Promise.all(sockets.splice(0).map((s) => s.close()));
  async function restart() {
    await closeSockets();
    await server!.close();
    server = await startTestServer(dir);
  }
  const call = () => caller(server!);

  it('C1: played to day 2, a restart puts the game back at the same turn with the same character and feed', async () => {
    const t = await fourPlayerTable(server!);
    await playFirstTurn(server!, t, sockets);
    await closeSockets();
    savePhaseState(server!.orm, t.gameId, advance(ensurePhaseState(server!.orm, t.gameId, CLOCK), { day: 2, phase: 'SOLARION', turn: 1 }), CLOCK);

    const snapshot = async () => {
      const room = await enterRoom(server!, t.seats[0], sockets);
      const out = { room: room.lastRoom(), feed: room.entries(), character: (await call()('GET', '/api/game/character', { token: t.seats[0].token })).body };
      await closeSockets();
      return out;
    };
    const before = await snapshot();
    expect(before.room).toMatchObject({ day: 2, phase: 'SOLARION', turn: 1, status: 'collecting' });
    await restart();
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it('C5: an action sent right before the tab closes is still there after a restart', async () => {
    const t = await fourPlayerTable(server!);
    const a = await enterRoom(server!, t.seats[0], sockets);
    expect(await sendAction(a, 'แอบตามพ่อค้า', 'secret')).toEqual({ type: 'action_accepted' });
    await closeSockets();
    await restart();
    const again = await enterRoom(server!, t.seats[0], sockets);
    await again.waitFor(atTurn(1, 'EOSORIA', 1));
    expect(again.lastRoom()!.you.action).toEqual({ text: 'แอบตามพ่อค้า', visibility: 'secret', rest: false });
  });

  it('C2 + C3 + C4: the owner logs out and everyone leaves: the game, its members and the owner stay, and the owner comes back with name + PIN', async () => {
    const t = await fourPlayerTable(server!);
    const [owner, b] = t.seats;
    expect((await call()('POST', '/api/logout', { token: owner.token })).status).toBe(204);

    // C2: the others stay; the game is still there.
    const seenByB = await call()('GET', '/api/game', { token: b.token });
    expect(seenByB.status).toBe(200);
    expect((seenByB.body as { members: unknown[] }).members).toHaveLength(4);

    // C4: everyone out, a restart (a day later in real time); the game can still be entered.
    await call()('POST', '/api/logout', { token: b.token });
    await restart();
    const back = await call()('POST', '/api/join', { body: { inviteCode: t.inviteCode, name: 'นก', pin: '1234' } });
    expect(back.status, JSON.stringify(back.body)).toBe(200);

    // C3: same game, same member (ISK-017: no owner rights any more).
    const token = (back.body as { token: string }).token;
    const view = (await call()('GET', '/api/game', { token })).body as { status: string; you: { memberId: string } };
    expect(view).toMatchObject({ status: 'started', you: { memberId: owner.memberId } });
  });

  it('C6 (ISK-017): a player cannot delete a game, not even its creator (404); it stays', async () => {
    const t = await fourPlayerTable(server!, 'เกมที่จะลบ');
    const [creator, b] = t.seats;
    expect((await call()('DELETE', '/api/game', { token: creator.token, body: { confirmName: 'เกมที่จะลบ' } })).status).toBe(404);
    expect((await call()('GET', '/api/game', { token: b.token })).status).toBe(200);
    expect(server!.db.prepare('select count(*) as n from game').get()).toEqual({ n: 1 });
  });
});
