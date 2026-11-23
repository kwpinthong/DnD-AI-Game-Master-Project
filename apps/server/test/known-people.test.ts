import type { RoomEntry, RoomServerMessage } from '@isekai/protocol';
import { socialTitle, type Period, type Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import type { NarrationContext, TurnContext } from '../src/gm/context.ts';
import type { RunningServer } from '../src/server.ts';
import { learnName, namesVisibleTo, presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, DARIN, LIN, MEKHA, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-117 (Q-292 "A + C"): who knows whom, per player pair, and who looked at whom. A narration describes how a
 * person looks only for a reader whose action was aimed at them; a person the reader does not know shows as the
 * alias (Title Mask) everywhere; a leaked real name is replaced before sending, never failing the turn.
 */

type Handler = (req: AiCallRequest, n: number) => AiCallResult | Promise<AiCallResult | undefined> | undefined;

function gmProvider(handler: Handler = () => undefined) {
  const requests: AiCallRequest[] = [];
  const provider: AiProvider & { requests: AiCallRequest[]; use(h: Handler): void } = {
    id: 'mock',
    requests,
    use(h) {
      handler = h;
    },
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      requests.push(req);
      const scripted = await handler(req, requests.length);
      if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
      return mockReply.ok(await cannedGmAnswer(req));
    },
  };
  return provider;
}

const isTurn = (req: AiCallRequest) => req.output.name === 'gm_turn_proposal';
const isNarration = (req: AiCallRequest) => req.output.name === 'gm_narration';
const narrationOf = (req: AiCallRequest) => contextOf<NarrationContext>(req);
const NEUTRAL = socialTitle(0);

describe('GEN-117 known people and looks', { timeout: 60_000 }, () => {
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
    server = await startTestServer(dataDir, {
      aiProvider: provider,
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }),
    });
  }
  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }
  const at = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Every player acts publicly; resolves once another turn is open for all (the one after the turn they acted in). */
  async function playTurn(clients: RoomClient[], texts: string[]) {
    const from = clients.map((c) => c.messages.length);
    for (const [i, c] of clients.entries()) {
      c.action(texts[i]!, 'public');
      await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from[i]!);
    }
    for (const [i, c] of clients.entries()) {
      const first = c.messages.slice(0, from[i]).reverse().find((m): m is Extract<RoomServerMessage, { type: 'room' }> => m.type === 'room');
      await c.waitFor((m) => m.type === 'room' && m.status === 'collecting' && (m.day !== first?.day || m.phase !== first?.phase || m.turn !== first?.turn), from[i]!);
    }
    await pause(150);
  }
  const refOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.ref;
  const textsOf = (c: RoomClient) => c.entries().map((e: RoomEntry) => e.text).join('\n');
  const narrationsFor = (ref: string) => provider.requests.filter((r) => isNarration(r) && 'player' in narrationOf(r).audience && (narrationOf(r).audience as { player: string }).player === ref);
  async function table() {
    const t = await startedTable(server!, false);
    return { t, clients: [await enter(t.a), await enter(t.b), await enter(t.c)] };
  }

  it('C1: an action that is not aimed at anyone gives no looks of the others, in the prompt or on screen', async () => {
    await boot();
    const { clients } = await table();
    await playTurn(clients, ['เช็ดโต๊ะ', 'ดื่มชา', 'อ่านประกาศ']);

    for (const req of provider.requests.filter(isNarration)) {
      const ctx = narrationOf(req);
      for (const c of ctx.cast.filter((x) => !x.self)) expect(c.looks).toBe('');
    }
    expect(textsOf(clients[0]!)).not.toContain(DARIN.appearance);
    expect(textsOf(clients[0]!)).not.toContain(MEKHA.appearance);
    expect(textsOf(clients[1]!)).not.toContain(LIN.appearance);
  });

  it('C2: A looks at B: A\'s narration may carry B\'s looks; C, who did not look, never gets them', async () => {
    let refB = '';
    await boot((req) => {
      if (!isTurn(req)) return undefined;
      const proposal = mockTurnProposal(contextOf<TurnContext>(req));
      const first = proposal.actions[0] as unknown as { looksAt?: string[] };
      first.looksAt = [refB];
      return mockReply.ok(proposal);
    });
    const { t, clients } = await table();
    refB = refOf(t.b);
    const refA = refOf(t.a);
    await playTurn(clients, ['มองดาริน', 'ดื่มชา', 'อ่านประกาศ']);

    const forA = narrationsFor(refA).map(narrationOf);
    expect(forA.some((ctx) => ctx.cast.some((c) => c.ref === refB && c.looks === DARIN.appearance))).toBe(true);
    for (const req of narrationsFor(refOf(t.c))) expect(JSON.stringify(narrationOf(req))).not.toContain(DARIN.appearance);
    // The place feed is shared by everyone, so it never carries anyone's looks.
    for (const req of provider.requests.filter(isNarration)) {
      const ctx = narrationOf(req);
      if ('place' in ctx.audience) for (const c of ctx.cast) expect(c.looks).toBe('');
    }
    expect(textsOf(clients[2]!)).not.toContain(DARIN.appearance);
  });

  it('C3: a person the reader does not know is the alias on every message, never the character name', async () => {
    await boot();
    const { clients } = await table();
    await playTurn(clients, ['เช็ดโต๊ะ', 'ดื่มชา', 'อ่านประกาศ']);
    await pause(300);
    expect(textsOf(clients[0]!)).toContain(NEUTRAL);
    for (const [i, c] of clients.entries()) {
      for (const [j, name] of [LIN.name, DARIN.name, MEKHA.name].entries()) if (i !== j) expect(textsOf(c)).not.toContain(name);
    }
  });

  it('C4: saying their own name in a public action introduces them to the others, and it survives a restart', async () => {
    await boot();
    const { t, clients } = await table();
    await playTurn(clients, [`แนะนำตัวว่า ฉันชื่อ${LIN.name}`, 'ดื่มชา', 'อ่านประกาศ']);
    expect(namesVisibleTo(server!.orm, t.b.memberId).has(t.a.memberId)).toBe(true);
    expect(namesVisibleTo(server!.orm, t.c.memberId).has(t.a.memberId)).toBe(true);
    // One way only: A did not learn anyone.
    expect(namesVisibleTo(server!.orm, t.a.memberId).size).toBe(0);
    expect(textsOf(clients[1]!)).toContain(LIN.name);

    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    await boot();
    expect(namesVisibleTo(server!.orm, t.b.memberId).has(t.a.memberId)).toBe(true);
  });

  it('C5: the same public event: B, who knows A, reads the name; C, who does not, reads the alias', async () => {
    await boot();
    const { t, clients } = await table();
    learnName(server!.orm, t.b.memberId, t.a.memberId, 'introduced', CLOCK);
    await playTurn(clients, ['เช็ดโต๊ะ', 'ดื่มชา', 'อ่านประกาศ']);

    const feed = (c: RoomClient) => c.entries().filter((e) => e.kind === 'feed').map((e) => e.text).join('\n');
    expect(feed(clients[1]!)).toContain(LIN.name);
    expect(feed(clients[2]!)).not.toContain(LIN.name);
    expect(feed(clients[2]!)).toContain(NEUTRAL);
  });

  it('C6: a real name the AI leaks for a reader who does not know them is replaced by the alias; no repair, no template', async () => {
    let refA = '';
    await boot((req) => {
      if (!isNarration(req) || !('player' in narrationOf(req).audience) || (narrationOf(req).audience as { player: string }).player !== refA) return undefined;
      return cannedGmAnswer(req).then((a) => {
        const answer = a as { segments: { text: string }[] };
        answer.segments[0]!.text += ` แล้วคุยกับ${DARIN.name}`;
        return mockReply.ok(answer);
      });
    });
    const { t, clients } = await table();
    refA = refOf(t.a);
    await playTurn(clients, ['เช็ดโต๊ะ', 'ดื่มชา', 'อ่านประกาศ']);

    expect(narrationsFor(refA)).toHaveLength(1);
    const mine = clients[0]!.entries().filter((e) => e.kind === 'narration');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).not.toContain(DARIN.name);
    expect(mine[0]!.text).toContain(`แล้วคุยกับ${NEUTRAL}`);
    expect(mine[0]!.fallback).toBeUndefined();
  });

  it('C7: when the alias changes, a reader who does not know the person sees the new one next turn', async () => {
    await boot();
    const { t, clients } = await table();
    await playTurn(clients, ['เช็ดโต๊ะ', 'ดื่มชา', 'อ่านประกาศ']);
    const NEW_TITLE = socialTitle(60);
    expect(NEW_TITLE).not.toBe(NEUTRAL);
    server!.db.prepare('update character set reputation = 60 where member_id = ?').run(t.b.memberId);
    const before = clients[0]!.entries().length;
    await playTurn(clients, ['เช็ดโต๊ะอีก', 'ดื่มชาอีก', 'อ่านประกาศอีก']);
    const later = clients[0]!.entries().slice(before).map((e) => e.text).join('\n');
    expect(later).toContain(NEW_TITLE);
    expect(later).not.toContain(DARIN.name);
  });

  it('C8: the Human GM still sees every real name', async () => {
    await boot();
    const t: Table = await startedTable(server!, true);
    const res = await t.call('GET', '/api/game/surroundings', { token: t.gm!.token });
    const raw = JSON.stringify(res.body);
    for (const name of [LIN.name, DARIN.name, MEKHA.name]) expect(raw).toContain(name);
  });
});
