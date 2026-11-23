import { GameLogResponse, OMEN_MAX_LENGTH, PLAYER_TEXT_MAX, type RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '../src/server.ts';
import { presenceOf, setPlayerBond } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/** ISK-012: what a player types (action, Whisper) is at most 200 code points after trim; the omen keeps its own ceiling. */
describe('ISK-012 player text ≤ 200', { timeout: 60_000 }, () => {
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

  async function table(): Promise<Table> {
    server = await startTestServer(dataDir);
    return startedTable(server, false);
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token, afterSeq: 0 });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function act(client: RoomClient, text: string): Promise<RoomServerMessage> {
    const from = client.messages.length;
    client.action(text, 'public');
    return client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
  }

  async function whisper(client: RoomClient, to: string, text: string): Promise<RoomServerMessage> {
    const from = client.messages.length;
    client.whisper(to, text);
    return client.waitFor((m) => m.type === 'whisper_accepted' || m.type === 'whisper_rejected', from);
  }

  const storedActions = (who: Seat) => server!.db.prepare('select text, rest from phase_action where member_id = ?').all(who.memberId) as { text: string; rest: number }[];
  const ally = (t: Table) => {
    setPlayerBond(server!.orm, t.a.memberId, t.b.memberId, { alliance: true, relationship: 15 }, CLOCK);
    return presenceOf(server!.orm, t.b.memberId)!.ref;
  };

  it('PLAYER_TEXT_MAX is 200', () => {
    expect(PLAYER_TEXT_MAX).toBe(200);
  });

  it('C1: an action of 200 is accepted; 201 is refused with text_too_long and nothing is stored', async () => {
    const t = await table();
    const a = await enter(t.a);
    const refused = await act(a, 'ก'.repeat(201));
    expect(refused).toMatchObject({ type: 'action_rejected', code: 'text_too_long' });
    if (refused.type === 'action_rejected') expect(refused.message).toContain('200');
    expect(storedActions(t.a)).toEqual([]);
    expect(await act(a, 'ก'.repeat(200))).toEqual({ type: 'action_accepted' });
    expect(storedActions(t.a).map((r) => r.text)).toEqual(['ก'.repeat(200)]);
  });

  it('C2: a Whisper of 201 is refused with text_too_long (socket reply); 200 is accepted', async () => {
    const t = await table();
    const to = ally(t);
    const a = await enter(t.a);
    const refused = await whisper(a, to, 'ข'.repeat(201));
    expect(refused).toMatchObject({ type: 'whisper_rejected', code: 'text_too_long' });
    if (refused.type === 'whisper_rejected') expect(refused.message).toContain('200');
    expect(await whisper(a, to, 'ข'.repeat(200))).toEqual({ type: 'whisper_accepted' });
  });

  it('C3: Thai with tone marks counts code points: 200 is accepted, 201 is not', async () => {
    const t = await table();
    const a = await enter(t.a);
    const thai = 'ก่'.repeat(100); // 200 code points, 100 graphemes
    expect([...thai].length).toBe(200);
    expect(await act(a, `${thai}ก`)).toMatchObject({ type: 'action_rejected', code: 'text_too_long' });
    expect(await act(a, thai)).toEqual({ type: 'action_accepted' });
  });

  it('C7: 200 code points with spaces before and after are accepted (and stored trimmed)', async () => {
    const t = await table();
    const to = ally(t);
    const a = await enter(t.a);
    expect(await act(a, `   ${'ค'.repeat(200)} \n `)).toEqual({ type: 'action_accepted' });
    expect(storedActions(t.a).map((r) => r.text)).toEqual(['ค'.repeat(200)]);
    expect(await whisper(a, to, `  ${'ค'.repeat(200)}  `)).toEqual({ type: 'whisper_accepted' });
  });

  it('C6: "พัก" is still REST (GEN-113); the omen keeps its own ceiling', async () => {
    const t = await table();
    const a = await enter(t.a);
    expect(await act(a, 'พัก')).toEqual({ type: 'action_accepted' });
    expect(storedActions(t.a)).toEqual([{ text: 'พัก', rest: 1 }]);
    // The omen's 200 / 201 run is crisis.test.ts C6; ISK-012 does not touch its constant.
    expect(OMEN_MAX_LENGTH).toBe(200);
  });

  it('C8: an action and a Whisper over 200 already in the DB still show in the room replay and the log', async () => {
    const t = await table();
    const to = ally(t);
    const a = await enter(t.a);
    expect(await act(a, 'เดินตลาด')).toEqual({ type: 'action_accepted' });
    expect(await whisper(a, to, 'เจอกันหลังวิหาร')).toEqual({ type: 'whisper_accepted' });
    const old = 'ง'.repeat(250);
    server!.db.prepare('update phase_action set text = ? where member_id = ?').run(old, t.a.memberId);
    server!.db.prepare("update room_entry set text = ? where kind in ('whisper', 'player')").run(old);

    const againA = await enter(t.a);
    expect(againA.lastRoom()!.you.action?.text).toBe(old);
    expect(againA.entries().filter((e) => e.kind === 'whisper').map((e) => e.text)).toEqual([old]);
    const againB = await enter(t.b);
    expect(againB.entries().filter((e) => e.kind === 'whisper').map((e) => e.text)).toEqual([old]);

    const log = await t.call('GET', '/api/game/log', { token: t.a.token });
    expect(log.status, JSON.stringify(log.body)).toBe(200);
    GameLogResponse.parse(log.body);
  });
});
