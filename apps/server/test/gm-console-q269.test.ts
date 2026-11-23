import { GmCheckView, GmConsoleResponse, RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { checkViewOf } from '../src/gm/roll-view.ts';
import { character, gameStatus } from '../src/db/schema.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { heldTurn } from './gm-console-client.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer } from './visibility-fixture.ts';

/**
 * GEN-104 (Q-269): the GM console's `pending.checks` and `npcs`. GEN-105 already delivered the fields (roll-hit.test.ts pins
 * the basic shape); these Cases pin each Given/When/Then and cover the gaps (labels that name their source).
 */

type Outcome = Parameters<typeof checkViewOf>[0];

function outcome(modifiers: object[], degree = 'success', total = 18, d20 = 12): Outcome {
  return {
    status: 'resolved',
    actorId: 'm1',
    log: { check: { dc: 11, d20, modifiers, total }, degree, tagging: { verbTags: ['STEALTH'], targetTags: ['NPC'] } },
  } as unknown as Outcome;
}

const nameOf = (ref: string) => (ref === 's1' ? 'Luminous Strike' : undefined);
const action = { text: 'ลอบเข้าไป', visibility: 'secret' as const };

describe('GEN-104 C1 / C2 / C6: a check of the held turn as the GM sees it', () => {
  it('C1: tags, DC, d20, total, outcome and visibility are what the engine used', () => {
    const view = checkViewOf(outcome([{ source: 'skill', ref: 's1', value: 3 }, { source: 'stat', value: 3 }]), action, nameOf)!;
    expect(GmCheckView.parse(view)).toEqual({
      memberId: 'm1',
      text: 'ลอบเข้าไป',
      visibility: 'secret',
      tags: ['STEALTH', 'NPC'],
      dc: 11,
      modifiers: [{ label: 'Luminous Strike', value: 3 }, { label: expect.any(String), value: 3 }],
      d20: 12,
      total: 18,
      outcome: 'success',
    });
  });

  it('C2: weather, fear status, spawn point (origin) and skill each carry a label naming their source', () => {
    const view = checkViewOf(
      outcome([
        { source: 'weather', ref: 'Rain:STEALTH', value: 2 },
        { source: 'status', ref: 'Venom of Despair', value: -3 },
        { source: 'start_passive', value: 1 },
        { source: 'skill', ref: 's1', value: 3 },
      ]),
      action,
      nameOf,
    )!;
    expect(view.modifiers.map((m) => m.label)).toEqual(['ฝนตก', 'Venom of Despair', 'พื้นเพของคุณ', 'Luminous Strike']);
    expect(new Set(view.modifiers.map((m) => m.label)).size).toBe(4);
  });

  it('C6: an action with no roll gives no check (an empty list), never an error', () => {
    const rest = { status: 'resolved', actorId: 'm1', log: { check: null, degree: 'success' } } as unknown as Outcome;
    expect([rest].flatMap((o) => checkViewOf(o, action, nameOf) ?? [])).toEqual([]);
  });
});

describe('GEN-104 C3 / C4 / C6 on the real server', { timeout: 60_000 }, () => {
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

  async function act(client: RoomClient, text: string, rest?: boolean) {
    const from = client.messages.length;
    client.action(text, 'public', rest);
    expect(await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
  }

  it('C3: an NPC hit by Venom shows -3 with the turns left, and is gone from the list after 4 turns', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, true);
    const gameId = (server.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    const npc = getGameScenario(server.orm, gameId)!.npcs[0]!;
    // Cast at turn index 0: it works on turns 1..4 (venom.test.ts pins the casting itself).
    server.orm.insert(gameStatus).values({ gameId, holderKind: 'npc', holderId: npc.id, source: 'Venom of Despair', label: 'หวาดกลัว', value: -3, fromTurn: 1, untilTurn: 4, castBy: t.a.memberId, updatedAt: CLOCK }).run();
    const npcsAt = async (day: number, phase: 'EOSORIA' | 'SOLARION' | 'HESPERION', turn: 1 | 2) => {
      const state = ensurePhaseState(server!.orm, gameId, CLOCK);
      savePhaseState(server!.orm, gameId, { ...state, day, phase, turn }, CLOCK);
      return GmConsoleResponse.parse((await t.call('GET', '/api/game/gm/console', { token: t.gm!.token })).body).npcs;
    };
    const shown = (turnsLeft: number) => [{ npcId: npc.id, name: npc.name, curses: [{ label: 'หวาดกลัว', source: 'Venom of Despair', value: -3, turnsLeft }] }];
    expect(await npcsAt(1, 'EOSORIA', 2)).toEqual(shown(4));
    expect(await npcsAt(1, 'SOLARION', 2)).toEqual(shown(2));
    expect(await npcsAt(1, 'HESPERION', 1)).toEqual(shown(1));
    expect(await npcsAt(1, 'HESPERION', 2)).toEqual([]);
  });

  it('C4: a player and an outsider get 403 from the console; no player payload carries checks, DC or curse numbers', async () => {
    server = await startTestServer(dataDir, { ai: loadAiConfig({ AI_PROVIDER: 'mock' }) });
    const t = await startedTable(server, true);
    const gameId = (server.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    const npc = getGameScenario(server.orm, gameId)!.npcs[0]!;
    server.orm.insert(gameStatus).values({ gameId, holderKind: 'npc', holderId: npc.id, source: 'Venom of Despair', label: 'หวาดกลัว', value: -3, fromTurn: 0, untilTurn: 3, castBy: t.a.memberId, updatedAt: CLOCK }).run();
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const x of [a, b, c]) await act(x, 'มองรอบๆ');
    await heldTurn(t.call, t.gm!.token); // the turn is held; the players have nothing of it yet

    expect((await t.call('GET', '/api/game/gm/console', { token: t.a.token })).status).toBe(403);
    expect((await t.call('GET', '/api/game/gm/console', { token: 'not-a-token' })).status).toBe(401);
    const forbiddenKey = /"(checks|dc|total|modifiers?|turnsLeft|curses)"/;
    for (const path of ['/api/game/surroundings', '/api/game/character', '/api/game/log', '/api/game']) {
      for (const seat of [t.a, t.b, t.c]) {
        const res = await t.call('GET', path, { token: seat.token });
        expect(JSON.stringify(res.body), `${path} as ${seat.name}`).not.toMatch(forbiddenKey);
      }
    }
    for (const client of [a, b, c]) for (const raw of client.raw) {
      expect(RoomServerMessage.safeParse(JSON.parse(raw)).success, raw).toBe(true);
      expect(raw).not.toMatch(forbiddenKey);
    }
  });

  it('C6: a turn where nobody rolls holds pending.checks as an empty list', async () => {
    server = await startTestServer(dataDir, { ai: loadAiConfig({ AI_PROVIDER: 'mock' }) });
    const t = await startedTable(server, true);
    server.orm.update(character).set({ coins: 20 }).run(); // REST at the inn costs 5 coins
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const x of [a, b, c]) await act(x, 'พักผ่อน', true);
    const pending = await heldTurn(t.call, t.gm!.token);
    expect(pending.checks).toEqual([]);
  });
});
