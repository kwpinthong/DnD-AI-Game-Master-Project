import { CreateGameResponse, type RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClosedPhase, PhaseResolution, PhaseResolver } from '../src/room/resolver.ts';
import type { RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir, seedChosenLoot } from './helpers.ts';
import { isEntry, isError, isReady, isRejected, isRoom, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, LIN, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/** A resolver the test scripts (the Mock of GEN-057): records each closed phase, answers with `respond`. */
function scriptedResolver() {
  const calls: ClosedPhase[] = [];
  let respond: (input: ClosedPhase) => PhaseResolution = () => ({});
  let gate: Promise<void> | null = null;
  const resolver: PhaseResolver = {
    async resolve(input) {
      calls.push(input);
      if (gate) await gate;
      return respond(input);
    },
  };
  return {
    resolver,
    calls,
    respond(f: (input: ClosedPhase) => PhaseResolution) {
      respond = f;
    },
    /** Keeps the next resolve pending until the returned function is called. */
    hold(): () => void {
      let release = () => {};
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

describe('GEN-056 play room', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let script: ReturnType<typeof scriptedResolver>;
  const sockets: RoomClient[] = [];

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    script = scriptedResolver();
    server = await startTestServer(dataDir, { phaseResolver: script.resolver });
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

  /** Every frame a player socket got passes the GEN-050 guard. */
  function expectNoForbiddenKeys(...clients: RoomClient[]) {
    for (const c of clients) for (const m of c.messages) expect(forbiddenKeysIn(m)).toEqual([]);
  }

  const phaseIs = (day: number, phase: string, turn: number, status = 'collecting') => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === status;

  async function submitAndAccept(client: RoomClient, text: string, visibility: 'public' | 'secret' = 'public', rest?: boolean) {
    const from = client.messages.length;
    client.action(text, visibility, rest);
    const reply = await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
    expect(reply, JSON.stringify(reply)).toEqual({ type: 'action_accepted' });
  }

  it('C1: a player with a character enters, and everyone in the room sees who is online', async () => {
    const t = await startedTable(server!, false);
    const a = await enter(t.a);
    const firstRoom = a.lastRoom()!;
    expect(firstRoom).toMatchObject({ day: 1, phase: 'EOSORIA', turn: 1, status: 'collecting', mode: 'online' });
    expect(firstRoom.members.find((m) => m.memberId === t.a.memberId)).toMatchObject({ online: true, submitted: false });
    expect(firstRoom.members.find((m) => m.memberId === t.b.memberId)).toMatchObject({ online: false });

    const from = a.messages.length;
    const b = await enter(t.b);
    const seenByA = await a.waitFor(
      (m) => m.type === 'room' && m.members.find((x) => x.memberId === t.b.memberId)?.online === true,
      from,
    );
    expect(seenByA.type).toBe('room');
    expect(b.lastRoom()!.members.filter((m) => m.online).map((m) => m.memberId).sort()).toEqual([t.a.memberId, t.b.memberId].sort());
    expect(b.lastRoom()!.you).toMatchObject({ memberId: t.b.memberId, lock: null, place: { id: 'inn' } });

    // B leaves: A sees B offline.
    const before = a.messages.length;
    await b.close();
    await a.waitFor((m) => m.type === 'room' && m.members.find((x) => x.memberId === t.b.memberId)?.online === false, before);
    expectNoForbiddenKeys(a, b);
  });

  it('C1: a bad token, a socket from another origin, and a game that has not started are refused', async () => {
    const t = await startedTable(server!, false);
    const stranger = await openRoom(server!, { token: 'not-a-token' });
    sockets.push(stranger);
    expect(await stranger.waitFor(isError)).toMatchObject({ code: 'unauthorized' });
    expect((await stranger.closed).code).toBeGreaterThanOrEqual(4000);

    await expect(openRoom(server!, { token: t.a.token, headers: { origin: 'https://evil.example' } })).rejects.toThrow();

    const call = caller(server!);
    const created = CreateGameResponse.parse(
      (
        await call('POST', '/api/games', {
          body: { createCode: CREATE_CODE, gameName: 'ยังไม่เริ่ม', mode: 'single', humanGm: false, name: 'โซโล่', pin: '1234' },
        })
      ).body,
    );
    const early = await openRoom(server!, { token: created.token });
    sockets.push(early);
    expect(await early.waitFor(isError)).toMatchObject({ code: 'game_not_started' });
  });

  it('C2: a player without a character is told to create one (no_character) and the socket closes', async () => {
    const t = await startedTable(server!, false);
    server!.db.prepare('delete from character where member_id = ?').run(t.b.memberId);
    const b = await openRoom(server!, { token: t.b.token });
    sockets.push(b);
    const error = await b.waitFor(isError);
    expect(error.code).toBe('no_character');
    expect(error.message).toMatch(/ตัวละคร/);
    await b.closed;
    expect(b.messages.filter((m) => m.type === 'room')).toEqual([]);
  });

  it('C3: B sees only that A sent a Secret action, never its text or visibility', async () => {
    const t = await startedTable(server!, false);
    const a = await enter(t.a);
    const b = await enter(t.b);
    const secretText = 'แอบหยิบกุญแจจากเคาน์เตอร์โดยไม่ให้ใครเห็น';

    const from = b.messages.length;
    await submitAndAccept(a, secretText, 'secret');
    const seen = await b.waitFor((m) => m.type === 'room' && m.members.find((x) => x.memberId === t.a.memberId)?.submitted === true, from);
    expect(seen.type).toBe('room');
    // A gets their own action back; the phase still waits for B and C (Online).
    expect(a.lastRoom()!.you.action).toEqual({ text: secretText, visibility: 'secret', rest: false });
    expect(a.lastRoom()!.status).toBe('collecting');
    expect(script.calls).toEqual([]);

    // Nothing B got carries A's text or the word secret; A's member entry has only the public fields.
    for (const frame of b.raw) {
      expect(frame).not.toContain(secretText);
      expect(frame).not.toContain('"secret"');
    }
    const aAsSeenByB = b.lastRoom()!.members.find((m) => m.memberId === t.a.memberId)!;
    expect(Object.keys(aAsSeenByB).sort()).toEqual(['memberId', 'name', 'online', 'role', 'submitted']);
    expect(b.lastRoom()!.you.action).toBeNull();
    expectNoForbiddenKeys(a, b);
  });

  it('C4: A\'s private narration never reaches B\'s socket, live or on replay', async () => {
    const t = await startedTable(server!, false);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const narration = 'คุณเห็นรอยเท้าแปลก ๆ ใต้โต๊ะที่คนอื่นไม่ทันสังเกต';
    script.respond(() => ({ entries: [{ kind: 'narration', memberId: t.a.memberId, text: narration }] }));

    await submitAndAccept(a, 'ก้มดูใต้โต๊ะ');
    await submitAndAccept(b, 'สั่งเบียร์');
    await submitAndAccept(c, 'นั่งฟังเพลง');
    const got = await a.waitFor(isEntry);
    expect(got.entry).toMatchObject({ kind: 'narration', text: narration, day: 1, phase: 'EOSORIA', turn: 1 });
    await a.waitFor(phaseIs(1, 'EOSORIA', 2));
    await b.waitFor(phaseIs(1, 'EOSORIA', 2));

    expect(b.entries()).toEqual([]);
    for (const frame of [...b.raw, ...c.raw]) expect(frame).not.toContain(narration);
    // B reconnecting from the start still gets nothing of A's.
    const bAgain = await enter(t.b, 0);
    expect(bAgain.entries()).toEqual([]);
    expectNoForbiddenKeys(a, b, c, bAgain);
  });

  describe('C5: refused actions come back with a reason', () => {
    it('C5: empty, whitespace only and over 1000 characters are refused; exactly 1000 is accepted', async () => {
      const t = await startedTable(server!, false);
      const a = await enter(t.a);
      for (const [text, code] of [
        ['', 'empty'],
        ['   \n  ', 'empty'],
        ['ก'.repeat(1001), 'too_long'],
      ] as const) {
        const from = a.messages.length;
        a.action(text, 'public');
        const reply = await a.waitFor(isRejected, from);
        expect(reply.code).toBe(code);
        expect(reply.message).toMatch(/[ก-๙]/);
      }
      const from = a.messages.length;
      a.send({ type: 'action', text: 'x', visibility: 'loud' });
      expect((await a.waitFor(isRejected, from)).code).toBe('invalid_action');
      await submitAndAccept(a, 'ก'.repeat(1000));
    });

    it('C5: while the phase is resolving, actions are refused (resolving)', async () => {
      const t = await startedTable(server!, false);
      const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
      const release = script.hold();
      await submitAndAccept(a, 'เดินตลาด');
      await submitAndAccept(b, 'ซื้อขนมปัง');
      await submitAndAccept(c, 'คุยกับพ่อค้า');
      await a.waitFor(phaseIs(1, 'EOSORIA', 1, 'resolving'));
      expect(a.lastRoom()!.you.lock?.code).toBe('resolving');

      const from = a.messages.length;
      a.action('เปลี่ยนใจ', 'public');
      const reply = await a.waitFor(isRejected, from);
      expect(reply.code).toBe('resolving');
      expect(reply.message).toMatch(/[ก-๙]/);

      release();
      await a.waitFor(phaseIs(1, 'EOSORIA', 2));
      await submitAndAccept(a, 'กลับโรงเตี๊ยม');
    });

    it('C5: Stamina 0 (exhausted) and HP 0 (unconscious, Q-057) lock the input; the phase does not wait for them', async () => {
      const t = await startedTable(server!, false);
      const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
      script.respond(() => ({ results: { [t.a.memberId]: { stamina: 0 }, [t.b.memberId]: { hp: 0 } } }));
      await submitAndAccept(a, 'วิ่งรอบเมือง');
      await submitAndAccept(b, 'ท้าดวลทหารยาม');
      await submitAndAccept(c, 'นั่งพัก');
      await a.waitFor(phaseIs(1, 'EOSORIA', 2));
      await b.waitFor(phaseIs(1, 'EOSORIA', 2));
      expect(a.lastRoom()!.you.lock?.code).toBe('exhausted');
      expect(b.lastRoom()!.you.lock?.code).toBe('unconscious');

      for (const [client, code] of [
        [a, 'exhausted'],
        [b, 'unconscious'],
      ] as const) {
        const from = client.messages.length;
        client.action('ลุกขึ้นสู้', 'public');
        const reply = await client.waitFor(isRejected, from);
        expect(reply.code).toBe(code);
        expect(reply.message).toMatch(/[ก-๙]/);
      }

      // Only C must act now, so C's action closes the phase.
      script.respond(() => ({}));
      await submitAndAccept(c, 'ไปตามหมอ');
      await c.waitFor((m) => m.type === 'room' && m.phase === 'SOLARION' && m.turn === 1);
      expect(script.calls).toHaveLength(2);
      expect(script.calls[1]!.actions.map((x) => x.memberId)).toEqual([t.c.memberId]);
    });

    it('C5: a second Secret on the same day is refused with a reason', async () => {
      const t = await startedTable(server!, false);
      const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
      await submitAndAccept(a, 'แอบตาม', 'secret');
      await submitAndAccept(b, 'เดิน');
      await submitAndAccept(c, 'เดิน');
      await a.waitFor(phaseIs(1, 'EOSORIA', 2));
      expect(a.lastRoom()!.you.secretUsed).toBe(true);
      const from = a.messages.length;
      a.action('แอบอีกรอบ', 'secret');
      const reply = await a.waitFor(isRejected, from);
      expect(reply.code).toBe('secret_quota_used');
      expect(reply.message).toMatch(/[ก-๙]/);
    });
  });

  it('C6: after a drop, a reconnect gets every missed feed and narration entry once, in order', async () => {
    const t = await startedTable(server!, false);
    let a = await enter(t.a);
    const [b, c] = [await enter(t.b), await enter(t.c)];
    let round = 0;
    script.respond(() => {
      round++;
      return {
        entries: [
          { kind: 'feed', locationId: 'inn', actorMemberId: t.b.memberId, text: `ฟีดรอบ ${round}` },
          { kind: 'narration', memberId: t.a.memberId, text: `เล่าให้ A รอบ ${round}` },
        ],
      };
    });

    // Round 1 while A is online.
    for (const [client, text] of [[a, 'หนึ่ง'], [b, 'สอง'], [c, 'สาม']] as const) await submitAndAccept(client, text);
    await a.waitFor(phaseIs(1, 'EOSORIA', 2));
    const online = a.entries();
    expect(online.map((e) => e.text)).toEqual(['ฟีดรอบ 1', 'เล่าให้ A รอบ 1']);
    const lastSeq = online.at(-1)!.seq;

    // A drops; rounds 2 and 3 happen without A. A is not exhausted, so the phase waits: A's action is sent
    // from a short second tab that closes before the results arrive.
    await a.close();
    for (const day of [
      { phase: 'SOLARION', turn: 1 },
      { phase: 'SOLARION', turn: 2 },
    ]) {
      const tab = await enter(t.a);
      await submitAndAccept(tab, 'ขณะหลุด');
      await tab.close();
      await submitAndAccept(b, 'ต่อ');
      const from = b.messages.length;
      await submitAndAccept(c, 'ต่อ');
      await b.waitFor((m) => m.type === 'room' && m.phase === day.phase && m.turn === day.turn && m.status === 'collecting', from);
    }

    a = await enter(t.a, lastSeq);
    const missed = a.entries();
    expect(missed.map((e) => e.text)).toEqual(['ฟีดรอบ 2', 'เล่าให้ A รอบ 2', 'ฟีดรอบ 3', 'เล่าให้ A รอบ 3']);
    expect(missed.every((e) => e.seq > lastSeq)).toBe(true);
    expect(new Set(missed.map((e) => e.seq)).size).toBe(missed.length);
    expect([...missed.map((e) => e.seq)].sort((x, y) => x - y)).toEqual(missed.map((e) => e.seq));
    expect(a.messages.findIndex(isReady)).toBeGreaterThan(a.messages.findLastIndex(isEntry));

    // A fresh tab (afterSeq 0) gets the whole history once; B never got A's narration.
    const fresh = await enter(t.a, 0);
    expect(fresh.entries().map((e) => e.text)).toEqual([
      'ฟีดรอบ 1',
      'เล่าให้ A รอบ 1',
      'ฟีดรอบ 2',
      'เล่าให้ A รอบ 2',
      'ฟีดรอบ 3',
      'เล่าให้ A รอบ 3',
    ]);
    expect(b.entries().map((e) => e.text)).toEqual(['ฟีดรอบ 1', 'ฟีดรอบ 2', 'ฟีดรอบ 3']);
    expectNoForbiddenKeys(a, b, c, fresh);
  });

  it('C7: in a Single game the phase closes as soon as the player sends', async () => {
    const call = caller(server!);
    const created = CreateGameResponse.parse(
      (
        await call('POST', '/api/games', {
          body: { createCode: CREATE_CODE, gameName: 'คนเดียว', mode: 'single', humanGm: false, name: 'โซโล่', pin: '1234' },
        })
      ).body,
    );
    expect((await call('POST', '/api/game/character', { token: created.token, body: LIN })).status).toBe(201);
    seedChosenLoot(server!.db, created.member.id);
    expect((await call('POST', '/api/game/start', { token: created.token })).status).toBe(200);

    const solo = await enter({ token: created.token });
    expect(solo.lastRoom()!.mode).toBe('single');
    await submitAndAccept(solo, 'สำรวจโรงเตี๊ยม');
    await solo.waitFor(phaseIs(1, 'EOSORIA', 2));
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]!.actions).toEqual([{ memberId: created.member.id, text: 'สำรวจโรงเตี๊ยม', visibility: 'public', rest: false, locationId: 'inn', travelingTo: null }]);
  });

  it('C8: B\'s Public result at the market reaches A at the market, not C in the forest', async () => {
    const t = await startedTable(server!, false);
    moveCharacter(server!.orm, t.a.memberId, 'market', CLOCK);
    moveCharacter(server!.orm, t.b.memberId, 'market', CLOCK);
    moveCharacter(server!.orm, t.c.memberId, 'forest', CLOCK);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const result = 'ชายร่างสูงล้มแผงผลไม้ ผลส้มกลิ้งไปทั่วลาน';
    script.respond((input) => {
      const action = input.actions.find((x) => x.memberId === t.b.memberId)!;
      return { entries: [{ kind: 'feed', locationId: action.locationId, actorMemberId: action.memberId, text: result }] };
    });

    await submitAndAccept(a, 'ดูของ');
    await submitAndAccept(b, 'ผลักแผงผลไม้');
    await submitAndAccept(c, 'เก็บสมุนไพร');
    const seenByA = await a.waitFor(isEntry);
    expect(seenByA.entry).toMatchObject({ kind: 'feed', text: result, place: { id: 'market', name: 'ลานตลาด' } });
    expect((await b.waitFor(isEntry)).entry.text).toBe(result);
    await c.waitFor(phaseIs(1, 'EOSORIA', 2));

    expect(c.entries()).toEqual([]);
    for (const frame of c.raw) expect(frame).not.toContain(result);
    // C walking to the market later does not see it either: witnesses are fixed when it was published.
    moveCharacter(server!.orm, t.c.memberId, 'market', CLOCK);
    expect((await enter(t.c, 0)).entries()).toEqual([]);
    expectNoForbiddenKeys(a, b, c);
  });

  it('the Human GM sees feed and narration from every place and cannot act', async () => {
    const t: Table = await startedTable(server!, true);
    moveCharacter(server!.orm, t.c.memberId, 'forest', CLOCK);
    const gm = await enter(t.gm!);
    const players: [Seat, RoomClient][] = [];
    for (const seat of [t.a, t.b, t.c]) players.push([seat, await enter(seat)]);
    script.respond(() => ({
      entries: [
        { kind: 'feed', locationId: 'forest', actorMemberId: t.c.memberId, text: 'เสียงกิ่งไม้หักในป่า' },
        { kind: 'narration', memberId: t.a.memberId, text: 'ความลับของ A' },
      ],
    }));
    expect(gm.lastRoom()!.you.lock?.code).toBe('not_a_player');
    const from = gm.messages.length;
    gm.action('GM ลองส่ง', 'public');
    expect((await gm.waitFor(isRejected, from)).code).toBe('not_a_player');

    for (const [, client] of players) await submitAndAccept(client, 'ทำอะไรสักอย่าง');
    await gm.waitFor(phaseIs(1, 'EOSORIA', 2));
    expect(gm.entries().map((e) => e.text)).toEqual(['เสียงกิ่งไม้หักในป่า', 'ความลับของ A']);
    expect(players[1]![1].entries()).toEqual([]);
  });
});
