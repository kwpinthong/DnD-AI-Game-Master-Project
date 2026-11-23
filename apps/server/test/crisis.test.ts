import { GameLogResponse, OMEN_MAX_LENGTH, type RoomServerMessage, type RoomState } from '@isekai/protocol';
import type { PhaseState, PlayerPhaseState } from '@isekai/rules';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { character } from '../src/db/schema.ts';
import type { TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { GM_OUTPUT } from '../src/gm/schema.ts';
import type { ClosedPhase, PhaseResolution, PhaseResolver } from '../src/room/resolver.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { ASTRAL_PLANE, moveCharacter, presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-070 Crisis & death in the play room: Stamina 0 (forced REST +6, hits ×1.3), HP 0 (out cold one turn,
 * then the central clinic: 2 turns, half the coins), EXECUTE while out cold (an Astral Spirit: every place's
 * public feed read-only, one omen a night), and the game over when everyone is dead.
 */

type Handler = (req: AiCallRequest) => AiCallResult | undefined;

function gmProvider(handler: Handler): AiProvider {
  return {
    id: 'mock',
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      const scripted = handler(req);
      if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
      return mockReply.ok(await cannedGmAnswer(req));
    },
  };
}

describe('GEN-070 crisis & death', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let respond: (input: ClosedPhase) => PhaseResolution = () => ({});
  const calls: ClosedPhase[] = [];
  const sockets: RoomClient[] = [];
  const scripted: PhaseResolver = {
    async resolve(input) {
      calls.push(input);
      return respond(input);
    },
  };

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    respond = () => ({});
    calls.length = 0;
  });

  afterEach(async () => {
    for (const s of sockets) for (const m of s.messages) expect(forbiddenKeysIn(m)).toEqual([]);
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function boot(options: { ai?: Handler } = {}): Promise<Table> {
    server = await startTestServer(
      dataDir,
      options.ai
        ? { aiProvider: gmProvider(options.ai), ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }) }
        : { phaseResolver: scripted },
    );
    return startedTable(server, false);
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const state = (t: Table) => ensurePhaseState(server!.orm, gameIdOf(t), CLOCK);
  const row = (seat: Seat) => server!.orm.select().from(character).where(eq(character.memberId, seat.memberId)).get()!;
  const setCoins = (seat: Seat, coins: number) => server!.orm.update(character).set({ coins }).where(eq(character.memberId, seat.memberId)).run();
  const refOf = (seat: Seat) => presenceOf(server!.orm, seat.memberId)!.ref;

  /** Edits the stored engine state (before anyone is in the room). */
  function patch(t: Table, at: Partial<PhaseState>, players: Partial<Record<'a' | 'b' | 'c', Partial<PlayerPhaseState>>> = {}) {
    const s = state(t);
    const next = { ...s, ...at, players: { ...s.players } };
    for (const [key, p] of Object.entries(players)) {
      const id = t[key as 'a' | 'b' | 'c'].memberId;
      next.players[id] = { ...next.players[id]!, ...p };
    }
    savePhaseState(server!.orm, gameIdOf(t), next, CLOCK);
  }

  const dead = (at = { day: 1, phase: 'EOSORIA' as const, turn: 1 as const }): Partial<PlayerPhaseState> => ({ hp: 0, condition: 'astral_spirit', mustSubmit: false, diedAt: at });
  /** What the server does at a death: the spirit leaves the world (its presence goes to the astral plane). */
  const bury = (seat: Seat) => expect(moveCharacter(server!.orm, seat.memberId, ASTRAL_PLANE, CLOCK)).toBe(true);

  async function send(client: RoomClient, text = 'เดินดูรอบๆ') {
    const from = client.messages.length;
    client.action(text, 'public');
    const reply = await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
    expect(reply, JSON.stringify(reply)).toEqual({ type: 'action_accepted' });
  }

  const turnIs = (turn: number, phase = 'EOSORIA', day = 1) => (m: RoomServerMessage): m is RoomState =>
    m.type === 'room' && m.status === 'collecting' && m.day === day && m.phase === phase && m.turn === turn;

  async function omen(client: RoomClient, to: string, text: string) {
    const from = client.messages.length;
    client.send({ type: 'omen', to, text });
    return client.waitFor((m) => m.type === 'omen_accepted' || m.type === 'omen_rejected', from);
  }

  it('C1: Stamina 0 locks the next turn as a forced REST (+6); the turn does not wait for them', async () => {
    const t = await boot();
    respond = (input) => (input.at.turn === 1 && input.at.phase === 'EOSORIA' ? { results: { [t.a.memberId]: { stamina: 0 } } } : {});
    // Away from the inn: no SAFE_ZONE period-end restore on top of the +6.
    for (const who of [t.a, t.b, t.c]) expect(moveCharacter(server!.orm, who.memberId, 'fountain', CLOCK)).toBe(true);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const x of [a, b, c]) await send(x);
    const locked = await a.waitFor(turnIs(2));
    expect(locked.you.lock?.code).toBe('exhausted');
    await send(b);
    await send(c);
    await a.waitFor(turnIs(1, 'SOLARION'));
    expect(calls[1]!.actions.map((x) => x.memberId)).toEqual([t.b.memberId, t.c.memberId]);
    expect(row(t.a).stamina).toBe(6);
    expect(a.lastRoom()!.you.lock).toBeNull();
  });

  it('C1: a hit of 15 on an exhausted player takes 19 (×1.3, rounded toward zero) through the AI GM turn', async () => {
    let target = '';
    const t = await boot({
      ai: (req) => {
        if (req.output.name !== GM_OUTPUT.turn) return undefined;
        const proposal = mockTurnProposal(contextOf<TurnContext>(req));
        for (const x of proposal.actions) {
          x.check = { type: 'none' };
          x.targetPlayer = {
            player: target,
            intent: 'harm',
            defenseRef: null,
            perceptionRef: null,
            onSuccess: { damage: 'moderate', heal: null, takeItem: null, giveItem: null },
            onFail: { damage: null, heal: null, takeItem: null, giveItem: null },
          };
        }
        return mockReply.ok(proposal);
      },
    });
    target = refOf(t.a);
    patch(t, {}, { a: { condition: 'exhausted', mustSubmit: false, stamina: 0 } });
    const before = row(t.a).hp;
    const [b, c] = [await enter(t.b), await enter(t.c)];
    await send(b);
    await send(c);
    await b.waitFor(turnIs(2));
    // Two hits of moderate 15 on a rested player would be 30; exhausted: 19 + 19.
    expect(before - row(t.a).hp).toBe(38);
  });

  it('C2 + C3: HP 0 = out cold one turn (not waited for), then carried to the clinic: 2 turns, half the coins (25 -> 12, 0 -> 0)', async () => {
    const t = await boot();
    setCoins(t.a, 25);
    setCoins(t.b, 0);
    respond = (input) => (input.at.turn === 1 && input.at.phase === 'EOSORIA' ? { results: { [t.a.memberId]: { hp: 0 }, [t.b.memberId]: { hp: 0 } } } : {});
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const x of [a, b, c]) await send(x);

    const out = await a.waitFor(turnIs(2));
    expect(out.you.lock?.code).toBe('unconscious');
    const refused = a.messages.length;
    a.action('ลุกขึ้น', 'public');
    expect(await a.waitFor((m) => m.type === 'action_rejected', refused)).toMatchObject({ code: 'unconscious' });
    expect(presenceOf(server!.orm, t.a.memberId)!.locationId).toBe('inn');
    await send(c);

    const carried = await a.waitFor(turnIs(1, 'SOLARION'));
    expect(carried.you.lock?.code).toBe('recovering');
    expect(carried.you.place).toMatchObject({ id: 'clinic', name: 'สถานพยาบาลกลาง' });
    expect(presenceOf(server!.orm, t.b.memberId)!.locationId).toBe('clinic');
    expect(row(t.a).coins).toBe(12);
    expect(row(t.b).coins).toBe(0);

    await send(c);
    expect((await a.waitFor(turnIs(2, 'SOLARION'))).you.lock?.code).toBe('recovering');
    await send(c);
    const back = await a.waitFor(turnIs(1, 'HESPERION'));
    expect(back.you.lock).toBeNull();
    expect(row(t.a).hp).toBe(row(t.a).hpMax);
    expect(row(t.a).coins).toBe(12);
  });

  it('C4: executed while out cold = an Astral Spirit for good: locked, no place, never waited for', async () => {
    const t = await boot();
    respond = (input) => (input.at.turn === 1 && input.at.phase === 'EOSORIA' ? { results: { [t.a.memberId]: { hp: 0 } } } : { results: { [t.a.memberId]: { executed: true } } });
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const x of [a, b, c]) await send(x);
    await a.waitFor(turnIs(2));
    await send(b);
    await send(c);

    const ghost = await a.waitFor(turnIs(1, 'SOLARION'));
    expect(ghost.you.lock?.code).toBe('astral_spirit');
    expect(ghost.you.place).toBeNull();
    expect(ghost.you.astral).toMatchObject({ since: { day: 1, phase: 'EOSORIA', turn: 2 }, omen: { canSend: false } });
    expect(presenceOf(server!.orm, t.a.memberId)!.locationId).toBe(ASTRAL_PLANE);
    // Out of the world: nobody meets the spirit any more.
    expect(((await t.call('GET', '/api/game/surroundings', { token: t.b.token })).body as { people: unknown[] }).people).toHaveLength(1);
    const refused = a.messages.length;
    a.action('หลอกหลอน', 'public');
    expect(await a.waitFor((m) => m.type === 'action_rejected', refused)).toMatchObject({ code: 'astral_spirit' });
    a.whisper(refOf(t.b), 'ได้ยินไหม');
    expect(await a.waitFor((m) => m.type === 'whisper_rejected', refused)).toMatchObject({ code: 'astral_spirit' });

    respond = () => ({});
    await send(b);
    await send(c);
    expect((await a.waitFor(turnIs(2, 'SOLARION'))).you.lock?.code).toBe('astral_spirit');
    expect(b.lastRoom()!.you.astral).toBeNull();
  });

  it('C4: the AI GM turn turns a successful EXECUTE into the death', async () => {
    let target = '';
    const t = await boot({
      ai: (req) => {
        if (req.output.name !== GM_OUTPUT.turn) return undefined;
        const proposal = mockTurnProposal(contextOf<TurnContext>(req));
        const none = { damage: null, heal: null, takeItem: null, giveItem: null };
        for (const x of proposal.actions) {
          x.check = { type: 'none' };
          x.targetPlayer = { player: target, intent: 'execute', defenseRef: null, perceptionRef: null, onSuccess: none, onFail: none };
        }
        return mockReply.ok(proposal);
      },
    });
    target = refOf(t.a);
    patch(t, {}, { a: { hp: 0, condition: 'unconscious', mustSubmit: false, knockedOut: { at: { day: 1, phase: 'EOSORIA', turn: 1 } } } });
    server!.orm.update(character).set({ hp: 0 }).where(eq(character.memberId, t.a.memberId)).run();
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await send(b);
    await send(c);
    const ghost = await a.waitFor(turnIs(2));
    expect(ghost.you.lock?.code).toBe('astral_spirit');
  });

  it('C5: an Astral Spirit gets the public feed of every place, but not private narration or Secrets of others', async () => {
    const t = await boot();
    patch(t, {}, { a: dead() });
    bury(t.a);
    expect(moveCharacter(server!.orm, t.c.memberId, 'fountain', CLOCK)).toBe(true);
    respond = () => ({
      entries: [
        { kind: 'feed', locationId: 'inn', actorMemberId: t.b.memberId, text: 'ดารินทุบโต๊ะที่โรงเตี๊ยม' },
        { kind: 'feed', locationId: 'fountain', actorMemberId: t.c.memberId, text: 'เมฆาโยนเหรียญลงน้ำพุ' },
        { kind: 'narration', memberId: t.c.memberId, text: 'คุณแอบหยิบเหรียญคืน (Secret)' },
        { kind: 'narration', memberId: t.b.memberId, text: 'มือคุณเจ็บ' },
      ],
    });
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await send(b);
    await send(c);
    await a.waitFor(turnIs(2));
    await a.waitFor((m) => m.type === 'entry' && m.entry.text === 'เมฆาโยนเหรียญลงน้ำพุ');
    const texts = a.entries().map((e) => e.text);
    expect(texts).toEqual(expect.arrayContaining(['ดารินทุบโต๊ะที่โรงเตี๊ยม', 'เมฆาโยนเหรียญลงน้ำพุ']));
    expect(texts).not.toContain('คุณแอบหยิบเหรียญคืน (Secret)');
    expect(texts).not.toContain('มือคุณเจ็บ');
    // The living still only see their own place.
    expect(b.entries().map((e) => e.text)).not.toContain('เมฆาโยนเหรียญลงน้ำพุ');
  });

  it('C6: one omen (≤ 200) a night in NOCTHERION to one chosen player; a second the same night or outside NOCTHERION is refused', async () => {
    const t = await boot();
    patch(t, { phase: 'SOLARION' }, { a: dead() });
    bury(t.a);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];

    expect(a.lastRoom()!.you.astral!.omen.canSend).toBe(false);
    expect(await omen(a, refOf(t.b), 'ระวังเงา')).toMatchObject({ type: 'omen_rejected', code: 'not_noctherion' });
    expect(await omen(b, refOf(t.c), 'ฉันยังไม่ตาย')).toMatchObject({ type: 'omen_rejected', code: 'not_astral' });

    await a.close();
    patch(t, { phase: 'NOCTHERION' });
    const ghost = await enter(t.a);
    const view = ghost.lastRoom()!.you.astral!;
    expect(view.omen.canSend).toBe(true);
    // Chosen by appearance (Q-193), never by real name; the spirit itself is not a target.
    expect(view.omen.targets).toEqual(
      expect.arrayContaining([
        { ref: refOf(t.b), label: t.b.appearance },
        { ref: refOf(t.c), label: t.c.appearance },
      ]),
    );
    expect(view.omen.targets).toHaveLength(2);

    expect(await omen(ghost, refOf(t.b), 'x'.repeat(OMEN_MAX_LENGTH + 1))).toMatchObject({ type: 'omen_rejected', code: 'too_long' });
    expect(await omen(ghost, refOf(t.b), '   ')).toMatchObject({ type: 'omen_rejected', code: 'empty' });
    expect(await omen(ghost, 'p-nobody', 'ระวังเงา')).toMatchObject({ type: 'omen_rejected', code: 'unknown_target' });

    const sent = 'เงาใต้แท่นบูชากำลังรอคืนจันทราโลหิต';
    expect(await omen(ghost, refOf(t.b), sent)).toEqual({ type: 'omen_accepted' });
    const got = await b.waitFor((m) => m.type === 'entry' && m.entry.kind === 'omen');
    expect(got).toMatchObject({ entry: { kind: 'omen', text: sent, place: null, phase: 'NOCTHERION' } });
    expect(JSON.stringify(got)).not.toContain('ลิน');
    expect(c.entries().some((e) => e.kind === 'omen')).toBe(false);
    expect(await omen(ghost, refOf(t.c), 'อีกครั้ง')).toMatchObject({ type: 'omen_rejected', code: 'already_sent' });
    expect(ghost.lastRoom()!.you.astral!.omen.canSend).toBe(false);
  });

  it('C7: every player dead for good ends the game (game over) with the summary', async () => {
    const t = await boot();
    // Nobody can act, so the engine closed the turn at once (`resolving`); it resolves as soon as someone enters.
    patch(t, { status: 'resolving' }, { a: dead(), b: dead(), c: { hp: 0, condition: 'unconscious', mustSubmit: false, knockedOut: { at: { day: 1, phase: 'EOSORIA', turn: 1 } } } });
    bury(t.a);
    bury(t.b);
    respond = () => ({ results: { [t.c.memberId]: { executed: true } } });
    const c = await enter(t.c);
    await c.waitFor((m) => m.type === 'room' && m.status === 'game_over');
    expect(state(t).status).toBe('game_over');
    const ending = server!.db.prepare('select reason, path from game_ending where game_id = ?').get(gameIdOf(t));
    expect(ending).toMatchObject({ reason: 'game_over', path: 'none' });
    await c.waitFor((m) => m.type === 'entry' && m.entry.kind === 'narration');
    const log = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.a.token })).body);
    expect(log.game).toMatchObject({ status: 'ended', endReason: 'game_over' });
    expect(log.reveal?.players.map((p) => p.outcome)).toEqual(['defeated', 'defeated', 'defeated']);
  });
});
