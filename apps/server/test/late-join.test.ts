import { ApiError, CharacterResponse, CreateGameResponse, JoinResponse, LootResponse, OriginResponse, type RoomServerMessage } from '@isekai/protocol';
import { SeededRng, phaseStep, turnNumber, type PhaseState, type Rng, type TurnPoint } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { createMockProvider, mockReply } from '../src/ai/providers/mock.ts';
import type { ClosedPhase, PhaseResolution, PhaseResolver } from '../src/room/resolver.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer, ServerOptions } from '../src/server.ts';
import { makeTempDir, seedChosenLoot } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

/**
 * ISK-015: a friend who comes late joins a started Online game with the invite code (up to day 9), makes a
 * character, picks loot, spawns, and plays from the next turn; the turns never wait for them meanwhile.
 */

const NEWCOMER = { name: 'ราตรี', appearance: 'หญิงสาวผมแดงถือพิณเก่า', personality: 'ร่าเริง ชอบร้องเพลง ขี้สงสัย' };
const isNarration = (r: AiCallRequest) => r.output.name === 'origin_narration';
const promptOf = (r: AiCallRequest) => [...r.system.map((b) => b.text), ...r.messages.map((m) => m.text)].join('\n');
/** Every draw is its lowest value: every start scenario is the first row (นักดนตรีพเนจรตกอับ, Karma 5). */
const lowest: Rng = { nextInt: (min) => min };

/** Holds a turn's resolution until `release` (to spawn while the turn is resolving). */
function gatedResolver() {
  const calls: ClosedPhase[] = [];
  let gate: Promise<void> | null = null;
  let open = () => {};
  const resolver: PhaseResolver = {
    async resolve(input): Promise<PhaseResolution> {
      calls.push(input);
      if (gate) await gate;
      return {};
    },
  };
  return {
    resolver,
    calls,
    hold() {
      gate = new Promise<void>((r) => (open = r));
    },
    release() {
      gate = null;
      open();
    },
  };
}

/** Plays the engine forward to `to` (everyone acts), as if the turns were played. */
function advance(state: PhaseState, to: TurnPoint): PhaseState {
  let s = state;
  for (let guard = 0; guard < 200 && turnNumber(s) < turnNumber(to); guard++) {
    for (const id of s.order) {
      const r = phaseStep(s, { type: 'submit', playerId: id, action: { text: 'เดินเล่น', visibility: 'public' } }, new SeededRng(1));
      if (!r.ok) throw new Error(r.error.code);
      s = r.state;
    }
    const r = phaseStep(s, { type: 'resolved', results: {} }, new SeededRng(1));
    if (!r.ok) throw new Error(r.error.code);
    s = r.state;
  }
  return s;
}

const errorOf = (body: unknown) => ApiError.parse(body);

describe('ISK-015 join a started game', { timeout: 90_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let gated: ReturnType<typeof gatedResolver>;
  const sockets: RoomClient[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    gated = gatedResolver();
  });

  afterEach(async () => {
    gated.release();
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function boot(options: ServerOptions = {}) {
    server = await startTestServer(dataDir, { phaseResolver: gated.resolver, ...options });
    return server;
  }

  const dbGet = <T>(sql: string, ...args: unknown[]) => server!.db.prepare(sql).get(...args) as T;
  const gameIdOf = (memberId: string) => dbGet<{ game_id: string }>('select game_id from member where id = ?', memberId).game_id;
  const memberCount = (gameId: string) => dbGet<{ n: number }>("select count(*) as n from member where game_id = ? and role = 'player' and kicked_at is null", gameId).n;
  const stateOf = (t: Table) => ensurePhaseState(server!.orm, gameIdOf(t.a.memberId), CLOCK);

  function jumpTo(t: Table, to: TurnPoint, edit: (s: PhaseState) => PhaseState = (s) => s): void {
    const gameId = gameIdOf(t.a.memberId);
    savePhaseState(server!.orm, gameId, edit(advance(ensurePhaseState(server!.orm, gameId, CLOCK), to)), CLOCK);
  }

  async function postJoin(t: Pick<Table, 'call' | 'inviteCode'>, name: string, pin = '2222') {
    return t.call('POST', '/api/join', { body: { inviteCode: t.inviteCode, name, pin } });
  }

  async function lateJoin(t: Pick<Table, 'call' | 'inviteCode'>, name: string) {
    const res = await postJoin(t, name);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const joined = JoinResponse.parse(res.body);
    return { token: joined.token, memberId: joined.member.id, created: joined.created };
  }

  /** Joins, makes the character, keeps a loot choice and spawns. */
  async function spawned(t: Table, name = 'ดี', identity = NEWCOMER) {
    const n = await lateJoin(t, name);
    const made = await t.call('POST', '/api/game/character', { token: n.token, body: identity });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    seedChosenLoot(server!.db, n.memberId);
    const spawn = await t.call('POST', '/api/game/spawn', { token: n.token });
    expect(spawn.status, JSON.stringify(spawn.body)).toBe(200);
    return n;
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function send(client: RoomClient, text: string) {
    const from = client.messages.length;
    client.action(text, 'public');
    return client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
  }

  const at = (p: TurnPoint) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === p.day && m.phase === p.phase && m.turn === p.turn && m.status === 'collecting';

  /** Every client sends; resolves once `watcher` sees the turn `next` open. */
  async function playTurn(clients: RoomClient[], next: TurnPoint, watcher = clients[0]!) {
    for (const c of clients) expect(await send(c, 'เดินดูรอบเมือง')).toEqual({ type: 'action_accepted' });
    await watcher.waitFor(at(next));
  }

  it('C1: day 4, 3 players: a newcomer joins with the code and goes on to make a character', async () => {
    await boot();
    const t = await startedTable(server!, false);
    jumpTo(t, { day: 4, phase: 'EOSORIA', turn: 1 });

    const n = await lateJoin(t, 'ดี');
    expect(n.created).toBe(true);
    expect(CharacterResponse.parse((await t.call('GET', '/api/game/character', { token: n.token })).body).character).toBeNull();
    const made = await t.call('POST', '/api/game/character', { token: n.token, body: NEWCOMER });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(CharacterResponse.parse(made.body).character).toMatchObject({ name: NEWCOMER.name, editable: true });
    // Not spawned yet: no start scenario, and the room is not open to them yet.
    expect(OriginResponse.parse((await t.call('GET', '/api/game/origin', { token: n.token })).body)).toEqual({ view: 'player', origin: null });
    expect(memberCount(gameIdOf(t.a.memberId))).toBe(4);
  });

  it('C2 + C10 (cut at join time): day 9 joins; day 10 answers 409 join_closed_day', async () => {
    await boot();
    const t = await startedTable(server!, false);
    jumpTo(t, { day: 9, phase: 'NOCTHERION', turn: 2 });
    await lateJoin(t, 'ดี');

    jumpTo(t, { day: 10, phase: 'EOSORIA', turn: 1 });
    const late = await postJoin(t, 'อี');
    expect(late.status).toBe(409);
    expect(errorOf(late.body).code).toBe('join_closed_day');
    expect(errorOf(late.body).message).toMatch(/[ก-๙]/);
  });

  it('C3: 6 players is full (409 game_full); the Human GM takes no seat', async () => {
    await boot();
    const t = await startedTable(server!, true);
    for (const name of ['ดี', 'อี', 'เอฟ']) await lateJoin(t, name);
    expect(memberCount(gameIdOf(t.a.memberId))).toBe(6);

    const seventh = await postJoin(t, 'จี');
    expect(seventh.status).toBe(409);
    expect(errorOf(seventh.body).code).toBe('game_full');
  });

  it('C4: Single = 409 single_mode; an ended game = 409 game_ended; a kicked member = 403 kicked', async () => {
    await boot();
    const call = caller(server!);
    const single = CreateGameResponse.parse(
      (await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'คนเดียว', mode: 'single', humanGm: false, name: 'นก', pin: '1234' } })).body,
    );
    expect((await call('POST', '/api/game/character', { token: single.token, body: NEWCOMER })).status).toBe(201);
    seedChosenLoot(server!.db, single.member.id);
    expect((await call('POST', '/api/game/start', { token: single.token })).status).toBe(200);
    const solo = await postJoin({ call, inviteCode: single.game.inviteCode }, 'ดี');
    expect(solo.status).toBe(409);
    expect(errorOf(solo.body).code).toBe('single_mode');

    const t = await startedTable(server!, false);
    server!.db.prepare('update member set kicked_at = 1 where id = ?').run(t.c.memberId);
    const kicked = await postJoin(t, 'ซี', '1111');
    expect(kicked.status).toBe(403);
    expect(errorOf(kicked.body).code).toBe('kicked');

    jumpTo(t, { day: 3, phase: 'EOSORIA', turn: 1 }, (s) => ({ ...s, status: 'game_over' }));
    const ended = await postJoin(t, 'ดี');
    expect(ended.status).toBe(409);
    expect(errorOf(ended.body).code).toBe('game_ended');
  });

  it('C5: while the newcomer makes their character, the 3 players\' turn closes without them', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const n = await lateJoin(t, 'ดี');
    expect((await t.call('POST', '/api/game/character', { token: n.token, body: NEWCOMER })).status).toBe(201);

    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn([a, b, c], { day: 1, phase: 'EOSORIA', turn: 2 });
    expect(gated.calls).toHaveLength(1);
    expect(stateOf(t).order).not.toContain(n.memberId);
  });

  it('C6: spawned = Karma 0 at the start scenario; acts from the next turn, which then waits for them', async () => {
    await boot({ rng: lowest });
    const t = await startedTable(server!, false);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const n = await spawned(t);
    expect(dbGet<{ karma: number }>('select karma from character where member_id = ?', t.a.memberId).karma).toBe(5);
    expect(dbGet<{ karma: number }>('select karma from character where member_id = ?', n.memberId).karma).toBe(0);
    expect(dbGet<{ start_scenario: string }>('select start_scenario from character_origin where member_id = ?', n.memberId).start_scenario).toBe('นักดนตรีพเนจรตกอับ');

    // The turn they spawned in is not theirs.
    const room = await enter(n);
    expect(room.lastRoom()!.you.lock?.code).toBe('arriving');
    expect(await send(room, 'มองไปรอบ ๆ')).toMatchObject({ type: 'action_rejected', code: 'arriving' });

    await playTurn([a, b, c], { day: 1, phase: 'EOSORIA', turn: 2 });
    await room.waitFor(at({ day: 1, phase: 'EOSORIA', turn: 2 }));
    expect(room.lastRoom()!.you.lock).toBeNull();
    // The next turn waits for them.
    for (const p of [a, b, c]) expect(await send(p, 'รอคนใหม่')).toEqual({ type: 'action_accepted' });
    expect(gated.calls).toHaveLength(1);
    expect(await send(room, 'ทักทายทุกคน')).toEqual({ type: 'action_accepted' });
    await a.waitFor(at({ day: 1, phase: 'SOLARION', turn: 1 }));
    expect(gated.calls[1]!.actions.map((x) => x.memberId)).toContain(n.memberId);
  });

  it('C6: spawned while the turn is resolving: they act from the turn that opens next', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    gated.hold();
    for (const p of [a, b, c]) expect(await send(p, 'เดินเล่น')).toEqual({ type: 'action_accepted' });
    await a.waitFor((m) => m.type === 'room' && m.status === 'resolving');
    const n = await spawned(t);
    gated.release();
    await a.waitFor(at({ day: 1, phase: 'EOSORIA', turn: 2 }));
    expect(stateOf(t).order).toContain(n.memberId);
    expect(stateOf(t).players[n.memberId]).toMatchObject({ mustSubmit: true, condition: 'awake', karma: 0 });
  });

  it('C7: the newcomer\'s crossing tells the public story so far (≤ 400), never a Secret or an unknown real name', async () => {
    const base = createMockProvider(loadAiConfig({ AI_PROVIDER: 'mock' }));
    let story = '';
    let narrationWorks = true;
    const provider: AiProvider = {
      ...base,
      async call(req): Promise<AiCallResult> {
        if (!isNarration(req)) return base.call(req);
        base.requests.push(req);
        if (!narrationWorks) return mockReply.fail('provider_error');
        return mockReply.ok({ narration: 'แสงสีขาวกลืนคุณหายไป แล้วคุณก็ลืมตาขึ้นที่น้ำพุ', story });
      },
    };
    await boot({ aiProvider: provider, rng: lowest });
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t.a.memberId);
    const secret = 'แอบขโมยกุญแจห้องเก็บของจากโบสถ์';
    server!.db.prepare("insert into phase_action (game_id, day, phase, turn, member_id, text, visibility, rest, submitted_at, seq) values (?, 1, 'EOSORIA', 1, ?, ?, 'secret', 0, 1, 1)").run(gameId, t.b.memberId, secret);
    server!.db
      .prepare("insert into gm_memory (game_id, kind, day, text, created_at) values (?, 'saga', 2, ?, 1)")
      .run(gameId, `ตลาดถูกไฟไหม้ {{p:${t.a.memberId}}} ช่วยดับไฟ / {{p:${t.b.memberId}}} ${secret}`);

    const origin = async (token: string) => {
      const body = OriginResponse.parse((await t.call('GET', '/api/game/origin', { token })).body);
      if (body.view !== 'player' || body.origin === null) throw new Error(JSON.stringify(body));
      return body.origin;
    };

    // The AI gets the saga (names as tokens) and is told to keep it public; its story is shown with unknown names hidden.
    story = `ก่อนหน้านี้ตลาดถูกไฟไหม้ {{p:${t.a.memberId}}} ช่วยดับไฟ ${'เมืองยังวุ่นวาย '.repeat(40)}`;
    const n = await spawned(t);
    const told = (await origin(n.token)).narration!;
    const asked = base.requests.filter(isNarration).at(-1)!;
    expect(promptOf(asked)).toContain('ตลาดถูกไฟไหม้');
    expect(promptOf(asked)).not.toContain('ลิน');
    expect(promptOf(asked)).toMatch(/400/);
    expect(told).toContain('ตลาดถูกไฟไหม้');
    expect(told).toContain('ใครบางคน');
    for (const name of ['ลิน', 'นก', 'ดาริน', 'บี']) expect(told).not.toContain(name);
    const shown = told.slice(told.indexOf('ก่อนหน้านี้'));
    expect([...shown].length).toBeLessThanOrEqual(400);

    // A story that carries a Secret action is dropped; the crossing itself stays.
    story = `ตลาดถูกไฟไหม้ และมีคน${secret}`;
    const m = await spawned(t, 'อี', { ...NEWCOMER, name: 'อรุณ' });
    const second = (await origin(m.token)).narration!;
    expect(second).toContain('แสงสีขาว');
    expect(second).not.toContain(secret);

    // The AI is down: the old fallback (no narration yet, written on a later read), no story.
    narrationWorks = false;
    const o = await spawned(t, 'เอฟ', { ...NEWCOMER, name: 'โอ' });
    expect((await origin(o.token)).narration).toBeNull();

    // No saga yet: the AI is not asked for a story and none is shown.
    server!.db.prepare('delete from gm_memory').run();
    narrationWorks = true;
    story = 'เรื่องที่ไม่ควรมี';
    const t2 = await startedTable(server!, false);
    const p = await spawned(t2, 'จี', { ...NEWCOMER, name: 'พิม' });
    const plain = (await origin(p.token)).narration!;
    expect(plain).not.toContain('เรื่องที่ไม่ควรมี');
    expect(promptOf(base.requests.filter(isNarration).at(-1)!)).not.toMatch(/story so far/i);
  });

  it('C8: the players who do not know the newcomer see "someone new" with a look, never the name', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const n = await spawned(t, 'ดี', { ...NEWCOMER, appearance: `${NEWCOMER.name} หญิงสาวผมแดงถือพิณเก่า` });
    await playTurn([a, b, c], { day: 1, phase: 'EOSORIA', turn: 2 });
    const arrival = await a.waitFor((m) => m.type === 'entry' && m.entry.text.includes('ผมแดง'));
    if (arrival.type !== 'entry') throw new Error('expected an entry');
    expect(arrival.entry.text).toContain('มาใหม่');
    expect(arrival.entry.text).not.toContain(NEWCOMER.name);
    expect(arrival.entry.text).not.toContain('ดี ');
    const own = await enter(n);
    expect(own.entries().some((e) => e.text.includes('ผมแดง') && e.text.includes('มาใหม่'))).toBe(false);
  });

  it('C9: joined on day 9, the game reaches day 10 meanwhile (1 period): still makes a character and plays', async () => {
    await boot();
    const t = await startedTable(server!, false);
    jumpTo(t, { day: 9, phase: 'NOCTHERION', turn: 2 });
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const n = await lateJoin(t, 'ดี');
    await playTurn([a, b, c], { day: 10, phase: 'EOSORIA', turn: 1 });

    expect((await t.call('POST', '/api/game/character', { token: n.token, body: NEWCOMER })).status).toBe(201);
    seedChosenLoot(server!.db, n.memberId);
    expect((await t.call('POST', '/api/game/spawn', { token: n.token })).status).toBe(200);
    await playTurn([a, b, c], { day: 10, phase: 'EOSORIA', turn: 2 });
    expect(stateOf(t).order).toContain(n.memberId);
  });

  it('C10: joining before the start works as before (no late-join record, starts with the others)', async () => {
    await boot();
    const t = await startedTable(server!, false);
    expect(dbGet<{ n: number }>('select count(*) as n from late_join').n).toBe(0);
    expect(stateOf(t).order).toEqual([t.a.memberId, t.b.memberId, t.c.memberId]);
  });

  it('C11: 5 players and 2 join at once: one gets in, the other gets 409 game_full', async () => {
    await boot();
    const t = await startedTable(server!, false);
    await lateJoin(t, 'ดี');
    await lateJoin(t, 'อี');
    const results = await Promise.all([postJoin(t, 'เอฟ'), postJoin(t, 'จี')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(errorOf(results.find((r) => r.status === 409)!.body).code).toBe('game_full');
    expect(memberCount(gameIdOf(t.a.memberId))).toBe(6);
  });

  it('C12: a member who uses the code again reconnects (no game_full, no new member)', async () => {
    await boot();
    const t = await startedTable(server!, false);
    for (const name of ['ดี', 'อี', 'เอฟ']) await lateJoin(t, name);
    const again = await postJoin(t, 'บี', '1111');
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(JoinResponse.parse(again.body)).toMatchObject({ created: false, member: { id: t.b.memberId } });
    const late = await postJoin(t, 'ดี');
    expect(late.status).toBe(200);
    expect(JoinResponse.parse(late.body).created).toBe(false);
    expect(memberCount(gameIdOf(t.a.memberId))).toBe(6);
  });

  it('C13: not spawned once the game is a whole period past: the seat is free and the member is out', async () => {
    await boot();
    const t = await startedTable(server!, false);
    jumpTo(t, { day: 4, phase: 'EOSORIA', turn: 1 });
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const n = await lateJoin(t, 'ดี');
    await playTurn([a, b, c], { day: 4, phase: 'EOSORIA', turn: 2 });
    await playTurn([a, b, c], { day: 4, phase: 'SOLARION', turn: 1 });
    // One period on: still in. Two more join (6 players): the game is full.
    await lateJoin(t, 'อี');
    await lateJoin(t, 'เอฟ');
    expect(errorOf((await postJoin(t, 'จี')).body).code).toBe('game_full');
    expect((await t.call('GET', '/api/me', { token: n.token })).status).toBe(200);

    await playTurn([a, b, c], { day: 4, phase: 'SOLARION', turn: 2 });
    await playTurn([a, b, c], { day: 4, phase: 'HESPERION', turn: 1 });
    expect((await t.call('GET', '/api/me', { token: n.token })).status).toBe(401);
    expect(dbGet<{ n: number }>('select count(*) as n from member where id = ?', n.memberId).n).toBe(0);
    expect((await postJoin(t, 'จี')).status).toBe(200);
    // The ones who joined one period later are still in.
    expect(memberCount(gameIdOf(t.a.memberId))).toBe(6);
  });

  it('C14: a refresh on the loot step comes back to the same step with the offer and the choice kept', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const n = await lateJoin(t, 'ดี');
    expect((await t.call('POST', '/api/game/character', { token: n.token, body: NEWCOMER })).status).toBe(201);
    const rolled = await t.call('POST', '/api/game/character/loot', { token: n.token });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
    const offer = LootResponse.parse(rolled.body).loot.offer!;
    expect(LootResponse.parse((await t.call('GET', '/api/game/character/loot', { token: n.token })).body).loot.offer).toEqual(offer);

    const pick = { skillIds: [offer.skills[0]!.id], itemIds: [offer.items[0]!.id] };
    expect((await t.call('POST', '/api/game/character/loot/choose', { token: n.token, body: pick })).status).toBe(200);
    const after = LootResponse.parse((await t.call('GET', '/api/game/character/loot', { token: n.token })).body).loot;
    expect(after.chosen).toMatchObject({ skill: { id: offer.skills[0]!.id }, item: { id: offer.items[0]!.id } });
    expect(after.canReroll).toBe(true);
    expect(OriginResponse.parse((await t.call('GET', '/api/game/origin', { token: n.token })).body)).toEqual({ view: 'player', origin: null });
    // Spawning needs the choice; without one it is refused.
    const m = await lateJoin(t, 'อี');
    expect((await t.call('POST', '/api/game/character', { token: m.token, body: { ...NEWCOMER, name: 'อรุณ' } })).status).toBe(201);
    const early = await t.call('POST', '/api/game/spawn', { token: m.token });
    expect(early.status).toBe(409);
    expect(errorOf(early.body).code).toBe('not_allowed');
  });

  it('C15: the newcomer gets no entry from before they arrived', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn([a, b, c], { day: 1, phase: 'EOSORIA', turn: 2 });
    const before = a.entries().length;
    expect(before).toBeGreaterThan(0);
    const n = await spawned(t);
    await playTurn([a, b, c], { day: 1, phase: 'SOLARION', turn: 1 });

    const own = await enter(n);
    const first = turnNumber({ day: 1, phase: 'SOLARION', turn: 1 });
    for (const e of own.entries()) expect(turnNumber(e), e.text).toBeGreaterThanOrEqual(first);
    const log = await t.call('GET', '/api/game/log', { token: n.token });
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.body)).not.toContain('เดินดูรอบเมือง');
  });

  it('C16: a game started before the deploy plays on: its players have no late-join record and are seated', async () => {
    await boot();
    const t = await startedTable(server!, false);
    // As a game that started before the migration: nothing in late_join, the stored state made before.
    expect(dbGet<{ n: number }>('select count(*) as n from late_join').n).toBe(0);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn([a, b, c], { day: 1, phase: 'EOSORIA', turn: 2 });
    expect((await postJoin(t, 'บี', '1111')).status).toBe(200);
  });
});
