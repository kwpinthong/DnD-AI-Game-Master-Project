import {
  GmAdjustResponse,
  GmConsoleResponse,
  GmInsertEventResponse,
  GmLogResponse,
  GmPendingTurn,
  defaultScenario,
  type RoomServerMessage,
} from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClosedPhase, PhaseResolution, PhaseResolver } from '../src/room/resolver.ts';
import type { RunningServer } from '../src/server.ts';
import { buildEventContext } from '../src/timeline/context.ts';
import { advanceTimeline } from '../src/timeline/store.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { moveCharacter, npcBondsOf, setNpcAffinity } from '../src/visibility/store.ts';
import { approveHeldTurn, heldTurn } from './gm-console-client.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

/** A resolver the test scripts: records each closed turn, answers with `respond`. */
function scriptedResolver() {
  const calls: ClosedPhase[] = [];
  let respond: (input: ClosedPhase) => PhaseResolution = () => ({});
  const resolver: PhaseResolver = {
    async resolve(input) {
      calls.push(input);
      return respond(input);
    },
  };
  return {
    resolver,
    calls,
    respond(f: (input: ClosedPhase) => PhaseResolution) {
      respond = f;
    },
  };
}

const ORIGINAL_A = 'ฉบับเดิมของ A: คุณเดินสำรวจตลาด';
const EDITED_A = 'ฉบับที่ GM แก้: คุณพบร่องรอยเขม่าควันใกล้แผงผ้า';
const FEED = 'มีคนที่นี่ลงมือทำบางอย่าง';
const SECRET_TEXT = 'แอบล้วงกระเป๋าพ่อค้า';
const REASON = 'ให้เรื่องเชื่อมกับเหตุไฟไหม้';

describe('GEN-058 Human GM console', { timeout: 60_000 }, () => {
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

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
  const characterRow = (memberId: string) =>
    server!.db.prepare('select hp, stamina, karma from character where member_id = ?').get(memberId) as { hp: number; stamina: number; karma: number };
  const phaseState = (t: Table) =>
    JSON.parse((server!.db.prepare('select state from game_phase where game_id = ?').get(gameIdOf(t)) as { state: string }).state) as {
      day: number;
      phase: string;
      turn: number;
      status: string;
      players: Record<string, { hp: number; stamina: number; karma: number }>;
    };
  const overrideCount = () => (server!.db.prepare('select count(*) as n from gm_override').get() as { n: number }).n;
  const turnIs = (turn: number) => (m: RoomServerMessage) => m.type === 'room' && m.turn === turn && m.status === 'collecting';

  async function act(client: RoomClient, text: string, visibility: 'public' | 'secret' = 'public') {
    const from = client.messages.length;
    client.action(text, visibility);
    expect(await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
  }

  /** Every console route as one request each (the scan in visibility-scan.test.ts lists them too). */
  const consoleRequests = (t: Table) => [
    { method: 'GET', path: '/api/game/gm/console' },
    { method: 'POST', path: '/api/game/gm/turn/edit', body: { reason: REASON, narrations: [{ index: 0, text: 'x' }] } },
    { method: 'POST', path: '/api/game/gm/turn/approve' },
    { method: 'POST', path: '/api/game/gm/adjust', body: { field: 'hp', memberId: t.a.memberId, value: 50, reason: REASON } },
    { method: 'POST', path: '/api/game/gm/events', body: { day: 6, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด', reason: REASON } },
    { method: 'GET', path: '/api/game/gm/log' },
    { method: 'PUT', path: '/api/game/gm/settings', body: { autoApproveLines: true } },
  ];

  it('C1: the GM console shows every karma, every Secret action and the Legendary conditions; players get 403', async () => {
    const t = await startedTable(server!, true);
    for (const [i, seat] of [t.a, t.b, t.c].entries()) server!.db.prepare('update character set karma = ? where member_id = ?').run(-30 + i * 25, seat.memberId);
    const b = await enter(t.b);
    await act(b, SECRET_TEXT, 'secret');

    const res = await t.call('GET', '/api/game/gm/console', { token: t.gm!.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const view = GmConsoleResponse.parse(res.body);
    expect(view.characters.map((c) => [c.memberId, c.karma])).toEqual([
      [t.a.memberId, -30],
      [t.b.memberId, -5],
      [t.c.memberId, 20],
    ]);
    expect(view.actions).toEqual([
      { memberId: t.b.memberId, day: 1, phase: 'EOSORIA', turn: 1, text: SECRET_TEXT, visibility: 'secret', rest: false },
    ]);
    expect(view.legendaries.map((l) => [l.id, l.condition])).toEqual(defaultScenario().legendaries.map((l) => [l.id, l.condition]));
    expect(view.events.map((e) => e.id)).toEqual(defaultScenario().timeline.map((e) => e.id));
    expect(view).toMatchObject({ at: { day: 1, phase: 'EOSORIA', turn: 1 }, status: 'collecting', pending: null });

    for (const seat of [t.a, t.b, t.c]) {
      for (const r of consoleRequests(t)) {
        const got = await t.call(r.method, r.path, { token: seat.token, ...(r.body ? { body: r.body } : {}) });
        expect(got.status, `${r.method} ${r.path} as ${seat.name}`).toBe(403);
        expect(got.body).toMatchObject({ code: 'forbidden' });
        expect(forbiddenKeysIn(got.body)).toEqual([]);
        expect(JSON.stringify(got.body)).not.toContain(SECRET_TEXT);
      }
    }
    for (const r of consoleRequests(t)) expect((await t.call(r.method, r.path, r.body ? { body: r.body } : {})).status).toBe(401);
    // Nothing a player sent changed anything.
    expect(characterRow(t.a.memberId).hp).toBe(100);
    expect(overrideCount()).toBe(0);
  });

  it('C2 (Q-030): the turn waits for the GM; the GM edits narration and HP; players get the edited version', async () => {
    const t = await startedTable(server!, true);
    script.respond(() => ({
      results: { [t.a.memberId]: { hp: 90 } },
      entries: [
        { kind: 'feed', locationId: 'inn', actorMemberId: t.a.memberId, text: FEED },
        { kind: 'narration', memberId: t.a.memberId, text: ORIGINAL_A },
      ],
    }));
    const gm = await enter(t.gm!);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await act(a, 'เดินสำรวจตลาด');
    await act(b, 'นั่งพัก');
    await act(c, 'ฟังข่าวลือ');

    const held = await heldTurn(t.call, t.gm!.token);
    expect(held.at).toEqual({ day: 1, phase: 'EOSORIA', turn: 1 });
    expect(held.entries).toEqual([
      { index: 0, kind: 'feed', memberId: null, locationId: 'inn', text: FEED, edited: false },
      { index: 1, kind: 'narration', memberId: t.a.memberId, locationId: null, text: ORIGINAL_A, edited: false },
    ]);
    expect(held.results.find((r) => r.memberId === t.a.memberId)).toEqual({
      memberId: t.a.memberId,
      before: { hp: 100, stamina: 30, karma: 0 },
      after: { hp: 90, stamina: 30, karma: 0 },
      edited: false,
    });
    // Waiting: nobody got anything of the turn; players and GM see why.
    await a.waitFor((m) => m.type === 'room' && m.gmStatus?.code === 'awaiting_gm');
    await gm.waitFor((m) => m.type === 'room' && m.gmStatus?.code === 'awaiting_gm');
    expect(a.lastRoom()!.gmStatus).toMatchObject({ code: 'awaiting_gm', canRetry: false });
    expect(a.lastRoom()!.gmStatus!.message).toMatch(/GM/);
    // ISK-014: only day 1's morning news (from the game start).
    for (const x of [a, b, c, gm]) expect(x.entries().filter((e) => e.kind !== 'news')).toEqual([]);
    expect(phaseState(t)).toMatchObject({ turn: 1, status: 'resolving' });

    const edit = await t.call('POST', '/api/game/gm/turn/edit', {
      token: t.gm!.token,
      body: { reason: REASON, narrations: [{ index: 1, text: EDITED_A }], results: [{ memberId: t.a.memberId, hp: 80, karma: -5 }] },
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const edited = GmPendingTurn.parse(edit.body);
    expect(edited.entries[1]).toMatchObject({ text: EDITED_A, edited: true });
    expect(edited.results.find((r) => r.memberId === t.a.memberId)).toMatchObject({ after: { hp: 80, stamina: 30, karma: -5 }, edited: true });
    // Still held: an edit does not publish.
    for (const x of [a, b, c]) expect(x.entries().filter((e) => e.kind !== 'news')).toEqual([]);

    const approve = await t.call('POST', '/api/game/gm/turn/approve', { token: t.gm!.token });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body).toEqual({ approved: { day: 1, phase: 'EOSORIA', turn: 1 } });

    const narration = await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'narration');
    expect(narration.type === 'entry' && narration.entry.text).toBe(EDITED_A);
    await a.waitFor(turnIs(2));
    for (const frame of a.raw) expect(frame).not.toContain(ORIGINAL_A);
    expect(b.entries().filter((e) => e.kind !== 'player' && e.kind !== 'news').map((e) => e.text)).toEqual([FEED]);
    expect(a.lastRoom()!.gmStatus).toBeNull();
    expect(characterRow(t.a.memberId)).toMatchObject({ hp: 80, karma: -5 });
    expect(phaseState(t).players[t.a.memberId]).toMatchObject({ hp: 80, karma: -5 });
    // The GM got the edited version too.
    await gm.waitFor((m) => m.type === 'entry' && m.entry.text === EDITED_A);
    // Nothing held any more.
    const after = GmConsoleResponse.parse((await t.call('GET', '/api/game/gm/console', { token: t.gm!.token })).body);
    expect(after.pending).toBeNull();
    expect((await t.call('POST', '/api/game/gm/turn/approve', { token: t.gm!.token })).status).toBe(409);
  });

  it('C2: GM edits survive a restart before the approval', async () => {
    let t = await startedTable(server!, true);
    script.respond(() => ({ entries: [{ kind: 'narration', memberId: t.a.memberId, text: ORIGINAL_A }] }));
    for (const seat of [t.a, t.b, t.c]) await act(await enter(seat), 'ทำอะไรสักอย่าง');
    await heldTurn(t.call, t.gm!.token);
    const edit = await t.call('POST', '/api/game/gm/turn/edit', { token: t.gm!.token, body: { reason: REASON, narrations: [{ index: 0, text: EDITED_A }] } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    server = await startTestServer(dataDir, { phaseResolver: script.resolver });
    t = { ...t, call: (await import('./visibility-fixture.ts')).caller(server) };

    // The console wakes the closed turn (nobody entered the room since the restart).
    const held = await heldTurn(t.call, t.gm!.token);
    expect(held.entries[0]).toMatchObject({ text: EDITED_A, edited: true });
    const a = await enter(t.a);
    await approveHeldTurn(t.call, t.gm!.token);
    const got = await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'narration');
    expect(got.type === 'entry' && got.entry.text).toBe(EDITED_A);
  });

  it('C3: values outside the rules are refused (HP 150, affinity 120, karma 101, Stamina 31, HP over the character max)', async () => {
    const t = await startedTable(server!, true);
    const merchant = defaultScenario().npcs.find((n) => n.id === 'merchant')!;
    setNpcAffinity(server!.orm, t.a.memberId, merchant, 12, CLOCK);
    const adjust = (body: Record<string, unknown>) => t.call('POST', '/api/game/gm/adjust', { token: t.gm!.token, body: { memberId: t.a.memberId, reason: REASON, ...body } });

    for (const [body, field] of [
      [{ field: 'hp', value: 150 }, 'value'],
      [{ field: 'hp', value: -1 }, 'value'],
      [{ field: 'affinity', npcId: 'merchant', value: 120 }, 'value'],
      [{ field: 'karma', value: 101 }, 'value'],
      [{ field: 'stamina', value: 31 }, 'value'],
      [{ field: 'hp', value: 50, reason: '  ' }, 'reason'],
      [{ field: 'affinity', npcId: 'no-such-npc', value: 10 }, 'npcId'],
    ] as const) {
      const res = await adjust(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_input' });
      const message = (res.body as { fields: Record<string, string> }).fields[field];
      expect(message, JSON.stringify(res.body)).toMatch(/[฀-๿]/);
    }
    // A character whose max HP is lower (GEN-069's 45) is held to its own max.
    server!.db.prepare('update character set hp = 45, hp_max = 45 where member_id = ?').run(t.b.memberId);
    expect((await t.call('POST', '/api/game/gm/adjust', { token: t.gm!.token, body: { field: 'hp', memberId: t.b.memberId, value: 50, reason: REASON } })).status).toBe(400);

    expect(characterRow(t.a.memberId)).toEqual({ hp: 100, stamina: 30, karma: 0 });
    expect(npcBondsOf(server!.orm, t.a.memberId)[0]!.affinity).toBe(12);
    expect(overrideCount()).toBe(0);

    // Within the rules it is applied to the character and the turn engine.
    const ok = await adjust({ field: 'hp', value: 70 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(GmAdjustResponse.parse(ok.body).override).toMatchObject({ kind: 'adjust', target: `${t.a.memberId}.hp`, before: 100, after: 70, reason: REASON });
    expect((await adjust({ field: 'affinity', npcId: 'merchant', value: -100 })).status).toBe(200);
    expect((await adjust({ field: 'karma', value: 100 })).status).toBe(200);
    expect(characterRow(t.a.memberId)).toMatchObject({ hp: 70, karma: 100 });
    expect(phaseState(t).players[t.a.memberId]).toMatchObject({ hp: 70, karma: 100 });
    expect(npcBondsOf(server!.orm, t.a.memberId)[0]!.affinity).toBe(-100);

    // A held turn's result is checked the same way, and nothing is stored when one value is wrong.
    script.respond(() => ({ entries: [{ kind: 'narration', memberId: t.a.memberId, text: ORIGINAL_A }] }));
    for (const seat of [t.a, t.b, t.c]) await act(await enter(seat), 'ทำอะไรสักอย่าง');
    await heldTurn(t.call, t.gm!.token);
    const before = overrideCount();
    const bad = await t.call('POST', '/api/game/gm/turn/edit', {
      token: t.gm!.token,
      body: { reason: REASON, narrations: [{ index: 0, text: EDITED_A }], results: [{ memberId: t.a.memberId, hp: 150 }] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'invalid_input' });
    expect(Object.values((bad.body as { fields: Record<string, string> }).fields).join(' ')).toMatch(/[฀-๿]/);
    expect((await t.call('POST', '/api/game/gm/turn/edit', { token: t.gm!.token, body: { reason: REASON, narrations: [{ index: 5, text: 'x' }] } })).status).toBe(400);
    expect(overrideCount()).toBe(before);
    expect((await heldTurn(t.call, t.gm!.token)).entries[0]).toMatchObject({ text: ORIGINAL_A, edited: false });
    // Between turns only: while a turn is held the GM edits that turn instead.
    expect((await adjust({ field: 'hp', value: 60 })).status).toBe(409);
  });

  it('C4: an event the GM inserts ("ไฟไหม้ตลาด") is in the context of the next turn', async () => {
    const t = await startedTable(server!, true);
    const gameId = gameIdOf(t);

    // Now (day 1 EOSORIA): active at once, so the turn that closes next has it.
    const now = await t.call('POST', '/api/game/gm/events', {
      token: t.gm!.token,
      body: { day: 1, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด', description: 'ควันดำลอยขึ้นจากแผงผ้า', locationId: 'market', reason: REASON },
    });
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect(GmInsertEventResponse.parse(now.body).event).toMatchObject({ day: 1, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด', status: 'active' });
    let seen: string[] = [];
    script.respond((input) => {
      seen = buildEventContext(server!.orm, input.gameId, input.at.day, input.at.phase).active.map((e) => e.title);
      return {};
    });
    for (const seat of [t.a, t.b, t.c]) await act(await enter(seat), 'ทำอะไรสักอย่าง');
    await approveHeldTurn(t.call, t.gm!.token);
    expect(seen).toContain('ไฟไหม้ตลาด');

    // Day 6: waits on the timeline like any scenario event, then is active in that period's turns.
    const later = await t.call('POST', '/api/game/gm/events', {
      token: t.gm!.token,
      body: { day: 6, phase: 'SOLARION', title: 'ไฟไหม้ตลาด', locationId: 'market', reason: REASON },
    });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    const id = GmInsertEventResponse.parse(later.body).event.id;
    expect(GmInsertEventResponse.parse(later.body).event.status).toBe('pending');
    const playerTimeline = await t.call('GET', '/api/game/timeline', { token: t.a.token });
    expect(JSON.stringify(playerTimeline.body)).not.toContain(id);
    expect(advanceTimeline(server!.orm, gameId, { day: 6, phase: 'SOLARION' }, CLOCK)).toMatchObject({ ok: true, activated: [id] });
    expect(buildEventContext(server!.orm, gameId, 6, 'SOLARION').active.map((e) => e.title)).toContain('ไฟไหม้ตลาด');

    // The past, an unknown place or a day outside the game are refused.
    for (const body of [
      { day: 1, phase: 'EOSORIA', title: 'ย้อนเวลา', reason: REASON },
      { day: 7, phase: 'EOSORIA', title: 'ที่ไม่มีจริง', locationId: 'atlantis', reason: REASON },
      { day: 13, phase: 'EOSORIA', title: 'หลังจบ', reason: REASON },
    ]) {
      const res = await t.call('POST', '/api/game/gm/events', { token: t.gm!.token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_input' });
    }
  });

  it('C5: every override is logged with who, what and why; the GM reads it back, players never see it', async () => {
    const t = await startedTable(server!, true);
    moveCharacter(server!.orm, t.a.memberId, 'market', CLOCK);
    const adjusted = await t.call('POST', '/api/game/gm/adjust', { token: t.gm!.token, body: { field: 'stamina', memberId: t.b.memberId, value: 20, reason: 'โดนพิษจากควัน' } });
    expect(adjusted.status).toBe(200);
    expect((await t.call('POST', '/api/game/gm/events', { token: t.gm!.token, body: { day: 6, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด', reason: 'เพิ่มแรงกดดันกลางเรื่อง' } })).status).toBe(200);
    script.respond(() => ({ entries: [{ kind: 'narration', memberId: t.a.memberId, text: ORIGINAL_A }] }));
    const players = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const p of players) await act(p, 'ทำอะไรสักอย่าง');
    await heldTurn(t.call, t.gm!.token);
    await t.call('POST', '/api/game/gm/turn/edit', {
      token: t.gm!.token,
      body: { reason: REASON, narrations: [{ index: 0, text: EDITED_A }], results: [{ memberId: t.c.memberId, hp: 95 }] },
    });
    await approveHeldTurn(t.call, t.gm!.token);

    const log = await t.call('GET', '/api/game/gm/log', { token: t.gm!.token });
    expect(log.status).toBe(200);
    const overrides = GmLogResponse.parse(log.body).overrides;
    const who = { gmMemberId: t.gm!.memberId, gmName: 'จีเอ็ม' };
    expect(overrides.map((o) => ({ ...o, id: 0, createdAt: 0 }))).toEqual([
      { ...who, id: 0, createdAt: 0, kind: 'adjust', at: { day: 1, phase: 'EOSORIA', turn: 1 }, target: `${t.b.memberId}.stamina`, before: 30, after: 20, reason: 'โดนพิษจากควัน' },
      expect.objectContaining({ ...who, kind: 'event', at: { day: 1, phase: 'EOSORIA', turn: 1 }, before: null, reason: 'เพิ่มแรงกดดันกลางเรื่อง' }),
      { ...who, id: 0, createdAt: 0, kind: 'narration', at: { day: 1, phase: 'EOSORIA', turn: 1 }, target: 'entry:0', before: ORIGINAL_A, after: EDITED_A, reason: REASON },
      { ...who, id: 0, createdAt: 0, kind: 'result', at: { day: 1, phase: 'EOSORIA', turn: 1 }, target: `${t.c.memberId}.hp`, before: 100, after: 95, reason: REASON },
      // Q-176: the approval itself is a row too, with how many edits it published.
      { ...who, id: 0, createdAt: 0, kind: 'approve', at: { day: 1, phase: 'EOSORIA', turn: 1 }, target: 'turn', before: null, after: { edits: 2 }, reason: '' },
    ]);
    expect(overrides[1]!.target).toMatch(/^event:/);
    expect(overrides[1]!.after).toMatchObject({ day: 6, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด' });

    expect((await t.call('GET', '/api/game/gm/log', { token: t.a.token })).status).toBe(403);
    await players[0]!.waitFor(turnIs(2));
    for (const p of players) {
      for (const frame of p.raw) {
        for (const secret of ['โดนพิษจากควัน', 'เพิ่มแรงกดดันกลางเรื่อง', REASON, ORIGINAL_A]) expect(frame).not.toContain(secret);
      }
    }
  });

  it('Q-176: approving a turn with no edits still logs one "approve" row for that turn; a refused approve logs nothing', async () => {
    const t = await startedTable(server!, true);
    expect((await t.call('POST', '/api/game/gm/turn/approve', { token: t.gm!.token })).status).toBe(409);
    expect(overrideCount()).toBe(0);
    script.respond(() => ({ entries: [{ kind: 'narration', memberId: t.a.memberId, text: ORIGINAL_A }] }));
    const players = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const p of players) await act(p, 'ทำอะไรสักอย่าง');
    await approveHeldTurn(t.call, t.gm!.token);
    const overrides = GmLogResponse.parse((await t.call('GET', '/api/game/gm/log', { token: t.gm!.token })).body).overrides;
    expect(overrides).toEqual([
      expect.objectContaining({ gmMemberId: t.gm!.memberId, kind: 'approve', at: { day: 1, phase: 'EOSORIA', turn: 1 }, target: 'turn', before: null, after: { edits: 0 } }),
    ]);
    // Players still never see the log.
    await players[0]!.waitFor(turnIs(2));
    for (const p of players) for (const frame of p.raw) expect(frame).not.toContain('"approve"');
  });

  it('C6: a game without a Human GM publishes each turn at once; its owner has no console', async () => {
    const t = await startedTable(server!, false);
    script.respond(() => ({ entries: [{ kind: 'narration', memberId: t.a.memberId, text: ORIGINAL_A }] }));
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await act(a, 'เดินสำรวจตลาด');
    await act(b, 'นั่งพัก');
    await act(c, 'ฟังข่าวลือ');
    const got = await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'narration');
    expect(got.type === 'entry' && got.entry.text).toBe(ORIGINAL_A);
    await a.waitFor(turnIs(2));
    expect(a.messages.some((m) => m.type === 'room' && m.gmStatus?.code === 'awaiting_gm')).toBe(false);
    for (const r of consoleRequests(t)) {
      expect((await t.call(r.method, r.path, { token: t.a.token, ...(r.body ? { body: r.body } : {}) })).status, `${r.method} ${r.path}`).toBe(403);
    }
  });
});
