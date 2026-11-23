import type { RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import type { TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-184: the NPC_Schedule row "น็อกทิส at โบสถ์ at dusk / night, karma < -50" holds for a low-karma player only.
 * The rules engine checks presence by each actor's own karma, like the chips that player sees.
 */
const NOCTIS_ALIAS = 'เงาในรอยแยกใต้แท่นพิธี';

describe('GEN-184 NPC presence per actor karma', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];
  const requests: AiCallRequest[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    requests.length = 0;
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  /** The first adjudication aims every action that mentions the shadow at Noctis; a repair is the Mock GM's own. */
  const provider: AiProvider = {
    id: 'mock',
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      requests.push(req);
      if (req.output.name !== 'gm_turn_proposal') return mockReply.ok(await cannedGmAnswer(req));
      const ctx = contextOf<TurnContext>(req);
      const proposal = mockTurnProposal(ctx);
      for (const a of proposal.actions) {
        a.check = { type: 'none' };
        if (req.purpose === 'gm_adjudicate' && ctx.actions.find((x) => x.actionId === a.actionId)?.text.includes('เงา')) a.targetNpc = 'noctis';
      }
      return { ...mockReply.ok(proposal), model: req.model };
    },
  };

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const setKarma = (who: Seat, karma: number) => server!.db.prepare('update character set karma = ? where member_id = ?').run(karma, who.memberId);
  const chips = async (t: Table, who: Seat) => ((await t.call('GET', '/api/game/surroundings', { token: who.token })).body as { npcs: { name: string }[] }).npcs.map((n) => n.name);
  const turnPurposes = () => requests.filter((r) => r.output.name === 'gm_turn_proposal').map((r) => r.purpose);

  /** Day 1 dusk: Noctis (scenario place: the market) with A (karma -60) and B (karma +60) at the temple. */
  async function dusk(): Promise<{ t: Table; clients: RoomClient[] }> {
    server = await startTestServer(dataDir, { aiProvider: provider, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }) });
    const t = await startedTable(server, false);
    const gameId = gameIdOf(t);
    const scenario = getGameScenario(server.orm, gameId)!;
    const noctis = { id: 'noctis', name: 'น็อกทิส', otherNames: [], alias: NOCTIS_ALIAS, rank: 'S' as const, locationId: 'market', personality: '', obsTrait: 0, gmNote: '' };
    expect(updateGameScenario(server.orm, gameId, { ...scenario, npcs: [...scenario.npcs, noctis] }, CLOCK).ok).toBe(true);
    savePhaseState(server.orm, gameId, { ...ensurePhaseState(server.orm, gameId, CLOCK), day: 1, phase: 'HESPERION', turn: 1 }, CLOCK);
    setKarma(t.a, -60);
    setKarma(t.b, 60);
    for (const who of [t.a, t.b]) expect(moveCharacter(server.orm, who.memberId, 'temple', CLOCK)).toBe(true);
    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const c = await openRoom(server, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      clients.push(c);
    }
    return { t, clients };
  }

  async function playTurn(clients: RoomClient[], texts: string[]) {
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(texts[i]!, 'public');
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
    const next = (m: RoomServerMessage) => m.type === 'room' && m.turn === 2 && m.status === 'collecting';
    for (const c of clients) await c.waitFor(next);
  }

  it('C1: the low-karma player sees Noctis at the temple and targeting him is accepted with no repair', async () => {
    const { t, clients } = await dusk();
    expect(await chips(t, t.a)).toContain(NOCTIS_ALIAS);
    await playTurn(clients, ['ถามเงานั้น', 'ยืนมองแท่นบูชา', 'ล้างแก้ว']);
    expect(turnPurposes()).toEqual(['gm_adjudicate']);
  });

  it('C2: the high-karma player at the same place has no Noctis chip, and targeting him is npc_not_present', async () => {
    const { t, clients } = await dusk();
    expect(await chips(t, t.b)).not.toContain(NOCTIS_ALIAS);
    await playTurn(clients, ['ยืนมองแท่นบูชา', 'ถามเงานั้น', 'ล้างแก้ว']);
    expect(turnPurposes()).toEqual(['gm_adjudicate', 'gm_repair']);
    expect(requests.find((r) => r.purpose === 'gm_repair')!.messages.at(-1)!.text).toContain('npc_not_present');
  });
});
