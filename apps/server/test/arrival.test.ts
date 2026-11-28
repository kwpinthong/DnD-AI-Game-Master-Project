import { OriginResponse, type RoomEntry, type RoomServerMessage } from '@isekai/protocol';
import type { Period, Rng, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { loadWorld, requestTokens, type NarrationContext, type TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import type { SceneContext } from '../src/gm/scene.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { moveCharacter, presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, DARIN, LIN, MEKHA, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * ISK-009: the place around a player when the game starts (the end of the crossing narration) and every time they
 * arrive somewhere (a paragraph of their own turn narration, no new AI call); who was there before reads the arrival
 * in the place feed they already get.
 */

type Handler = (req: AiCallRequest) => AiCallResult | undefined;

const isTurn = (req: AiCallRequest) => req.output.name === 'gm_turn_proposal';
const isNarration = (req: AiCallRequest) => req.output.name === 'gm_narration';
const isScene = (req: AiCallRequest) => req.output.name === 'gm_scene';
const isOrigin = (req: AiCallRequest) => req.output.name === 'origin_narration';

const FOUNTAIN = 'น้ำพุกลางเมือง';
const INN = 'โรงเตี๊ยมและกิลด์นักเดินทาง';

/** The Mock GM, no roll; an action "เดินไปน้ำพุ" moves its actor to the fountain; the weather is Clear. */
const gm: Handler = (req) => {
  if (req.purpose === 'gm_weather') return mockReply.ok({ weather: 'Clear' });
  if (!isTurn(req)) return undefined;
  const ctx = contextOf<TurnContext>(req);
  const proposal = mockTurnProposal(ctx);
  for (const a of proposal.actions) {
    a.check = { type: 'none' };
    if (ctx.actions.find((x) => x.actionId === a.actionId)?.text.includes('เดินไปน้ำพุ')) a.moveTo = 'fountain';
  }
  return mockReply.ok(proposal);
};

function gmProvider(handler: Handler) {
  const requests: AiCallRequest[] = [];
  const provider: AiProvider & { requests: AiCallRequest[] } = {
    id: 'mock',
    requests,
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      requests.push(req);
      const scripted = handler(req);
      if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
      return mockReply.ok(await cannedGmAnswer(req));
    },
  };
  return provider;
}

describe('ISK-009 arrival', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let provider: ReturnType<typeof gmProvider>;
  const sockets: RoomClient[] = [];
  const logs: string[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function boot(handler: Handler = gm, rng?: Rng): Promise<void> {
    provider = gmProvider(handler);
    logs.length = 0;
    server = await startTestServer(dataDir, {
      aiProvider: provider,
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }),
      aiLog: (line) => logs.push(line),
      ...(rng ? { rng } : {}),
    });
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const refOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.ref;
  const put = (who: Seat, locationId: string) => expect(moveCharacter(server!.orm, who.memberId, locationId, CLOCK)).toBe(true);
  const placeOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.locationId;
  const titleOf = (t: Table, who: Seat) => loadWorld(server!.orm, gameIdOf(t), server!.assets).players.get(who.memberId)!.socialTitle;
  function jumpTo(t: Table, to: { day: number; phase: Period; turn: Turn }) {
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), ...to }, CLOCK);
  }
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(done: () => boolean, ms = 3_000) {
    for (const end = Date.now() + ms; !done() && Date.now() < end; ) await pause(10);
  }
  const collecting = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';
  const turnEntries = (c: RoomClient, day: number, phase: Period, turn: Turn) => c.entries().filter((e: RoomEntry) => e.day === day && e.phase === phase && e.turn === turn);

  async function act(client: RoomClient, text: string) {
    const from = client.messages.length;
    client.action(text, 'public');
    const reply = await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
    expect(reply, JSON.stringify(reply)).toEqual({ type: 'action_accepted' });
  }
  /** A move through the room (GEN-066): `ok` false = it must be refused. */
  async function travel(client: RoomClient, to: string, ok = true) {
    const from = client.messages.length;
    client.send({ type: 'move', to });
    const reply = await client.waitFor((m) => m.type === 'move_accepted' || m.type === 'move_rejected', from);
    expect(reply.type, JSON.stringify(reply)).toBe(ok ? 'move_accepted' : 'move_rejected');
  }
  /** Every text in `acts` is sent (null = that player already acted, e.g. a trip); resolves once `next` is open and the dialogue stage is done. */
  async function playTurn(clients: RoomClient[], acts: (string | null)[], next: { day: number; phase: Period; turn: Turn }) {
    const dialogues = () => logs.filter((l) => l.includes('dialogue timing')).length;
    const before = dialogues();
    for (const [i, c] of clients.entries()) if (acts[i] !== null) await act(c, acts[i]!);
    for (const c of clients) await c.waitFor(collecting(next.day, next.phase, next.turn));
    await until(() => dialogues() > before);
    await pause(30);
  }

  /** The narration context of `who`'s own narration of that turn (the last one asked). */
  const ownContext = (who: Seat, at: { day: number; phase: Period; turn: Turn }) =>
    provider.requests
      .filter(isNarration)
      .map((r) => contextOf<NarrationContext>(r))
      .filter((c) => 'player' in c.audience && c.audience.player === refOf(who) && c.turn.day === at.day && c.turn.phase === at.phase && c.turn.turn === at.turn)
      .at(-1)!;
  const placeContext = (placeId: string, at: { day: number; phase: Period; turn: Turn }) =>
    provider.requests
      .filter(isNarration)
      .map((r) => contextOf<NarrationContext>(r))
      .find((c) => 'place' in c.audience && c.audience.place === placeId && c.turn.day === at.day && c.turn.phase === at.phase && c.turn.turn === at.turn);
  const ownNarration = (c: RoomClient, at: { day: number; phase: Period; turn: Turn }) =>
    turnEntries(c, at.day, at.phase, at.turn).filter((e) => e.kind === 'narration').map((e) => e.text).join('\n');
  const usageOf = (t: Table, at: { day: number; phase: Period; turn: Turn }) =>
    (server!.db.prepare('select purpose from ai_usage where game_id = ? and day = ? and phase = ? and turn = ? order by purpose').all(gameIdOf(t), at.day, at.phase, at.turn) as { purpose: string }[]).map((r) => r.purpose);

  /** A at the theatre, B at the fountain, C at the inn, on SOLARION turn 1 of day 1. */
  async function table(): Promise<{ t: Table; clients: RoomClient[] }> {
    const t = await startedTable(server!, false);
    put(t.a, 'theater');
    put(t.b, 'fountain');
    jumpTo(t, { day: 1, phase: 'SOLARION', turn: 1 });
    return { t, clients: [await enter(t.a), await enter(t.b), await enter(t.c)] };
  }
  const S1 = { day: 1, phase: 'SOLARION' as const, turn: 1 as const };
  const S2 = { day: 1, phase: 'SOLARION' as const, turn: 2 as const };
  const H1 = { day: 1, phase: 'HESPERION' as const, turn: 1 as const };
  const H2 = { day: 1, phase: 'HESPERION' as const, turn: 2 as const };

  it('C2 + C7: A travels from the theatre to the fountain: A\'s own narration gets the arrival (place, period, weather, NPCs by alias, players there)', async () => {
    await boot();
    const { t, clients } = await table();
    await travel(clients[0]!, FOUNTAIN);
    await playTurn(clients, [null, 'นั่งริมน้ำพุ', 'ล้างแก้ว'], S2);
    expect(placeOf(t.a)).toBe('fountain');

    const ctx = ownContext(t.a, S1);
    expect(ctx.arrival).toMatchObject({ place: { id: 'fountain', name: FOUNTAIN }, phase: 'SOLARION', weather: 'Clear', players: [refOf(t.b)] });
    expect(ctx.arrival!.place.description).toContain('จัตุรัส');
    // SOLARION: Noah and Lucia are at the fountain (NPC_Schedule), by alias.
    expect(ctx.arrival!.npcs).toEqual(expect.arrayContaining([
      { id: 'beggar', alias: 'เด็กขอทานตาบอดข้างหนึ่ง' },
      { id: 'amnesiac', alias: 'หญิงสาวผู้พกนาฬิกาพกตาย' },
    ]));
    // C7: never a real name of an NPC A has not met.
    expect(JSON.stringify(ctx)).not.toMatch(/โนอา|ลูเซีย/);
    // The last beat is the arrival paragraph; A reads it in their own narration.
    expect(ctx.beats.at(-1)).toMatchObject({ kind: 'arrival', actor: refOf(t.a) });
    expect(ownNarration(clients[0]!, S1)).toContain(`มาถึง${FOUNTAIN}`);
  });

  it('C3: B was at the fountain and does not know A: B reads in the fountain feed that someone (A\'s title) arrived, never A\'s own narration', async () => {
    await boot();
    const { t, clients } = await table();
    await travel(clients[0]!, FOUNTAIN);
    await playTurn(clients, [null, 'นั่งริมน้ำพุ', 'ล้างแก้ว'], S2);

    const feed = placeContext('fountain', S1)!;
    expect(feed.beats.some((b) => b.kind === 'arrival' && b.actor === refOf(t.a))).toBe(true);
    expect(feed.arrival).toBeUndefined();
    const bFeed = turnEntries(clients[1]!, 1, 'SOLARION', 1).filter((e) => e.kind === 'feed').map((e) => e.text).join('\n');
    expect(bFeed).toContain(`${titleOf(t, t.a)} มาถึง${FOUNTAIN}`);
    expect(bFeed).not.toContain(LIN.name);
    // A's own narration reaches A only.
    const aOwn = ownNarration(clients[0]!, S1);
    for (const e of turnEntries(clients[1]!, 1, 'SOLARION', 1)) expect(e.text).not.toBe(aOwn);
    expect(ownNarration(clients[1]!, S1)).not.toContain('มาถึง');
  });

  it('C4: a move that fails gives no arrival', async () => {
    await boot();
    const { t, clients } = await table();
    await travel(clients[0]!, 'ดวงจันทร์', false);
    await playTurn(clients, ['ยืนดูเวที', 'นั่งริมน้ำพุ', 'ล้างแก้ว'], S2);
    expect(placeOf(t.a)).toBe('theater');
    const ctx = ownContext(t.a, S1);
    expect(ctx.arrival).toBeUndefined();
    expect(ctx.beats.some((b) => b.kind === 'arrival')).toBe(false);
    expect(placeContext('fountain', S1)!.beats.some((b) => b.kind === 'arrival')).toBe(false);
  });

  it('C5: every arrival, the same place again too (same-zone moves through the room)', async () => {
    await boot();
    const t = await startedTable(server!, false);
    jumpTo(t, S1);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    // A: inn → fountain (S1), fountain → inn (S2), inn → fountain again (H1).
    await travel(clients[0]!, FOUNTAIN);
    await playTurn(clients, ['ยืนมองน้ำพุ', 'ดื่มชา', 'ล้างแก้ว'], S2);
    expect(ownContext(t.a, S1).arrival?.place.id).toBe('fountain');
    await travel(clients[0]!, INN);
    await playTurn(clients, ['นั่งพัก', 'ดื่มชา', 'ล้างแก้ว'], H1);
    expect(ownContext(t.a, S2).arrival?.place.id).toBe('inn');
    await travel(clients[0]!, FOUNTAIN);
    await playTurn(clients, ['ยืนมองน้ำพุ', 'ดื่มชา', 'ล้างแก้ว'], H2);
    expect(ownContext(t.a, H1).arrival?.place.id).toBe('fountain');
    expect(ownNarration(clients[0]!, H1)).toContain(`มาถึง${FOUNTAIN}`);
    // Who did not move gets none.
    expect(ownContext(t.b, H1).arrival).toBeUndefined();
  });

  it('C6: A arrives on the period\'s last turn: A reads the arrival, not the fountain\'s period scene; B (there before) reads the scene', async () => {
    await boot();
    const t = await startedTable(server!, false);
    put(t.b, 'fountain');
    jumpTo(t, S2);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['เดินไปน้ำพุ', 'นั่งริมน้ำพุ', 'ล้างแก้ว'], H1);
    const scenesOf = (c: RoomClient) => turnEntries(c, 1, 'HESPERION', 1).filter((e) => e.kind === 'feed');
    await until(() => scenesOf(clients[1]!).length > 0 && scenesOf(clients[2]!).length > 0);
    await pause(100);

    expect(ownContext(t.a, S2).arrival?.place.id).toBe('fountain');
    expect(ownNarration(clients[0]!, S2)).toContain(`มาถึง${FOUNTAIN}`);
    expect(scenesOf(clients[1]!).map((e) => e.place?.id)).toEqual(['fountain']);
    expect(scenesOf(clients[0]!)).toEqual([]);
    expect(provider.requests.filter(isScene).map((r) => contextOf<SceneContext>(r).place.id).sort()).toEqual(['fountain', 'inn']);
    // The game goes on.
    await playTurn(clients, ['ยืนมองน้ำพุ', 'นั่งริมน้ำพุ', 'ล้างแก้ว'], H2);
  });

  it('C8: a turn with a move asks the AI as often as one without; the arrival adds at most 300 input tokens', async () => {
    await boot();
    const { t, clients } = await table();
    await playTurn(clients, ['ยืนดูเวที', 'นั่งริมน้ำพุ', 'ล้างแก้ว'], S2);
    await playTurn(clients, ['เดินไปน้ำพุ', 'นั่งริมน้ำพุ', 'ล้างแก้ว'], H1);
    expect(placeOf(t.a)).toBe('fountain');
    expect(usageOf(t, S1).length).toBeGreaterThan(0);
    expect(usageOf(t, S2)).toEqual(usageOf(t, S1));

    const req = provider.requests.filter(isNarration).find((r) => {
      const c = contextOf<NarrationContext>(r);
      return 'player' in c.audience && c.audience.player === refOf(t.a) && c.turn.turn === 2;
    })!;
    const ctx = contextOf<NarrationContext>(req);
    expect(ctx.arrival).toBeDefined();
    const { arrival: _arrival, ...without } = ctx;
    const plain = { ...without, beats: ctx.beats.filter((b) => b.kind !== 'arrival') };
    const added = requestTokens(req.system, [{ text: JSON.stringify(ctx) }]) - requestTokens(req.system, [{ text: JSON.stringify(plain) }]);
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThanOrEqual(300);
  });

  it('C9: A and B arrive at the fountain on the same turn: each has the other among the players there', async () => {
    await boot();
    const t = await startedTable(server!, false);
    put(t.b, 'temple');
    put(t.c, 'fountain');
    jumpTo(t, S1);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['เดินไปน้ำพุ', 'เดินไปน้ำพุ', 'ล้างมือที่น้ำพุ'], S2);
    expect(ownContext(t.a, S1).arrival?.players.sort()).toEqual([refOf(t.b), refOf(t.c)].sort());
    expect(ownContext(t.b, S1).arrival?.players.sort()).toEqual([refOf(t.a), refOf(t.c)].sort());
    expect(placeContext('fountain', S1)!.beats.filter((b) => b.kind === 'arrival').map((b) => b.actor).sort()).toEqual([refOf(t.a), refOf(t.b)].sort());
  });

  describe('the start of the game', () => {
    const MUSICIAN = 1; // นักดนตรีพเนจรตกอับ @ fountain
    const DISHWASHER = 701; // ลูกมือล้างจานประจำร้าน @ inn
    const scripted = (values: number[]): Rng => ({ nextInt: () => values.shift()! });
    /** The crossing names who it was given around the reader, as tokens. */
    const origin: Handler = (req) => {
      if (!isOrigin(req)) return gm(req);
      const around = /Around you now: (.*)/.exec(req.messages[0]!.text)?.[1];
      const parsed = around ? (JSON.parse(around) as { npcs: { id: string }[]; players: string[] }) : { npcs: [], players: [] };
      const who = [...parsed.npcs.map((n) => `{{n:${n.id}}}`), ...parsed.players.map((r) => `{{p:${r}}}`)].join(' ');
      return mockReply.ok({ narration: `แสงสว่างจางลง คุณลืมตาขึ้น รอบตัวมี ${who || 'ความเงียบ'}` });
    };
    const originOf = async (t: Table, seat: Seat) => {
      const body = OriginResponse.parse((await t.call('GET', '/api/game/origin', { token: seat.token })).body);
      if (body.view !== 'player' || body.origin === null) throw new Error('no origin');
      return body.origin;
    };
    const promptFor = (seat: Seat) => provider.requests.filter(isOrigin).find((r) => r.messages[0]!.text.includes(`{{p:${seat.memberId}}}`))!.messages[0]!.text;

    it('C1: A spawns at the fountain on EOSORIA in Clear weather with Malcolm there: A\'s crossing is told with all of it, in the same one call', async () => {
      await boot(origin, scripted([MUSICIAN, DISHWASHER, DISHWASHER]));
      const t = await startedTable(server!, false);
      const prompt = promptFor(t.a);
      expect(prompt).toContain('"id":"fountain"');
      expect(prompt).toContain('EOSORIA');
      expect(prompt).toContain('Clear');
      expect(prompt).toContain('นักบวชผู้ใจบุญประจำเมือง');
      expect(prompt).not.toContain('มัลคอล์ม');
      // One crossing call per player, plus the period's weather the room would pick anyway.
      expect(provider.requests.filter((r) => r.purpose === 'narrate_player')).toHaveLength(3);
      expect(provider.requests.map((r) => r.purpose).filter((p) => p !== 'narrate_player')).toEqual(['gm_weather']);
      // A reads Malcolm by alias (not met yet).
      expect((await originOf(t, t.a)).narration).toContain('นักบวชผู้ใจบุญประจำเมือง');
      // Opening the room picks no weather again.
      await enter(t.a);
      expect(provider.requests.filter((r) => r.purpose === 'gm_weather')).toHaveLength(1);
    });

    it('C9: A and B spawn apart: B gets nothing of A\'s crossing; B and C spawn together and each is around the other (by title)', async () => {
      await boot(origin, scripted([MUSICIAN, DISHWASHER, DISHWASHER]));
      const t = await startedTable(server!, false);
      expect(promptFor(t.a)).not.toContain(refOf(t.b));
      expect(promptFor(t.a)).not.toContain(refOf(t.c));
      expect(promptFor(t.b)).toContain(refOf(t.c));
      expect(promptFor(t.b)).not.toContain(refOf(t.a));
      expect(promptFor(t.c)).toContain(refOf(t.b));
      const [a, b] = [await originOf(t, t.a), await originOf(t, t.b)];
      expect(b.narration).not.toBe(a.narration);
      expect(b.narration).toContain(titleOf(t, t.c));
      expect(b.narration).not.toContain(MEKHA.name);
      expect(b.narration).not.toContain(LIN.name);
      expect(a.narration).not.toContain(DARIN.name);
    });
  });
});
