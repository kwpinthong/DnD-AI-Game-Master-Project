import { GameLogResponse, type RoomServerMessage, type RoomState } from '@isekai/protocol';
import { karmaTitle, type Period, type Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import type { TurnContext } from '../src/gm/context.ts';
import type { FinaleContext } from '../src/gm/finale.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { GM_OUTPUT, type GmFinale } from '../src/gm/schema.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { advanceTimeline } from '../src/timeline/store.ts';
import { moveCharacter, presenceOf } from '../src/visibility/store.ts';
import { approveHeldTurn, heldTurn } from './gm-console-client.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, DARIN, LIN, MEKHA, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-059: the finale of day 12 (World_Timeline: HESPERION → NOCTHERION), its ending per path, the AI
 * telling it to the table and to each player over the play room, and the secret reveal on the summary.
 */

type Handler = (req: AiCallRequest, n: number) => AiCallResult | Promise<AiCallResult | undefined> | undefined;

function gmProvider(handler: Handler = () => undefined) {
  const requests: AiCallRequest[] = [];
  let current = handler;
  const provider: AiProvider & { requests: AiCallRequest[]; use(h: Handler): void } = {
    id: 'mock',
    requests,
    use(h) {
      current = h;
    },
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      requests.push(req);
      const scripted = await current(req, requests.length);
      if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
      return mockReply.ok(await cannedGmAnswer(req));
    },
  };
  return provider;
}

const isTurn = (req: AiCallRequest) => req.output.name === GM_OUTPUT.turn;
const isFinale = (req: AiCallRequest) => req.output.name === GM_OUTPUT.finale;

/** No dice; with `endingPath`, the AI GM says the players completed that path this turn. */
const turnWith =
  (endingPath: 'good' | 'evil' | 'neutral' | null = null): Handler =>
  (req) => {
    if (!isTurn(req)) return undefined;
    const proposal = mockTurnProposal(contextOf<TurnContext>(req));
    for (const a of proposal.actions) a.check = { type: 'none' };
    return mockReply.ok({ ...proposal, endingPath });
  };

/** The finale told with marked text, so each reader's own ending can be told apart. */
const markedFinale = (req: AiCallRequest): AiCallResult => {
  const ctx = contextOf<FinaleContext>(req);
  const out: GmFinale = { overall: 'ฉากจบรวมของทุกคน', players: ctx.players.map((p) => ({ player: p.ref, text: `ฉากจบส่วนตัว ${p.outcome}` })) };
  return mockReply.ok(out);
};

const ended = (m: RoomServerMessage): m is RoomState => m.type === 'room' && (m.status === 'finale' || m.status === 'game_over');

describe('GEN-059 finale', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let provider: ReturnType<typeof gmProvider>;
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

  async function boot(handler?: Handler): Promise<void> {
    provider = gmProvider(handler);
    server = await startTestServer(dataDir, { aiProvider: provider, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }) });
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function send(client: RoomClient, text: string, visibility: 'public' | 'secret' = 'public') {
    const from = client.messages.length;
    client.action(text, visibility);
    const reply = await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
    expect(reply, JSON.stringify(reply)).toEqual({ type: 'action_accepted' });
  }

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const refOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.ref;
  const move = (who: Seat, locationId: string) => expect(moveCharacter(server!.orm, who.memberId, locationId, CLOCK)).toBe(true);
  const ending = (t: Table) => server!.db.prepare('select reason, path, outcomes, narrated_at from game_ending where game_id = ?').get(gameIdOf(t)) as
    | { reason: string; path: string; outcomes: string; narrated_at: number | null }
    | undefined;
  const statusOf = (t: Table) => ensurePhaseState(server!.orm, gameIdOf(t), CLOCK).status;

  /** The game at `to` with the timeline there too (the finale event is active from day 12 HESPERION). */
  function jumpTo(t: Table, to: { day: number; phase: Period; turn: Turn }) {
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), ...to }, CLOCK);
    expect(advanceTimeline(server!.orm, gameId, { day: to.day, phase: to.phase }, CLOCK)).toMatchObject({ ok: true });
  }

  /** Day 12 NOCTHERION turn 2: everyone acts, the game ends; resolves once every client saw the end. */
  async function playLastTurn(t: Table, texts = ['มองฟ้า', 'สวดมนต์', 'เขียนจดหมาย'], visibility: ('public' | 'secret')[] = []) {
    jumpTo(t, { day: 12, phase: 'NOCTHERION', turn: 2 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, texts[i]!, visibility[i] ?? 'public');
    for (const c of clients) await c.waitFor(ended);
    return clients;
  }

  /** Waits until `client` got the private ending (the marked finale's own text). */
  const privateEnding = (client: RoomClient) =>
    client.waitFor((m) => m.type === 'entry' && m.entry.kind === 'narration' && m.entry.text.startsWith('ฉากจบส่วนตัว'));

  const finaleRequests = () => provider.requests.filter(isFinale);

  it('C1: closing day 12 NOCTHERION turn 2 ends the game and everyone gets the ending (table + own) over the room', async () => {
    await boot((req, n) => (isFinale(req) ? markedFinale(req) : turnWith()(req, n)));
    const t = await startedTable(server!, false);
    const clients = await playLastTurn(t);
    expect(statusOf(t)).toBe('finale');
    for (const c of clients) {
      const own = await privateEnding(c);
      expect(own.type === 'entry' && own.entry).toMatchObject({ kind: 'narration', day: 12, phase: 'NOCTHERION', turn: 2 });
      await c.waitFor((m) => m.type === 'entry' && m.entry.kind === 'feed' && m.entry.text === 'ฉากจบรวมของทุกคน');
      // Each player got their own ending only.
      expect(c.entries().filter((e) => e.text.startsWith('ฉากจบส่วนตัว'))).toHaveLength(1);
    }
    expect(finaleRequests()).toHaveLength(1);
    await expect.poll(() => ending(t)?.narrated_at ?? null).not.toBeNull();
    expect(ending(t)).toMatchObject({ reason: 'finale' });
  });

  it('C2: a player completed the Good path on day 12: the town is protected and everyone still alive survives', async () => {
    await boot((req, n) => (isFinale(req) ? markedFinale(req) : turnWith('good')(req, n)));
    const t = await startedTable(server!, false);
    // Nobody is protected or in a SAFE_ZONE: only the path saves them.
    for (const who of [t.a, t.b, t.c]) move(who, 'fountain');
    const clients = await playLastTurn(t, ['สร้างม่านปาฏิหาริย์', 'สวดภาวนา', 'ช่วยกันกางม่าน']);
    for (const c of clients) await privateEnding(c);
    expect(ending(t)).toMatchObject({ path: 'good' });
    expect(JSON.parse(ending(t)!.outcomes)).toEqual({ [t.a.memberId]: 'survived', [t.b.memberId]: 'survived', [t.c.memberId]: 'survived' });
    expect(contextOf<FinaleContext>(finaleRequests()[0]!).path).toBe('good');
  });

  it('Q-204: the Evil path took the meteor power: Good-side players (karma tier +14 and up) lose, the others survive', async () => {
    await boot((req, n) => (isFinale(req) ? markedFinale(req) : turnWith('evil')(req, n)));
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    // A just on the Good side (+14), B on the edge of neutral (+13), C Evil (-30); everyone at the inn (SAFE_ZONE).
    const karma = new Map([[t.a.memberId, 14], [t.b.memberId, 13], [t.c.memberId, -30]]);
    for (const [id, k] of karma) server!.db.prepare('update character set karma = ? where member_id = ?').run(k, id);
    const state = ensurePhaseState(server!.orm, gameId, CLOCK);
    savePhaseState(server!.orm, gameId, { ...state, players: Object.fromEntries(Object.entries(state.players).map(([id, p]) => [id, { ...p, karma: karma.get(id)! }])) }, CLOCK);
    const clients = await playLastTurn(t, ['ดูดซับพลังอุกกาบาต', 'ยืนดู', 'ช่วยพิธี']);
    for (const c of clients) await privateEnding(c);
    expect(ending(t)).toMatchObject({ path: 'evil' });
    expect(JSON.parse(ending(t)!.outcomes)).toEqual({ [t.a.memberId]: 'defeated', [t.b.memberId]: 'survived', [t.c.memberId]: 'survived' });
  });

  it('C2: the ending path is refused while the finale event is not active (any day before 12 HESPERION)', async () => {
    await boot(turnWith('good'));
    const t = await startedTable(server!, false);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['เดิน', 'นั่ง', 'ยืน'][i]!);
    // The proposal is refused, then refused again on repair: the turn is stuck.
    await clients[0]!.waitFor((m) => m.type === 'room' && m.gmStatus !== null);
    const repair = provider.requests.find((r) => r.purpose === 'gm_repair')!;
    expect(repair.messages.at(-1)!.text).toContain('ending_path_not_allowed');
  });

  it('C3: no path succeeded: the meteor hits; S / SS protection or a SAFE_ZONE survives, the others are defeated', async () => {
    await boot((req, n) => (isFinale(req) ? markedFinale(req) : turnWith(null)(req, n)));
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    // A: an S protection skill (Sanctuary Aegis, DEFEND) at the fountain. B: at the inn (SAFE_ZONE). C: neither.
    server!.db.prepare("insert into owned_skill (member_id, game_id, name, source, day, created_at) values (?, ?, 'Sanctuary Aegis', 'condition', 11, 0)").run(t.a.memberId, gameId);
    move(t.a, 'fountain');
    move(t.b, 'inn');
    move(t.c, 'fountain');
    const clients = await playLastTurn(t);
    for (const c of clients) await privateEnding(c);
    expect(ending(t)).toMatchObject({ reason: 'finale', path: 'none' });
    expect(JSON.parse(ending(t)!.outcomes)).toEqual({ [t.a.memberId]: 'survived', [t.b.memberId]: 'survived', [t.c.memberId]: 'defeated' });
    const ctx = contextOf<FinaleContext>(finaleRequests()[0]!);
    const byRef = new Map(ctx.players.map((p) => [p.ref, p]));
    expect(byRef.get(refOf(t.a))).toMatchObject({ outcome: 'survived', protectedBy: ['Sanctuary Aegis'], inSafeZone: false });
    expect(byRef.get(refOf(t.b))).toMatchObject({ outcome: 'survived', protectedBy: [], inSafeZone: true });
    expect(byRef.get(refOf(t.c))).toMatchObject({ outcome: 'defeated', protectedBy: [], inSafeZone: false });
    // Each player's ending tells their own outcome.
    expect(await privateEnding(clients[2]!)).toMatchObject({ entry: { text: 'ฉากจบส่วนตัว defeated' } });
    expect(await privateEnding(clients[0]!)).toMatchObject({ entry: { text: 'ฉากจบส่วนตัว survived' } });
  });

  it('C4: the finale context has every event outcome, companions, karma tier and the path (Mock assert), no real names', async () => {
    await boot((req, n) => (isFinale(req) ? markedFinale(req) : turnWith('neutral')(req, n)));
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    // A saves the merchant as a companion at the market; A's karma is dark.
    move(t.a, 'market');
    const seen = await t.call('GET', '/api/game/surroundings', { token: t.a.token });
    const merchantRef = (seen.body as { npcs: { ref: string; name: string }[] }).npcs.find((n) => n.name === 'พ่อค้าเร่ผู้สวมแว่นหนา')!.ref;
    server!.db.prepare('insert into npc_bond (member_id, npc_id, name_revealed, updated_at) values (?, ?, 1, ?)').run(t.a.memberId, 'merchant', CLOCK);
    const saved = await t.call('POST', '/api/game/companions', { token: t.a.token, body: { ref: merchantRef } });
    expect(saved.status, JSON.stringify(saved.body)).toBeLessThan(300);
    server!.db.prepare('update character set karma = -45 where member_id = ?').run(t.a.memberId);
    const state = ensurePhaseState(server!.orm, gameId, CLOCK);
    savePhaseState(server!.orm, gameId, { ...state, players: { ...state.players, [t.a.memberId]: { ...state.players[t.a.memberId]!, karma: -45 } } }, CLOCK);

    const clients = await playLastTurn(t);
    for (const c of clients) await privateEnding(c);
    const ctx = contextOf<FinaleContext>(finaleRequests()[0]!);
    expect(ctx.path).toBe('neutral');
    expect(ctx.events.map((e) => e.id)).toEqual(['d1-bread', 'd5-disaster', 'd7-kidnapping', 'd10-summoning', 'd12-meteor']);
    for (const e of ctx.events) expect(e.outcome.length).toBeGreaterThan(0);
    const a = ctx.players.find((p) => p.ref === refOf(t.a))!;
    expect(a.companions).toEqual(['{{n:merchant}}']);
    expect(a.karmaTier).toBe(karmaTitle(-45, server!.assets.karmaTiers));
    expect(a.karmaBand).toBeLessThan(0);
    expect(ctx.players.map((p) => p.ref).sort()).toEqual([t.a, t.b, t.c].map(refOf).sort());
    // Q-045: no real name, no karma number in the prompt.
    const prompt = JSON.stringify(finaleRequests().map((r) => [r.system, r.messages]));
    for (const name of [LIN.name, DARIN.name, MEKHA.name]) expect(prompt).not.toContain(name);
    expect(prompt).not.toContain('"karma"');
    expect(prompt).not.toContain('-45');
  });

  it('C5: after the end the summary reveals real names, karma, Secret actions and spawn points of everyone; an action is refused', async () => {
    await boot((req, n) => (isFinale(req) ? markedFinale(req) : turnWith()(req, n)));
    const t = await startedTable(server!, false);
    // Before the end: no reveal.
    const before = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.b.token })).body);
    expect(before.reveal).toBeNull();
    server!.db.prepare('update character set karma = 37 where member_id = ?').run(t.c.memberId);

    const clients = await playLastTurn(t, ['แอบขโมยแผนที่ดาว', 'สวดมนต์', 'เขียนจดหมาย'], ['secret', 'public', 'public']);
    for (const c of clients) await privateEnding(c);

    const log = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.b.token })).body);
    expect(log.game.status).toBe('ended');
    expect(log.reveal).not.toBeNull();
    const reveal = log.reveal!;
    expect(reveal.path).toBe('none');
    expect(reveal.players.map((p) => p.characterName)).toEqual([LIN.name, DARIN.name, MEKHA.name]);
    expect(reveal.players.map((p) => p.lobbyName)).toEqual(['นก', 'บี', 'ซี']);
    const [a, , c] = reveal.players;
    // GEN-078: with the ref a 👍 names (A's action is the first one this game stored).
    expect(a!.secretActions).toEqual([{ day: 12, phase: 'NOCTHERION', turn: 2, text: 'แอบขโมยแผนที่ดาว', sourceRef: '12-NOCTHERION-2-1' }]);
    expect(reveal.players[1]!.secretActions).toEqual([]);
    expect(c!.karma).toBe(37);
    // Q-196: the 11-tier word is the main label.
    expect(c!.karmaTier).toBe(karmaTitle(37, server!.assets.karmaTiers));
    // Q-229 C6: how each looked, the last Social Title, and the ending the GM told them (everyone's, only after the end).
    expect(reveal.players.map((p) => p.appearance)).toEqual([LIN.appearance, DARIN.appearance, MEKHA.appearance]);
    for (const p of reveal.players) {
      expect(p.finalTitle).toBeTypeOf('string');
      expect(p.epilogue).toBe('ฉากจบส่วนตัว survived');
    }
    for (const p of reveal.players) {
      expect(p.spawn).toBe('โรงเตี๊ยมและกิลด์นักเดินทาง');
      expect(p.outcome).toBe('survived'); // everyone started (and stayed) at the inn: a SAFE_ZONE
    }

    // Read-only: an action after the end is refused.
    const from = clients[0]!.messages.length;
    clients[0]!.action('ลองทำอะไรอีก', 'public');
    const reply = await clients[0]!.waitFor((m) => m.type === 'action_rejected' || m.type === 'action_accepted', from);
    expect(reply).toMatchObject({ type: 'action_rejected', code: 'game_ended' });
  });

  it('C6: everyone out cold before day 12 is no longer a game over (GEN-070: they are carried to the clinic)', async () => {
    // Every action knocks its actor out (HP 1, lethal self damage).
    await boot((req) => {
      if (isFinale(req)) return markedFinale(req);
      if (!isTurn(req)) return undefined;
      const proposal = mockTurnProposal(contextOf<TurnContext>(req));
      for (const a of proposal.actions) {
        a.check = { type: 'none' };
        a.onSuccess = { ...a.onSuccess, selfDamage: 'lethal' };
      }
      return mockReply.ok(proposal);
    });
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    server!.db.prepare('update character set hp = 1').run();
    for (const who of [t.a, t.b, t.c]) move(who, 'fountain');
    jumpTo(t, { day: 12, phase: 'SOLARION', turn: 1 });
    const state = ensurePhaseState(server!.orm, gameId, CLOCK);
    savePhaseState(server!.orm, gameId, { ...state, players: Object.fromEntries(Object.entries(state.players).map(([id, p]) => [id, { ...p, hp: 1 }])) }, CLOCK);

    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ปีนหอคอย', 'กระโดดน้ำ', 'วิ่งฝ่าไฟ'][i]!);
    // Out cold SOLARION turn 2, at the clinic through HESPERION: everyone acts again in NOCTHERION.
    for (const c of clients) await c.waitFor((m) => m.type === 'room' && m.phase === 'NOCTHERION' && m.turn === 1 && m.status === 'collecting');
    expect(statusOf(t)).toBe('collecting');
    expect(ending(t)).toBeUndefined();
    // Every player dead for good is the game over now: crisis.test.ts C7.
  });

  it('Q-205: with a Human GM the ending waits for the GM (Q-030): held, the GM edits a narration, approves, then everyone gets it', async () => {
    await boot((req, n) => (isFinale(req) ? markedFinale(req) : turnWith()(req, n)));
    const t = await startedTable(server!, true);
    jumpTo(t, { day: 12, phase: 'NOCTHERION', turn: 2 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['มองฟ้า', 'สวดมนต์', 'เขียนจดหมาย'][i]!);
    // The last turn itself is held first (GEN-058), then the game ends.
    await approveHeldTurn(t.call, t.gm!.token);
    for (const c of clients) await c.waitFor(ended);

    // The ending is held: the console shows it, players get nothing yet and see that the GM is checking.
    const pending = await heldTurn(t.call, t.gm!.token);
    expect(pending.finale).toBe(true);
    expect(pending.entries.map((e) => e.kind)).toEqual(['feed', 'narration', 'narration', 'narration']);
    await clients[0]!.waitFor((m) => m.type === 'room' && m.status === 'finale' && m.gmStatus?.code === 'awaiting_gm');
    expect(ending(t)).toMatchObject({ narrated_at: null });
    for (const c of clients) expect(c.entries().filter((e) => e.text.startsWith('ฉากจบ'))).toEqual([]);

    const mine = pending.entries.find((e) => e.memberId === t.a.memberId)!;
    const edit = await t.call('POST', '/api/game/gm/turn/edit', { token: t.gm!.token, body: { reason: 'ปรับตอนจบ', narrations: [{ index: mine.index, text: 'ฉากจบส่วนตัว ที่ GM แก้' }] } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    // A result edit makes no sense after the end: refused.
    const results = await t.call('POST', '/api/game/gm/turn/edit', { token: t.gm!.token, body: { reason: 'x', results: [{ memberId: t.a.memberId, hp: 50 }] } });
    expect(results.status).toBe(400);

    expect((await t.call('POST', '/api/game/gm/turn/approve', { token: t.gm!.token })).status).toBe(200);
    expect(await privateEnding(clients[0]!)).toMatchObject({ entry: { text: 'ฉากจบส่วนตัว ที่ GM แก้' } });
    for (const c of clients.slice(1)) await privateEnding(c);
    await clients[1]!.waitFor((m) => m.type === 'entry' && m.entry.kind === 'feed' && m.entry.text === 'ฉากจบรวมของทุกคน');
    await expect.poll(() => ending(t)?.narrated_at ?? null).not.toBeNull();
    expect(statusOf(t)).toBe('finale');
  });

  it('Q-205: without a Human GM the ending is published at once (nothing waits for approval)', async () => {
    await boot((req, n) => (isFinale(req) ? markedFinale(req) : turnWith()(req, n)));
    const t = await startedTable(server!, false);
    const clients = await playLastTurn(t);
    for (const c of clients) await privateEnding(c);
    expect(clients[0]!.messages.some((m) => m.type === 'room' && m.gmStatus?.code === 'awaiting_gm')).toBe(false);
  });

  it('C7: the AI fails telling the ending: the game stays ended, the room offers retry, and retry tells it', async () => {
    let failing = true;
    await boot((req, n) => (isFinale(req) ? (failing ? mockReply.fail('provider_error') : markedFinale(req)) : turnWith()(req, n)));
    const t = await startedTable(server!, false);
    const clients = await playLastTurn(t);
    const stuck = (await clients[1]!.waitFor((m) => m.type === 'room' && m.status === 'finale' && m.gmStatus !== null)) as RoomState;
    expect(stuck.gmStatus).toMatchObject({ code: 'stuck', canRetry: true });
    expect(statusOf(t)).toBe('finale');
    expect(ending(t)).toMatchObject({ reason: 'finale', narrated_at: null });
    expect(clients[1]!.entries().filter((e) => e.text.startsWith('ฉากจบส่วนตัว'))).toEqual([]);

    failing = false;
    clients[1]!.send({ type: 'retry' });
    for (const c of clients) await privateEnding(c);
    await clients[0]!.waitFor((m) => m.type === 'room' && m.status === 'finale' && m.gmStatus === null);
    expect(statusOf(t)).toBe('finale');
  });

  it('C7: a restart while the ending is untold keeps the game ended and tells it when someone enters', async () => {
    let failing = true;
    await boot((req, n) => (isFinale(req) ? (failing ? mockReply.fail('provider_error') : markedFinale(req)) : turnWith()(req, n)));
    const t = await startedTable(server!, false);
    const clients = await playLastTurn(t);
    await clients[0]!.waitFor((m) => m.type === 'room' && m.gmStatus !== null);
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();

    failing = false;
    await boot((req, n) => (isFinale(req) ? markedFinale(req) : turnWith()(req, n)));
    expect(statusOf(t)).toBe('finale');
    const again = await enter(t.c);
    await privateEnding(again);
    expect(again.entries().filter((e) => e.text.startsWith('ฉากจบส่วนตัว'))).toHaveLength(1);
  });
});
