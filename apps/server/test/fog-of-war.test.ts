import { CharacterResponse, SurroundingsResponse, type RoomServerMessage } from '@isekai/protocol';
import { ReplayRng, resolveAction, type ResolutionProposal } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crossPlayerState } from '../src/crossplayer/phase.ts';
import type { RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { discoverHiddenEvidence, learnName, moveCharacter, presenceOf, setPlayerBond } from '../src/visibility/store.ts';
import { approveHeldTurn } from './gm-console-client.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-067 Fog of War: karma as the owner's own adjective, the Title Mask between players (allies with
 * relationship > +9 see the real name and may Whisper), Whisper over the play-room socket, Hidden Evidence.
 */

const NOT_ALLIED_YET = 'ยังไม่เป็นพันธมิตร';
const WHISPER = 'คืนนี้เจอกันหลังวิหาร อย่าบอกใคร';

/** INVESTIGATE as the AI GM would propose it: a general Perception check against DC 11. */
const investigate: ResolutionProposal = {
  actionId: 'investigate',
  kind: 'general',
  tags: ['perception'],
  opposed: false,
  staminaCost: 3,
  visibility: 'public',
  target: null,
  check: { type: 'dc', dc: 11 },
  modifiers: [{ source: 'stat' }],
  witnessNpcIds: [],
  repDeltaIfCaught: 0,
  onSuccess: { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] },
  onFail: { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] },
  reason: NOT_ALLIED_YET,
};

describe('GEN-067 karma words, Title Mask, Whisper, Hidden Evidence', { timeout: 60_000 }, () => {
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

  async function table(humanGm = false): Promise<Table & { gameId: string }> {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, humanGm);
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    return { ...t, gameId };
  }

  const karma = (who: Seat, value: number) => server!.db.prepare('update character set karma = ? where member_id = ?').run(value, who.memberId);
  const move = (who: Seat, locationId: string) => expect(moveCharacter(server!.orm, who.memberId, locationId, CLOCK)).toBe(true);
  const bond = (x: Seat, y: Seat, relationship: number, alliance = true) =>
    setPlayerBond(server!.orm, x.memberId, y.memberId, { alliance, relationship }, CLOCK);
  const refOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.ref;

  async function playerView(t: Table, who: { token: string }) {
    const res = await t.call('GET', '/api/game/surroundings', { token: who.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const view = SurroundingsResponse.parse(res.body);
    if (view.view !== 'player') throw new Error(`expected a player view, got ${view.view}`);
    return { raw: JSON.stringify(res.body), view };
  }
  const seenBy = async (t: Table, viewer: Seat, subject: Seat) =>
    (await playerView(t, viewer)).view.people.find((p) => p.appearance === subject.appearance);

  async function enter(seat: { token: string }, afterSeq = 0): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token, afterSeq });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function whisperReply(client: RoomClient, to: string, text: string) {
    const from = client.messages.length;
    client.whisper(to, text);
    return client.waitFor((m) => m.type === 'whisper_accepted' || m.type === 'whisper_rejected', from);
  }

  const whisperEntries = (c: RoomClient) => c.entries().filter((e) => e.kind === 'whisper');

  it('C3: A sees their own karma word; A sees B (not allied) by Title only: no real name, no karma word', async () => {
    const t = await table();
    karma(t.a, 0);
    karma(t.b, 60);

    const a = await playerView(t, t.a);
    expect(a.view.you?.conduct).toBe('เป็นกลางสุดๆ');
    const own = CharacterResponse.parse((await t.call('GET', '/api/game/character', { token: t.a.token })).body);
    expect(own.character?.conduct).toBe('เป็นกลางสุดๆ');

    const b = a.view.people.find((p) => p.appearance === t.b.appearance)!;
    expect(b).toMatchObject({ socialTitle: 'คนแปลกหน้า', name: null });
    expect(a.raw).not.toContain(t.b.name);
    expect(a.raw).not.toContain('ผู้พิทักษ์คุณธรรม'); // B's word (karma 60)
    expect(a.raw).not.toContain('60');

    // B sees their own word; A's word is not in B's payload either.
    karma(t.a, -40);
    const byB = await playerView(t, t.b);
    expect(byB.view.you?.conduct).toBe('ผู้พิทักษ์คุณธรรม');
    expect(byB.raw).not.toContain('ผู้บงการในเงามืด');
  });

  it('C4: allies at relationship +10 see each other\'s real name and may Whisper, but not the karma word', async () => {
    const t = await table();
    karma(t.b, 95);
    bond(t.a, t.b, 10);

    const a = await playerView(t, t.a);
    expect(a.view.people.find((p) => p.appearance === t.b.appearance)?.name).toBe(t.b.name);
    expect(a.raw).not.toContain('แสงสว่างแห่งรุ่งอรุณ');
    // The pair is mutual, and C still sees neither name.
    expect((await seenBy(t, t.b, t.a))?.name).toBe(t.a.name);
    expect((await seenBy(t, t.c, t.b))?.name).toBeNull();

    const roomA = await enter(t.a);
    expect(roomA.lastRoom()!.you.allies).toEqual([{ ref: refOf(t.b), name: t.b.name }]);
    expect(await whisperReply(roomA, refOf(t.b), WHISPER)).toEqual({ type: 'whisper_accepted' });
  });

  it('C4: relationship +9 (or no alliance) keeps the name hidden and Whisper refused', async () => {
    const t = await table();
    bond(t.a, t.b, 9);
    bond(t.a, t.c, 40, false);

    expect((await seenBy(t, t.a, t.b))?.name).toBeNull();
    expect((await seenBy(t, t.a, t.c))?.name).toBeNull();
    const roomA = await enter(t.a);
    expect(roomA.lastRoom()!.you.allies).toEqual([]);
    for (const target of [refOf(t.b), refOf(t.c), 'no-such-ref']) {
      expect(await whisperReply(roomA, target, WHISPER)).toMatchObject({ type: 'whisper_rejected', code: 'not_allowed' });
    }

    // Raised to +10 later: the name shows; dropped again: hidden again (not permanent).
    bond(t.a, t.b, 10);
    expect((await seenBy(t, t.a, t.b))?.name).toBe(t.b.name);
    bond(t.a, t.b, 10, false);
    expect((await seenBy(t, t.a, t.b))?.name).toBeNull();
  });

  it('Q-134: a discovered name shows to that viewer only, permanently, without opening Whisper', async () => {
    const t = await table();
    learnName(server!.orm, t.a.memberId, t.b.memberId, 'discovered', CLOCK);

    const a = await playerView(t, t.a);
    expect(a.view.people.find((p) => p.appearance === t.b.appearance)?.name).toBe(t.b.name);
    // Per viewer: B does not learn A's name, and C does not see B's.
    expect((await seenBy(t, t.b, t.a))?.name).toBeNull();
    const byC = await playerView(t, t.c);
    expect(byC.view.people.find((p) => p.appearance === t.b.appearance)?.name).toBeNull();
    expect(byC.raw).not.toContain(t.b.name);

    // Knowing a name is not an alliance: no Whisper.
    const roomA = await enter(t.a);
    expect(roomA.lastRoom()!.you.allies).toEqual([]);
    expect(await whisperReply(roomA, refOf(t.b), WHISPER)).toMatchObject({ type: 'whisper_rejected', code: 'not_allowed' });

    // Permanent: an alliance that ends does not hide a discovered name (C's name, known only by the alliance, hides again).
    bond(t.a, t.b, 20);
    bond(t.a, t.c, 20);
    bond(t.a, t.b, 20, false);
    bond(t.a, t.c, 20, false);
    expect((await seenBy(t, t.a, t.b))?.name).toBe(t.b.name);
    expect((await seenBy(t, t.a, t.c))?.name).toBeNull();
  });

  it('Q-292: an introduction shows the name (one way); discovering it later keeps it', async () => {
    const t = await table();
    learnName(server!.orm, t.a.memberId, t.b.memberId, 'introduced', CLOCK);
    expect((await seenBy(t, t.a, t.b))?.name).toBe(t.b.name);
    expect((await seenBy(t, t.b, t.a))?.name).toBeNull();
    learnName(server!.orm, t.a.memberId, t.b.memberId, 'discovered', CLOCK);
    expect((await seenBy(t, t.a, t.b))?.name).toBe(t.b.name);
  });

  it('Q-136: an unconscious player (HP 0) cannot Whisper, with the same lock as an action', async () => {
    const t = await table();
    bond(t.a, t.b, 15);
    const roomA = await enter(t.a);
    // Knock A out in the stored phase state (as the engine does after HP 0).
    const row = server!.db.prepare('select state from game_phase where game_id = ?').get(t.gameId) as { state: string };
    const state = JSON.parse(row.state) as { players: Record<string, Record<string, unknown>> };
    state.players[t.a.memberId] = { ...state.players[t.a.memberId], hp: 0, condition: 'unconscious', mustSubmit: false };
    server!.db.prepare('update game_phase set state = ? where game_id = ?').run(JSON.stringify(state), t.gameId);
    server!.db.prepare('update character set hp = 0 where member_id = ?').run(t.a.memberId);

    const from = roomA.messages.length;
    roomA.action('ลุกขึ้นสู้', 'public');
    const actionReply = await roomA.waitFor((m) => m.type === 'action_rejected', from);
    const whisper = await whisperReply(roomA, refOf(t.b), WHISPER);
    expect(whisper).toMatchObject({ type: 'whisper_rejected', code: 'unconscious' });
    expect(actionReply).toMatchObject({ code: 'unconscious' });
    if (whisper.type === 'whisper_rejected' && actionReply.type === 'action_rejected') expect(whisper.message).toBe(actionReply.message);

    // Nothing reached B.
    const roomB = await enter(t.b);
    expect(whisperEntries(roomB)).toEqual([]);
  });

  it('C6: a Whisper from A reaches B (and the Human GM), never C, also on replay', async () => {
    const t = await table(true);
    bond(t.a, t.b, 15);
    const [roomA, roomB, roomC, roomGm] = [await enter(t.a), await enter(t.b), await enter(t.c), await enter(t.gm!)];

    expect(await whisperReply(roomA, refOf(t.b), WHISPER)).toEqual({ type: 'whisper_accepted' });
    const got = await roomB.waitFor((m: RoomServerMessage) => m.type === 'entry' && m.entry.kind === 'whisper');
    expect(got.type === 'entry' && got.entry).toMatchObject({ kind: 'whisper', text: WHISPER, place: null, whisper: { from: t.a.name, to: t.b.name, mine: false } });
    await roomGm.waitFor((m: RoomServerMessage) => m.type === 'entry' && m.entry.kind === 'whisper');
    expect(whisperEntries(roomA)).toEqual([expect.objectContaining({ text: WHISPER, whisper: { from: t.a.name, to: t.b.name, mine: true } })]);

    // C's socket got nothing of it: no frame carries the text or either name.
    for (const frame of roomC.raw) {
      expect(frame).not.toContain(WHISPER);
      expect(frame).not.toContain(t.a.name);
    }
    expect(whisperEntries(roomC)).toEqual([]);

    // Reconnects: B gets it again, C still does not.
    const againB = await enter(t.b);
    expect(whisperEntries(againB).map((e) => e.text)).toEqual([WHISPER]);
    const againC = await enter(t.c);
    expect(againC.raw.join('\n')).not.toContain(WHISPER);

    for (const c of [roomA, roomB, roomC, againB, againC]) for (const m of c.messages) expect(forbiddenKeysIn(m)).toEqual([]);
  });

  it('C6: an empty or too long Whisper is refused, and the GM cannot Whisper', async () => {
    const t = await table(true);
    bond(t.a, t.b, 15);
    const roomA = await enter(t.a);
    expect(await whisperReply(roomA, refOf(t.b), '   ')).toMatchObject({ type: 'whisper_rejected', code: 'empty' });
    expect(await whisperReply(roomA, refOf(t.b), 'ก'.repeat(1001))).toMatchObject({ type: 'whisper_rejected', code: 'too_long' });
    const roomGm = await enter(t.gm!);
    expect(await whisperReply(roomGm, refOf(t.b), WHISPER)).toMatchObject({ type: 'whisper_rejected', code: 'not_a_player' });
  });

  it('C5: B\'s Secret action at the market leaves Hidden Evidence; INVESTIGATE there that day finds it by roll; next day it is gone', async () => {
    const t = await table();
    for (const s of [t.a, t.b, t.c]) move(s, 'market');
    const rooms = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const send = async (c: RoomClient, text: string, visibility: 'public' | 'secret') => {
      const from = c.messages.length;
      c.action(text, visibility);
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    };
    await send(rooms[0]!, 'เดินดูแผงผัก', 'public');
    await send(rooms[1]!, 'แอบงัดกล่องเงินของพ่อค้า', 'secret');
    await send(rooms[2]!, 'นั่งพัก', 'public');
    await rooms[0]!.waitFor((m) => m.type === 'room' && m.phase === 'EOSORIA' && m.turn === 2);

    const roll = (who: Seat, d20: number) => {
      const actor = crossPlayerState(server!.orm, t.gameId).players[who.memberId]!;
      const result = resolveAction({ state: { actor, npcs: {} }, proposal: investigate }, new ReplayRng([d20]));
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      return result.log.degree;
    };

    // Same day at the market: a 15 finds it (who left it is not told), a 3 does not.
    const found = discoverHiddenEvidence(server!.orm, t.gameId, t.a.memberId, 1, roll(t.a, 15));
    expect(found).toEqual([{ id: expect.any(Number), locationId: 'market', day: 1 }]);
    expect(JSON.stringify(found)).not.toContain(t.b.memberId);
    expect(discoverHiddenEvidence(server!.orm, t.gameId, t.c.memberId, 1, roll(t.c, 3))).toEqual([]);
    // Elsewhere: nothing. B does not "find" their own.
    move(t.c, 'forest');
    expect(discoverHiddenEvidence(server!.orm, t.gameId, t.c.memberId, 1, 'success')).toEqual([]);
    expect(discoverHiddenEvidence(server!.orm, t.gameId, t.b.memberId, 1, 'success')).toEqual([]);
    // The next day it is gone.
    expect(discoverHiddenEvidence(server!.orm, t.gameId, t.a.memberId, 2, 'crit')).toEqual([]);

    // Players never get a list of evidence.
    for (const s of [t.a, t.b, t.c]) expect((await playerView(t, s)).raw).not.toMatch(/evidence/i);
  });

  it('C5: a Public action leaves no evidence', async () => {
    const t = await table();
    for (const s of [t.a, t.b, t.c]) move(s, 'market');
    const rooms = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of rooms.entries()) {
      const from = c.messages.length;
      c.action(`ทำงานปกติ ${i}`, 'public');
      await c.waitFor((m) => m.type === 'action_accepted', from);
    }
    await rooms[0]!.waitFor((m) => m.type === 'room' && m.phase === 'EOSORIA' && m.turn === 2);
    expect(discoverHiddenEvidence(server!.orm, t.gameId, t.a.memberId, 1, 'crit')).toEqual([]);
  });

  it('C7: the Human GM sees every karma number and word, the bonds and all the evidence', async () => {
    const t = await table(true);
    karma(t.a, 14);
    karma(t.b, -100);
    bond(t.a, t.c, 30);
    move(t.b, 'market');
    for (const s of [t.a, t.c]) move(s, 'temple');
    const rooms = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [c, v] of [[rooms[0]!, 'public'], [rooms[1]!, 'secret'], [rooms[2]!, 'public']] as const) {
      const from = c.messages.length;
      c.action('ทำบางอย่าง', v);
      await c.waitFor((m) => m.type === 'action_accepted', from);
    }
    // GEN-058 (Q-030): the turn waits for the GM's approval.
    await approveHeldTurn(t.call, t.gm!.token);
    await rooms[0]!.waitFor((m) => m.type === 'room' && m.phase === 'EOSORIA' && m.turn === 2);

    const res = await t.call('GET', '/api/game/surroundings', { token: t.gm!.token });
    const view = SurroundingsResponse.parse(res.body);
    if (view.view !== 'gm') throw new Error('expected the GM view');
    const of = (s: Seat) => view.characters.find((c) => c.memberId === s.memberId)!;
    expect(of(t.a)).toMatchObject({ karma: 14, conduct: 'คนหัดทำดี', playerBonds: [{ memberId: t.c.memberId, alliance: true, relationship: 30 }] });
    expect(of(t.b)).toMatchObject({ karma: -100, conduct: 'ชั่วสุดขีด / หายนะเดินดิน', playerBonds: [] });
    expect(of(t.c).playerBonds).toEqual([{ memberId: t.a.memberId, alliance: true, relationship: 30 }]);
    expect(of(t.a).knowsNamesOf).toEqual([t.c.memberId]);
    expect(view.evidence).toEqual([{ id: expect.any(Number), locationId: 'market', day: 1, actorMemberId: t.b.memberId }]);
  });

  it('setPlayerBond clamps to -100..+100 and refuses a pair across games or with oneself', async () => {
    const t = await table();
    expect(bond(t.a, t.b, 500)).toEqual({ alliance: true, relationship: 100 });
    expect(bond(t.b, t.a, -500)).toEqual({ alliance: true, relationship: -100 });
    expect(() => bond(t.a, t.a, 10)).toThrow();
    server!.db.prepare("insert into game (id, name, mode, human_gm, invite_code, created_at) select 'other', 'x', mode, human_gm, 'ZZZZZZ', created_at from game limit 1").run();
    server!.db.prepare("update member set game_id = 'other' where id = ?").run(t.c.memberId);
    expect(() => bond(t.a, t.c, 10)).toThrow();
  });
});
