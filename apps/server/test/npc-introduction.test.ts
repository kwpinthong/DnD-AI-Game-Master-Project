import type { RoomServerMessage } from '@isekai/protocol';
import type { Period, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { changeNpcAffinity } from '../src/companions/store.ts';
import type { TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { moveCharacter, npcBondsOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-170 (Q-320 B): a grade F / A NPC is known (name_revealed) when a player says its real name in an action, or
 * when the AI GM reports it introduced itself (`introducedNpcs`); hearers = the players at the place (Secret: the
 * actor only). An affinity change alone no longer counts.
 */

type Handler = (req: AiCallRequest) => AiCallResult | undefined;

describe('GEN-170 knowing grade F / A NPCs', { timeout: 60_000 }, () => {
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

  /** The Mock GM with no roll; `tweak` edits its turn proposal. */
  async function boot(tweak: (p: ReturnType<typeof mockTurnProposal>, ctx: TurnContext) => void = () => {}) {
    const handler: Handler = (req) => {
      if (req.output.name !== 'gm_turn_proposal') return undefined;
      const ctx = contextOf<TurnContext>(req);
      const proposal = mockTurnProposal(ctx);
      for (const a of proposal.actions) a.check = { type: 'none' };
      tweak(proposal, ctx);
      return mockReply.ok(proposal);
    };
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
    server = await startTestServer(dataDir, {
      aiProvider: provider,
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }),
    });
  }

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const move = (who: Seat, locationId: string) => expect(moveCharacter(server!.orm, who.memberId, locationId, CLOCK)).toBe(true);
  const knows = (who: Seat, npcId: string) => npcBondsOf(server!.orm, who.memberId).find((b) => b.npcId === npcId)?.nameRevealed ?? false;
  const jumpTo = (t: Table, to: { day: number; phase: Period; turn: Turn }) => {
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), ...to }, CLOCK);
  };

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }
  const opened = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';
  async function playTurn(clients: RoomClient[], texts: string[], next: { day: number; phase: Period; turn: Turn }, visibility: ('public' | 'secret')[] = []) {
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(texts[i]!, visibility[i] ?? 'public');
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
    for (const c of clients) await c.waitFor(opened(next.day, next.phase, next.turn));
  }

  /** A and B at the fountain (Noa and Lucia are there), C at the inn, day 1 SOLARION turn 1. */
  async function atFountain() {
    const t = await startedTable(server!, false);
    move(t.a, 'fountain');
    move(t.b, 'fountain');
    jumpTo(t, { day: 1, phase: 'SOLARION', turn: 1 });
    return { t, clients: [await enter(t.a), await enter(t.b), await enter(t.c)] };
  }
  const NEXT = { day: 1, phase: 'SOLARION', turn: 2 } as const;

  it('C1: A says "สวัสดี โนอา" in public at the fountain: A and B there know Noa, C at the inn does not', async () => {
    await boot();
    const { t, clients } = await atFountain();
    await playTurn(clients, ['สวัสดี โนอา', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], NEXT);
    expect(knows(t.a, 'beggar')).toBe(true);
    expect(knows(t.b, 'beggar')).toBe(true);
    expect(knows(t.c, 'beggar')).toBe(false);
    expect(knows(t.a, 'amnesiac')).toBe(false);
  });

  it('C2: the AI GM reports an NPC there introduced itself: the players at that place know it, an NPC not there is ignored', async () => {
    let here = '';
    await boot((p, ctx) => {
      // The F / A NPC the turn context puts at the fountain (the actor's place), plus one that is elsewhere.
      here = ctx.npcs.find((n) => n.place === 'fountain' && (n.rank === 'F' || n.rank === 'A'))?.id ?? '';
      for (const a of p.actions) if (ctx.actions.find((x) => x.actionId === a.actionId)?.text === 'ฟังเขาเล่า') a.introducedNpcs = [here, 'archivist'];
    });
    const { t, clients } = await atFountain();
    await playTurn(clients, ['ฟังเขาเล่า', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], NEXT);
    expect(here).not.toBe('');
    expect(knows(t.a, here)).toBe(true);
    expect(knows(t.b, here)).toBe(true);
    expect(knows(t.c, here)).toBe(false);
    expect(knows(t.a, 'archivist')).toBe(false);
  });

  it('C3: an affinity change with Lucia, with no name said and no introduction, keeps the alias', async () => {
    await boot((p) => {
      for (const a of p.actions) a.targetNpc = null;
    });
    const { t, clients } = await atFountain();
    const res = changeNpcAffinity(server!.orm, server!.assets, t.a.memberId, 'amnesiac', 2, { day: 1, now: CLOCK });
    expect(res).toMatchObject({ ok: true, after: 2, nameRevealed: false });
    await playTurn(clients, ['ขอร้องหญิงสาวให้เล่าเรื่องนาฬิกา', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], NEXT);
    expect(knows(t.a, 'amnesiac')).toBe(false);
    expect(knows(t.b, 'amnesiac')).toBe(false);
  });

  it('C4: a Secret action that says the name: only the actor knows', async () => {
    await boot();
    const { t, clients } = await atFountain();
    await playTurn(clients, ['กระซิบว่า สวัสดี โนอา', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], NEXT, ['secret']);
    expect(knows(t.a, 'beggar')).toBe(true);
    expect(knows(t.b, 'beggar')).toBe(false);
  });

  it('C5: saying the name of an NPC who is not at the place does not count', async () => {
    await boot();
    const { t, clients } = await atFountain();
    await playTurn(clients, ['ยืนมองน้ำพุ', 'ยืนรอ', 'ถามหาโนอา และ อาร์คบิชอป มัลคอล์ม'], NEXT);
    expect(knows(t.c, 'beggar')).toBe(false);
    expect(knows(t.c, 'archbishop')).toBe(false);
  });

  it('C6: a name already revealed in an old game stays revealed', async () => {
    await boot();
    const { t, clients } = await atFountain();
    server!.db.prepare('insert into npc_bond (member_id, npc_id, name_revealed, updated_at) values (?, ?, 1, ?)').run(t.c.memberId, 'archivist', CLOCK);
    await playTurn(clients, ['ยืนมองน้ำพุ', 'ยืนรอ', 'ล้างแก้ว'], NEXT);
    expect(knows(t.c, 'archivist')).toBe(true);
    changeNpcAffinity(server!.orm, server!.assets, t.c.memberId, 'archivist', -3, { day: 1, now: CLOCK });
    expect(knows(t.c, 'archivist')).toBe(true);
  });
});
