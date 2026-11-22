import type { RoomServerMessage, RoomState } from '@isekai/protocol';
import type { Period, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { strategyRefuges } from '../src/finale/store.ts';
import type { TurnContext } from '../src/gm/context.ts';
import type { FinaleContext } from '../src/gm/finale.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { GM_OUTPUT, type GmAction } from '../src/gm/schema.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { recordStrategyParticipation, strategyOutcomes, strategyParticipants } from '../src/strategy/store.ts';
import { advanceTimeline, setEventOutcome } from '../src/timeline/store.ts';
import { moveCharacter, presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-093 (Q-203): on the night of day 10 (NOCTHERION) the AI GM names the Day10_Strategies plan and the role
 * (leader / support) of each action; the server checks it, records it per player with the action's result, and
 * the day 12 finale reads it (S buffs and refuges).
 */

type Handler = (req: AiCallRequest, n: number) => AiCallResult | Promise<AiCallResult | undefined> | undefined;
type Plan = GmAction['strategy'];

function gmProvider() {
  const requests: AiCallRequest[] = [];
  let current: Handler = () => undefined;
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
const ended = (m: RoomServerMessage): m is RoomState => m.type === 'room' && (m.status === 'finale' || m.status === 'game_over');

/** No dice (every action succeeds); `plans` maps a player ref to the plan the AI names for their action. */
const turnWith =
  (plans: () => Record<string, Plan>, repaired?: () => Record<string, Plan>): Handler =>
  (req) => {
    if (!isTurn(req)) return undefined;
    const proposal = mockTurnProposal(contextOf<TurnContext>(req));
    const use = req.purpose === 'gm_repair' && repaired ? repaired() : plans();
    for (const a of proposal.actions) {
      a.check = { type: 'none' };
      a.strategy = use[a.actor] ?? null;
    }
    return mockReply.ok(proposal);
  };

describe('GEN-093 Day 10 strategies', { timeout: 60_000 }, () => {
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

  async function boot(): Promise<void> {
    provider = gmProvider();
    server = await startTestServer(dataDir, { aiProvider: provider, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }) });
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
    const reply = await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
    expect(reply, JSON.stringify(reply)).toEqual({ type: 'action_accepted' });
  }

  const at = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';
  const gmStuck = (m: RoomServerMessage): m is RoomState => m.type === 'room' && m.gmStatus !== null;

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const refOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.ref;
  const move = (who: Seat, locationId: string) => expect(moveCharacter(server!.orm, who.memberId, locationId, CLOCK)).toBe(true);
  const setKarma = (t: Table, karma: Map<string, number>) => {
    const gameId = gameIdOf(t);
    for (const [id, k] of karma) server!.db.prepare('update character set karma = ? where member_id = ?').run(k, id);
    const state = ensurePhaseState(server!.orm, gameId, CLOCK);
    savePhaseState(server!.orm, gameId, { ...state, players: Object.fromEntries(Object.entries(state.players).map(([id, p]) => [id, { ...p, karma: karma.get(id) ?? p.karma }])) }, CLOCK);
  };
  const participants = (t: Table) =>
    strategyParticipants(server!.orm, gameIdOf(t))
      .map((p) => ({ memberId: p.memberId, strategyId: p.strategyId, role: p.role, success: p.success }))
      .sort((x, y) => `${x.memberId}${x.strategyId}`.localeCompare(`${y.memberId}${y.strategyId}`));

  /** The game at `to` with the timeline there too. */
  function jumpTo(t: Table, to: { day: number; phase: Period; turn: Turn }) {
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), ...to }, CLOCK);
    expect(advanceTimeline(server!.orm, gameId, { day: to.day, phase: to.phase }, CLOCK)).toMatchObject({ ok: true });
  }

  /** Day 10 NOCTHERION turn 1, everyone acts; resolves once turn 2 opens. */
  async function playNight10(t: Table, texts = ['นำทัพบุกโบสถ์', 'ร่วมพิธีกรรม', 'เฝ้าดูอยู่ห่าง ๆ']) {
    jumpTo(t, { day: 10, phase: 'NOCTHERION', turn: 1 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, texts[i]!);
    for (const c of clients) await c.waitFor(at(10, 'NOCTHERION', 2));
    return clients;
  }

  it('C1: night 10, the Mock names D10-S1 leader for A and it succeeds: (A, D10-S1, leader, success) is recorded', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(turnWith(() => ({ [refOf(t.a)]: { id: 'D10-S1', role: 'leader' } })));
    await playNight10(t);
    expect(participants(t)).toEqual([{ memberId: t.a.memberId, strategyId: 'D10-S1', role: 'leader', success: true }]);
    // The AI GM was given the plans of the night (Day10_Strategies rows) in the turn context.
    const ctx = contextOf<TurnContext>(provider.requests.filter(isTurn)[0]!);
    expect(ctx.events.active.flatMap((e) => e.strategies.map((s) => s.id))).toEqual(['D10-S1', 'D10-S2', 'D10-S3', 'D10-S4']);
  });

  it('C2: a strategyId that is not in the game data is repaired once; the repaired answer (no plan) records nothing', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(turnWith(() => ({ [refOf(t.a)]: { id: 'D10-S9', role: 'leader' } }), () => ({})));
    await playNight10(t);
    const turnRequests = provider.requests.filter(isTurn);
    expect(turnRequests.map((r) => r.purpose)).toEqual(['gm_adjudicate', 'gm_repair']);
    expect(turnRequests[1]!.messages.at(-1)!.text).toContain('unknown_strategy');
    expect(participants(t)).toEqual([]);
  });

  it('C2: D10-DRIFT is not a plan anyone runs: refused like an unknown id', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(turnWith(() => ({ [refOf(t.a)]: { id: 'D10-DRIFT', role: 'leader' } }), () => ({})));
    await playNight10(t);
    const turnRequests = provider.requests.filter(isTurn);
    expect(turnRequests.map((r) => r.purpose)).toEqual(['gm_adjudicate', 'gm_repair']);
    expect(turnRequests[1]!.messages.at(-1)!.text).toContain('unknown_strategy');
    expect(participants(t)).toEqual([]);
  });

  it('C2: a plan named outside the night of day 10 is repaired once; still wrong: the turn is stuck and nothing is recorded', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(turnWith(() => ({ [refOf(t.a)]: { id: 'D10-S1', role: 'leader' } })));
    // Day 10 HESPERION: the night has not begun.
    jumpTo(t, { day: 10, phase: 'HESPERION', turn: 1 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['เตรียมทัพ', 'ซ่อมดาบ', 'สวดมนต์'][i]!);
    await clients[0]!.waitFor(gmStuck);
    const turnRequests = provider.requests.filter(isTurn);
    expect(turnRequests.map((r) => r.purpose)).toEqual(['gm_adjudicate', 'gm_repair']);
    expect(turnRequests[1]!.messages.at(-1)!.text).toContain('strategy_not_active');
    expect(participants(t)).toEqual([]);
  });

  it('C3: nobody ran a plan: once the night of day 10 is over, D10-DRIFT is recorded for the game', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    jumpTo(t, { day: 10, phase: 'NOCTHERION', turn: 1 });
    expect(strategyOutcomes(server!.orm, gameId)).toEqual([]);
    jumpTo(t, { day: 11, phase: 'EOSORIA', turn: 1 });
    expect(strategyOutcomes(server!.orm, gameId)).toEqual([{ strategyId: 'D10-DRIFT', outcome: 'drift' }]);
    expect(strategyRefuges(server!.orm, server!.assets, gameId)).toEqual({ buffs: new Map(), places: new Set() });
  });

  it('C4: A led D10-S1 to success: at the day 12 finale (no path) A counts the S buff and the church is a refuge', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(turnWith(() => ({ [refOf(t.a)]: { id: 'D10-S1', role: 'leader' } })));
    await playNight10(t);
    await Promise.all(sockets.splice(0).map((s) => s.close()));

    // A at the fountain (not safe), B in the church (not a SAFE_ZONE by itself), C at the fountain.
    move(t.a, 'fountain');
    move(t.b, 'temple');
    move(t.c, 'fountain');
    provider.use((req, n) => (isFinale(req) ? undefined : turnWith(() => ({}))(req, n)));
    jumpTo(t, { day: 12, phase: 'NOCTHERION', turn: 2 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['มองฟ้า', 'สวดมนต์', 'เขียนจดหมาย'][i]!);
    for (const c of clients) await c.waitFor(ended);

    const ending = server!.db.prepare('select path, outcomes from game_ending where game_id = ?').get(gameIdOf(t)) as { path: string; outcomes: string };
    expect(ending.path).toBe('none');
    expect(JSON.parse(ending.outcomes)).toEqual({ [t.a.memberId]: 'survived', [t.b.memberId]: 'survived', [t.c.memberId]: 'defeated' });
    const ctx = contextOf<FinaleContext>(provider.requests.find(isFinale)!);
    const byRef = new Map(ctx.players.map((p) => [p.ref, p]));
    expect(byRef.get(refOf(t.a))).toMatchObject({ protectedBy: ['แสงรุ่งอรุณคืนเมือง'], inSafeZone: false });
    expect(byRef.get(refOf(t.b))).toMatchObject({ protectedBy: [], inSafeZone: true });
  });

  /** Day 5 with an outcome of `side` set by the AI GM (undefined = nobody stepped in), then A leads `plan` on night 10 with `success`, then day 11. */
  function playOut(t: Table, side: 'good' | 'evil' | 'neutral' | null | undefined, plan: string, success: boolean) {
    const gameId = gameIdOf(t);
    jumpTo(t, { day: 5, phase: 'EOSORIA', turn: 1 });
    if (side !== undefined) expect(setEventOutcome(server!.orm, gameId, 'd5-disaster', 'ผู้เล่นเข้าแทรกแซงภัยพิบัติ', side, CLOCK)).toEqual({ ok: true });
    jumpTo(t, { day: 10, phase: 'NOCTHERION', turn: 2 });
    recordStrategyParticipation(server!.orm, gameId, { memberId: t.a.memberId, strategyId: plan, role: 'leader', success, day: 10 }, CLOCK);
    jumpTo(t, { day: 11, phase: 'EOSORIA', turn: 1 });
    return strategyRefuges(server!.orm, server!.assets, gameId);
  }

  it('C5: D10-S2 succeeded and day 5 went Good: the clinic is a refuge', async () => {
    await boot();
    const t = await startedTable(server!, false);
    expect(playOut(t, 'good', 'D10-S2', true).places).toEqual(new Set(['clinic']));
  });

  it('C5: D10-S2 succeeded but day 5 was not Good (drift): no clinic refuge', async () => {
    await boot();
    const t = await startedTable(server!, false);
    expect(playOut(t, undefined, 'D10-S2', true)).toEqual({ buffs: new Map(), places: new Set() });
  });

  it('C5: D10-S2 succeeded but day 5 went Evil: no clinic refuge', async () => {
    await boot();
    const t = await startedTable(server!, false);
    expect(playOut(t, 'evil', 'D10-S2', true).places).toEqual(new Set());
  });

  it('C6: a plan that failed gives no buff and no refuge (and the night counts as drift)', async () => {
    await boot();
    const t = await startedTable(server!, false);
    expect(playOut(t, undefined, 'D10-S1', false)).toEqual({ buffs: new Map(), places: new Set() });
    expect(strategyOutcomes(server!.orm, gameIdOf(t))).toEqual([
      { strategyId: 'D10-DRIFT', outcome: 'drift' },
      { strategyId: 'D10-S1', outcome: 'failed' },
    ]);
  });

  it('C7: two plans in one night (S1 and S3): each player is recorded on their own plan; S3 gives its buff to Evil-side players only', async () => {
    await boot();
    const t = await startedTable(server!, false);
    // B just on the Evil side (-14), C on the edge of neutral (-13).
    setKarma(t, new Map([[t.b.memberId, -14], [t.c.memberId, -13]]));
    provider.use(
      turnWith(() => ({
        [refOf(t.a)]: { id: 'D10-S1', role: 'leader' },
        [refOf(t.b)]: { id: 'D10-S3', role: 'leader' },
        [refOf(t.c)]: { id: 'D10-S3', role: 'support' },
      })),
    );
    await playNight10(t);
    expect(participants(t)).toEqual(
      [
        { memberId: t.a.memberId, strategyId: 'D10-S1', role: 'leader', success: true },
        { memberId: t.b.memberId, strategyId: 'D10-S3', role: 'leader', success: true },
        { memberId: t.c.memberId, strategyId: 'D10-S3', role: 'support', success: true },
      ].sort((x, y) => `${x.memberId}${x.strategyId}`.localeCompare(`${y.memberId}${y.strategyId}`)),
    );
    jumpTo(t, { day: 11, phase: 'EOSORIA', turn: 1 });
    const refuges = strategyRefuges(server!.orm, server!.assets, gameIdOf(t));
    expect(refuges.buffs).toEqual(new Map([[t.a.memberId, ['แสงรุ่งอรุณคืนเมือง']], [t.b.memberId, ['พันธสัญญาจันทราโลหิต']]]));
    expect(refuges.places).toEqual(new Set(['temple']));
  });

  it('C8: the record survives a restart; no player API shows who ran which plan before the game ends', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(turnWith(() => ({ [refOf(t.a)]: { id: 'D10-S1', role: 'leader' }, [refOf(t.b)]: { id: 'D10-S1', role: 'support' } })));
    await playNight10(t);
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    server = await startTestServer(dataDir, { aiProvider: provider, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }) });
    expect(participants(t).map((p) => [p.memberId, p.role])).toEqual(
      [
        [t.a.memberId, 'leader'],
        [t.b.memberId, 'support'],
      ].sort((x, y) => `${x[0]}D10-S1`.localeCompare(`${y[0]}D10-S1`)),
    );
    const call = caller(server!);
    for (const who of [t.a, t.b, t.c]) {
      for (const path of ['/api/game', '/api/game/character', '/api/game/timeline', '/api/game/surroundings', '/api/game/log', '/api/game/origin', '/api/game/companions', '/api/game/inventory']) {
        const res = await call('GET', path, { token: who.token });
        expect(res.status, path).toBe(200);
        expect(JSON.stringify(res.body), path).not.toMatch(/D10-S\d|"leader"|"support"|แสงรุ่งอรุณคืนเมือง/);
      }
    }
  });
});
