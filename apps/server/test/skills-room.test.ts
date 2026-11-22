import { InventoryResponse, type RoomServerMessage } from '@isekai/protocol';
import type { Period, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import type { TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import type { PhaseResolver } from '../src/room/resolver.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import { moveCharacter, presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/** GEN-055 in the play room: end-of-period item effects (C6) and the AI GM loop counting progress / the library (C1, C7). */

type Handler = (req: AiCallRequest) => AiCallResult | undefined;

function gmProvider(handler: Handler) {
  const provider: AiProvider = {
    id: 'mock',
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      const scripted = handler(req);
      if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
      return mockReply.ok(await cannedGmAnswer(req));
    },
  };
  return provider;
}

describe('GEN-055 skills and items in the play room', { timeout: 60_000 }, () => {
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
    expect(reply).toEqual({ type: 'action_accepted' });
  }

  const at = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';
  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const stats = (who: Seat) => server!.db.prepare('select hp, stamina from character where member_id = ?').get(who.memberId) as { hp: number; stamina: number };
  const give = (who: Seat, item: string) =>
    server!.db.prepare("insert into npc_reward (member_id, npc_id, reward, kind, granted_at) values (?, 'elena', ?, 'item', ?)").run(who.memberId, item, CLOCK);

  async function playTurn(clients: RoomClient[], next: { day: number; phase: Period; turn: Turn }) {
    for (const c of clients) await send(c, 'เดินดูรอบ ๆ');
    for (const c of clients) await c.waitFor(at(next.day, next.phase, next.turn));
  }

  /** HP / Stamina of players as the turn engine holds them (the engine writes them to the character). */
  function setStats(t: Table, values: Record<string, { hp: number; stamina: number }>) {
    const gameId = gameIdOf(t);
    const s = ensurePhaseState(server!.orm, gameId, CLOCK);
    const players = { ...s.players };
    for (const [id, v] of Object.entries(values)) players[id] = { ...players[id]!, ...v };
    savePhaseState(server!.orm, gameId, { ...s, players }, CLOCK);
  }

  it('C6: holding the Silver Rosary of Hearth at a SAFE_ZONE place gives HP +4 / Stamina +3 when the period ends, capped at max', async () => {
    const nothing: PhaseResolver = { resolve: async () => ({}) };
    server = await startTestServer(dataDir, { phaseResolver: nothing });
    const t = await startedTable(server, false);
    // A and B are at the inn (safe); C holds a Rosary too but stands in the market (not safe).
    moveCharacter(server.orm, t.c.memberId, 'market', CLOCK);
    give(t.a, 'Silver Rosary of Hearth');
    give(t.c, 'Silver Rosary of Hearth');
    const s = ensurePhaseState(server.orm, gameIdOf(t), CLOCK);
    setStats(t, { [t.a.memberId]: { hp: 50, stamina: 20 }, [t.b.memberId]: { hp: 50, stamina: 20 }, [t.c.memberId]: { hp: 50, stamina: 20 } });

    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, { day: 1, phase: 'EOSORIA', turn: 2 });
    // Turn 1 does not end the period.
    expect(stats(t.a)).toEqual({ hp: 50, stamina: 20 });
    await playTurn(clients, { day: 1, phase: 'SOLARION', turn: 1 });
    expect(stats(t.a)).toEqual({ hp: 54, stamina: 23 });
    expect(stats(t.b)).toEqual({ hp: 50, stamina: 20 });
    expect(stats(t.c)).toEqual({ hp: 50, stamina: 20 });

    // Near the top it stops at max.
    setStats(t, { [t.a.memberId]: { hp: s.hpMax - 1, stamina: s.staminaMax - 1 } });
    await playTurn(clients, { day: 1, phase: 'SOLARION', turn: 2 });
    await playTurn(clients, { day: 1, phase: 'HESPERION', turn: 1 });
    expect(stats(t.a)).toEqual({ hp: s.hpMax, stamina: s.staminaMax });
  });

  it('C1 + C7 through the AI GM: a PRAY action is counted (Ward of Light), and INVESTIGATE at the library reveals one condition', async () => {
    let mode: 'pray' | 'investigate' = 'pray';
    let investigators: string[] = [];
    server = await startTestServer(dataDir, {
      aiProvider: gmProvider((req) => {
        if (req.output.name !== 'gm_turn_proposal') return undefined;
        const proposal = mockTurnProposal(contextOf<TurnContext>(req));
        for (const a of proposal.actions) {
          a.check = { type: 'none' };
          if (mode === 'pray') a.tagging = { verbTags: ['PRAY'], targetTags: [], activate: [] };
          else if (investigators.includes(a.actor)) {
            a.investigate = true;
            a.tagging = { verbTags: ['INVESTIGATE'], targetTags: ['MIRACLE'], activate: [] };
          }
        }
        return mockReply.ok(proposal);
      }),
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }),
    });
    const t = await startedTable(server, false);
    const gameId = gameIdOf(t);
    // The market is the sheet's library in this game.
    const scenario = getGameScenario(server.orm, gameId)!;
    const locations = scenario.locations.map((l) => (l.id === 'market' ? { ...l, name: 'หอสมุดหลวง' } : l));
    expect(updateGameScenario(server.orm, gameId, { ...scenario, locations }, CLOCK).ok).toBe(true);

    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, { day: 1, phase: 'EOSORIA', turn: 2 });
    const inventory = async (who: Seat) => {
      const res = await t.call('GET', '/api/game/inventory', { token: who.token });
      return InventoryResponse.parse(res.body).inventory;
    };
    for (const who of [t.a, t.b, t.c]) expect((await inventory(who)).skills.map((s) => s.name)).toEqual(['Ward of Light']);
    expect(server.db.prepare("select count(*) as n from skill_activity where activity = 'verb:PRAY'").get()).toEqual({ n: 3 });

    // A investigates at the library (the market); B is there but investigates nothing; C investigates at the inn.
    moveCharacter(server.orm, t.a.memberId, 'market', CLOCK);
    moveCharacter(server.orm, t.b.memberId, 'market', CLOCK);
    mode = 'investigate';
    investigators = [t.a, t.c].map((who) => presenceOf(server!.orm, who.memberId)!.ref);
    await playTurn(clients, { day: 1, phase: 'SOLARION', turn: 1 });
    expect((await inventory(t.a)).discoveries).toEqual([{ kind: 'skill', name: 'The First Light', text: server.assets.ability('The First Light')!.condition }]);
    expect((await inventory(t.b)).discoveries).toEqual([]);
    expect((await inventory(t.c)).discoveries).toEqual([]);
    // Nothing of the condition reached anyone through the room.
    for (const c of clients) expect(JSON.stringify(c.messages)).not.toContain('สวดภาวนาอธิษฐาน');
  });

  it('the Mock GM reads dev markers [mock:verb=TAG] / [mock:investigate=TAG] (localhost checks without a script)', async () => {
    server = await startTestServer(dataDir, { ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }) });
    const t = await startedTable(server, false);
    const gameId = gameIdOf(t);
    const scenario = getGameScenario(server.orm, gameId)!;
    const locations = scenario.locations.map((l) => (l.id === 'inn' ? { ...l, name: 'หอสมุดหลวง' } : l));
    expect(updateGameScenario(server.orm, gameId, { ...scenario, locations }, CLOCK).ok).toBe(true);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [c, text] of [
      [clients[0]!, 'สวดภาวนา [mock:verb=PRAY]'],
      [clients[1]!, 'ค้นตำรา [mock:investigate=MIRACLE]'],
      [clients[2]!, 'เดินดูรอบ ๆ'],
    ] as const) await send(c, text);
    for (const c of clients) await c.waitFor(at(1, 'EOSORIA', 2));
    const res = async (who: Seat) => InventoryResponse.parse((await t.call('GET', '/api/game/inventory', { token: who.token })).body).inventory;
    expect((await res(t.a)).skills.map((s) => s.name)).toEqual(['Ward of Light']);
    expect((await res(t.b)).discoveries.map((d) => d.name)).toEqual(['The First Light']);
    expect((await res(t.c)).skills).toEqual([]);
  });
});
