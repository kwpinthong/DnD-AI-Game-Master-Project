import { GameLogResponse, RoomEntry, type RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { RunningServer } from '../src/server.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat } from './visibility-fixture.ts';

/**
 * ISK-013 (Q-389 = A): found Hidden Evidence is also its own private entry for the investigator, marked `clue: true`
 * (server template "พบร่องรอยลับ…"); the AI narration keeps its evidence beat. C1, C5, C6, C7 (server side).
 */
describe('ISK-013 the clue entry', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function enter(seat: { token: string }, afterSeq = 0): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token, afterSeq });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function send(c: RoomClient, text: string, visibility: 'public' | 'secret') {
    const from = c.messages.length;
    c.action(text, visibility);
    expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
  }

  const collecting = (phase: string, turn: number) => (m: RoomServerMessage) => m.type === 'room' && m.phase === phase && m.turn === turn && m.status === 'collecting';

  /** B acts in secret at the market (turn 1); A investigates there the same day (turn 2), C only looks around. */
  async function play() {
    server = await startTestServer(dataDir, { ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }) });
    const t = await startedTable(server, false);
    for (const s of [t.a, t.b, t.c]) expect(moveCharacter(server.orm, s.memberId, 'market', CLOCK)).toBe(true);
    const rooms = [await enter(t.a), await enter(t.b), await enter(t.c)] as const;
    await send(rooms[0], 'เดินดูแผงผัก', 'public');
    await send(rooms[1], 'แอบงัดกล่องเงินของพ่อค้า', 'secret');
    await send(rooms[2], 'นั่งพัก', 'public');
    for (const r of rooms) await r.waitFor(collecting('EOSORIA', 2));
    await send(rooms[0], 'ค้นหาร่องรอยรอบแผง [mock:investigate=MIRACLE]', 'public');
    await send(rooms[1], 'เดินดูรอบ ๆ', 'public');
    await send(rooms[2], 'เดินดูรอบ ๆ', 'public');
    for (const r of rooms) await r.waitFor(collecting('SOLARION', 1));
    return { t, rooms };
  }

  const clues = (entries: readonly RoomEntry[]) => entries.filter((e) => e.clue === true);

  it('C1 + C7: the investigator gets one private clue entry live (template text, no votes); nobody else gets it', async () => {
    const { rooms } = await play();
    const mine = clues(rooms[0].entries());
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'narration', place: null, clue: true, day: 1, phase: 'EOSORIA', turn: 2 });
    expect(mine[0]!.text.startsWith('พบร่องรอยลับ')).toBe(true);
    // A server template, not AI text: no vote buttons.
    expect(mine[0]!.myVote).toBeUndefined();
    // The AI narration of that turn is still there, without the clue mark.
    expect(rooms[0].entries().some((e) => e.kind === 'narration' && e.turn === 2 && e.phase === 'EOSORIA' && e.clue === undefined)).toBe(true);
    for (const r of [rooms[1], rooms[2]]) {
      expect(clues(r.entries())).toEqual([]);
      expect(r.entries().some((e) => e.seq === mine[0]!.seq)).toBe(false);
    }
    expect(server!.db.prepare('select count(*) as n from room_entry_recipient where entry_id = ?').get(mine[0]!.seq)).toEqual({ n: 1 });
  });

  it('C5 + C6: on a reconnect replay and in the game log the clue keeps `clue: true`; other entries have no `clue` key', async () => {
    const { t, rooms } = await play();
    const seq = clues(rooms[0].entries())[0]!.seq;
    const again = await enter(t.a);
    expect(clues(again.entries()).map((e) => e.seq)).toEqual([seq]);
    const log = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.a.token })).body);
    expect(log.entries.filter((e) => e.clue).map((e) => e.seq)).toEqual([seq]);
    for (const e of log.entries.filter((x) => x.seq !== seq)) expect('clue' in e, `seq ${e.seq}`).toBe(false);
    const other = (who: Seat) => t.call('GET', '/api/game/log', { token: who.token });
    for (const who of [t.b, t.c]) expect(GameLogResponse.parse((await other(who)).body).entries.some((e) => e.clue)).toBe(false);
  });

  it('C6: a vote on the clue entry is refused (it is not AI-written)', async () => {
    const { t, rooms } = await play();
    const seq = clues(rooms[0].entries())[0]!.seq;
    const res = await t.call('PUT', `/api/game/entries/${seq}/vote`, { token: t.a.token, body: { vote: 'up' } });
    expect(res.status).toBe(404);
  });
});
