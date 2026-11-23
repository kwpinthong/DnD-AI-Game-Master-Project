import { GmConsoleResponse, type RoomEntry, type RoomServerMessage, type RoomState } from '@isekai/protocol';
import { approveHeldTurn } from './gm-console-client.ts';
import type { Period, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { cannedGmAnswer, contextOf, mockNpcLines, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { CONTEXT_BUDGET, requestTokens, type DialogueContext, type JournalContext, type NarrationContext, type TurnContext } from '../src/gm/context.ts';
import type { GmTurnProposal } from '../src/gm/schema.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { moveCharacter, presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, DARIN, LIN, MEKHA, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-057: the AI GM turn loop over the real play room (WebSocket), with a scripted Mock provider.
 * A turn closes → the server orders the actions → one `gm_adjudicate` → server checks (all-or-nothing) →
 * one repair → dice + apply → narration per place and per player → each player gets their own.
 */

type Handler = (req: AiCallRequest, n: number) => AiCallResult | Promise<AiCallResult | undefined> | undefined;

/** A Mock provider: `handler` answers what it wants, everything else gets the Mock GM's valid answer. */
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

const TURN_OUTPUT = 'gm_turn_proposal';
const NARRATION_OUTPUT = 'gm_narration';
const isTurn = (req: AiCallRequest) => req.output.name === TURN_OUTPUT;
const isNarration = (req: AiCallRequest) => req.output.name === NARRATION_OUTPUT;
const isDialogue = (req: AiCallRequest) => req.output.name === 'gm_dialogue';
const narrationFor = (req: AiCallRequest) => contextOf<NarrationContext>(req).audience;
const lastUserText = (req: AiCallRequest) => req.messages.at(-1)!.text;

/** The Mock GM's proposal with no roll (check none): every action costs exactly its Stamina, no crit / fumble. */
const noRoll: Handler = (req) => {
  if (!isTurn(req)) return undefined;
  const proposal = mockTurnProposal(contextOf<TurnContext>(req));
  for (const a of proposal.actions) a.check = { type: 'none' };
  return mockReply.ok(proposal);
};

describe('GEN-057 AI GM turn loop', { timeout: 60_000 }, () => {
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

  const logs: string[] = [];

  async function boot(env: Record<string, string> = {}, handler?: Handler): Promise<void> {
    provider = gmProvider(handler);
    logs.length = 0;
    server = await startTestServer(dataDir, {
      aiProvider: provider,
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0', ...env }),
      aiLog: (line) => logs.push(line),
    });
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

  const at = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';
  const gmStuck = (m: RoomServerMessage): m is RoomState => m.type === 'room' && m.gmStatus !== null;

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const refOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.ref;
  const move = (who: Seat, locationId: string) => expect(moveCharacter(server!.orm, who.memberId, locationId, CLOCK)).toBe(true);
  const stats = (who: Seat) =>
    server!.db.prepare('select hp, stamina, reputation, karma from character where member_id = ?').get(who.memberId) as { hp: number; stamina: number; reputation: number; karma: number };
  const turnRows = () => server!.db.prepare('select day, phase, turn, status, rolls from gm_turn order by rowid').all() as Record<string, unknown>[];
  const turnEntries = (c: RoomClient, day: number, phase: Period, turn: Turn) =>
    c.entries().filter((e: RoomEntry) => e.day === day && e.phase === phase && e.turn === turn);

  function jumpTo(t: Table, to: { day: number; phase: Period; turn: Turn }) {
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), ...to }, CLOCK);
  }

  const dialogueLogs = () => logs.filter((l) => l.includes('dialogue timing')).length;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Polls (never throws): the dialogue stage of a turn (GEN-116) finishes after the next turn is already open. */
  async function until(done: () => boolean, ms = 3_000) {
    for (const end = Date.now() + ms; !done() && Date.now() < end; ) await pause(10);
  }

  /** The three players act; resolves once the next turn opens for everyone and the turn's dialogue stage (GEN-116) is done. */
  async function playTurn(clients: RoomClient[], texts: string[], next: { day: number; phase: Period; turn: Turn }, visibility: ('public' | 'secret')[] = []) {
    const before = dialogueLogs();
    for (const [i, c] of clients.entries()) await send(c, texts[i]!, visibility[i] ?? 'public');
    for (const c of clients) await c.waitFor(at(next.day, next.phase, next.turn));
    await until(() => dialogueLogs() > before);
    await pause(30);
  }

  /** Q-045: no real name in any prompt, in every test. */
  function expectNoNamesInPrompts() {
    const all = JSON.stringify(provider.requests.map((r) => [r.system, r.messages]));
    for (const name of [LIN.name, DARIN.name, MEKHA.name]) expect(all).not.toContain(name);
  }

  it('C1: three actions, the Mock proposes all three with verb / target tags: all apply and each player gets their own narration', async () => {
    await boot({}, noRoll);
    const t = await startedTable(server!, false);
    const before = [t.a, t.b, t.c].map(stats);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const texts = ['สำรวจโรงเตี๊ยมหาเบาะแส', 'ถามข่าวเจ้าของโรงเตี๊ยม', 'แอบค้นห้องเก็บของ'];
    await playTurn(clients, texts, { day: 1, phase: 'EOSORIA', turn: 2 }, ['public', 'public', 'secret']);

    const turnRequests = provider.requests.filter(isTurn);
    expect(turnRequests.map((r) => r.purpose)).toEqual(['gm_adjudicate']);
    const ctx = contextOf<TurnContext>(turnRequests[0]!);
    expect(ctx.order).toHaveLength(3);
    expect(ctx.tagVocabulary.length).toBeGreaterThan(0);
    const stored = JSON.parse((server!.db.prepare('select proposal from gm_turn').get() as { proposal: string }).proposal) as GmTurnProposal;
    expect(stored.actions.map((a) => a.tagging.verbTags.length)).toEqual([1, 1, 1]);
    expect(turnRows()).toEqual([expect.objectContaining({ day: 1, phase: 'EOSORIA', turn: 1, status: 'applied' })]);

    // Every action applied: a general action costs 3 Stamina (no Drowsy on day 1).
    [t.a, t.b, t.c].forEach((who, i) => expect(stats(who).stamina).toBe(before[i]!.stamina - 3));

    // Each player gets exactly one private narration, about their own action only.
    clients.forEach((c, i) => {
      const narrations = turnEntries(c, 1, 'EOSORIA', 1).filter((e) => e.kind === 'narration');
      expect(narrations).toHaveLength(1);
      expect(narrations[0]!.text).toContain(texts[i]);
      for (const [j, other] of texts.entries()) if (j !== i) expect(narrations[0]!.text).not.toContain(other);
    });
    // The Secret action of C reaches nobody else, in any entry.
    for (const c of clients.slice(0, 2)) expect(JSON.stringify(c.entries())).not.toContain(texts[2]);
    // A and B are at the inn: both see each other's Public action in the place feed.
    expect(turnEntries(clients[0]!, 1, 'EOSORIA', 1).some((e) => e.kind === 'feed' && e.text.includes(texts[1]!))).toBe(true);
    expectNoNamesInPrompts();
  });

  it('GEN-115 C1: a resolved turn logs the time of each stage and the tokens, and no player text', async () => {
    await boot({}, noRoll);
    const t = await startedTable(server!, false);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const texts = ['สำรวจโรงเตี๊ยมหาเบาะแส', 'ถามข่าวเจ้าของโรงเตี๊ยม', 'แอบค้นห้องเก็บของ'];
    await playTurn(clients, texts, { day: 1, phase: 'EOSORIA', turn: 2 });
    const timing = logs.filter((l) => l.startsWith('[gm]') && l.includes(' timing ') && !l.includes('dialogue timing'));
    expect(timing).toHaveLength(1);
    for (const key of ['build_ms', 'adjudicate_ms', 'rules_ms', 'narrate_ms', 'db_ms', 'total_ms', 'in', 'out']) expect(timing[0]).toMatch(new RegExp(`\\b${key}=\\d+`));
    // GEN-116: the dialogue stage has its own line: its calls and tokens, apart from the result stage.
    const dialogue = logs.filter((l) => l.startsWith('[gm]') && l.includes('dialogue timing'));
    expect(dialogue).toHaveLength(1);
    for (const key of ['total_ms', 'in', 'out']) expect(dialogue[0]).toMatch(new RegExp(`\\b${key}=\\d+`));
    timing.push(...dialogue);
    const publish = logs.filter((l) => l.startsWith('[room]') && l.includes(' publish '));
    expect(publish).toHaveLength(1);
    expect(publish[0]).toMatch(/db_ms=\d+ socket_ms=\d+/);
    for (const line of [...timing, ...publish]) for (const secret of [...texts, LIN.name, DARIN.name, MEKHA.name]) expect(line).not.toContain(secret);
  });

  it('C2: a proposal missing one action is repaired once, then applies', async () => {
    await boot({}, (req) => {
      if (req.purpose !== 'gm_adjudicate') return undefined;
      const proposal = mockTurnProposal(contextOf<TurnContext>(req));
      return mockReply.ok({ ...proposal, actions: proposal.actions.slice(0, 2) });
    });
    const t = await startedTable(server!, false);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['เดินดูรอบ ๆ', 'นั่งฟังข่าว', 'ล้างแก้ว'], { day: 1, phase: 'EOSORIA', turn: 2 });

    const turnRequests = provider.requests.filter(isTurn);
    expect(turnRequests.map((r) => r.purpose)).toEqual(['gm_adjudicate', 'gm_repair']);
    expect(lastUserText(turnRequests[1]!)).toContain('missing_action');
    expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied' })]);
  });

  it('C2: a tag that is not in the game data is repaired once', async () => {
    await boot({}, (req) => {
      if (req.purpose !== 'gm_adjudicate') return undefined;
      const proposal = mockTurnProposal(contextOf<TurnContext>(req));
      proposal.actions[0]!.tagging = { verbTags: ['NOT_A_REAL_TAG'], targetTags: [], activate: [] };
      return mockReply.ok(proposal);
    });
    const t = await startedTable(server!, false);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['ร่ายคาถา', 'ยืนดู', 'ปรบมือ'], { day: 1, phase: 'EOSORIA', turn: 2 });
    const turnRequests = provider.requests.filter(isTurn);
    expect(turnRequests.map((r) => r.purpose)).toEqual(['gm_adjudicate', 'gm_repair']);
    expect(lastUserText(turnRequests[1]!)).toContain('unknown_tag');
  });

  it('C2: a wrong action id after the repair too: state unchanged, the room shows "AI GM ติดขัด", and retry works', async () => {
    await boot({}, (req) => {
      if (!isTurn(req)) return undefined;
      const proposal = mockTurnProposal(contextOf<TurnContext>(req));
      proposal.actions[0]!.actionId = 'act-made-up';
      return mockReply.ok(proposal);
    });
    const t = await startedTable(server!, false);
    const before = JSON.stringify([t.a, t.b, t.c].map(stats));
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ขโมยขนม', 'ร้องเพลง', 'เต้นรำ'][i]!);

    const shown = await clients[1]!.waitFor(gmStuck);
    expect(shown).toMatchObject({ status: 'resolving', day: 1, phase: 'EOSORIA', turn: 1 });
    expect(shown.gmStatus).toMatchObject({ code: 'stuck', canRetry: true });
    expect(shown.gmStatus!.message).toContain('AI GM ติดขัด');
    expect(provider.requests.filter(isTurn).map((r) => r.purpose)).toEqual(['gm_adjudicate', 'gm_repair']);
    expect(lastUserText(provider.requests.filter(isTurn)[1]!)).toMatch(/unknown_action|missing_action/);
    // Nothing applied, nothing narrated, nothing stored, every action still there.
    expect(JSON.stringify([t.a, t.b, t.c].map(stats))).toBe(before);
    expect(turnRows()).toEqual([]);
    expect(provider.requests.filter(isNarration)).toEqual([]);
    for (const c of clients) expect(c.entries()).toEqual([]);
    expect(shown.you.action?.text).toBe('ร้องเพลง');

    // Retry with a working AI: the same three actions resolve.
    provider.use(() => undefined);
    clients[1]!.send({ type: 'retry' });
    for (const c of clients) await c.waitFor(at(1, 'EOSORIA', 2));
    expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied' })]);
    expect(contextOf<TurnContext>(provider.requests.filter(isTurn).at(-1)!).actions.map((a) => a.text).sort()).toEqual(['ขโมยขนม', 'ร้องเพลง', 'เต้นรำ'].sort());
  });

  it('GEN-115 C4: the narrations of a turn are asked together, not one after another', async () => {
    let inFlight = 0;
    let peak = 0;
    await boot({}, async (req, n) => {
      if (!isNarration(req)) return noRoll(req, n);
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      return undefined;
    });
    const t = await startedTable(server!, false);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['สำรวจโรงเตี๊ยม', 'ถามข่าว', 'ค้นห้อง'], { day: 1, phase: 'EOSORIA', turn: 2 });
    expect(peak).toBeGreaterThanOrEqual(3);
    for (const c of clients) expect(turnEntries(c, 1, 'EOSORIA', 1).filter((e) => e.kind === 'narration')).toHaveLength(1);
  });

  it('GEN-115 C5: an adjudicate call that times out never hangs the turn: everyone is told, nothing changes, retry works', async () => {
    await boot({}, (req) => (isTurn(req) ? mockReply.fail('timeout') : undefined));
    const t = await startedTable(server!, false);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ขโมยขนม', 'ร้องเพลง', 'เต้นรำ'][i]!);
    const shown = await clients[0]!.waitFor(gmStuck);
    expect(shown.gmStatus).toMatchObject({ code: 'stuck', canRetry: true });
    expect(turnRows()).toEqual([]);
    provider.use(() => undefined);
    clients[0]!.send({ type: 'retry' });
    for (const c of clients) await c.waitFor(at(1, 'EOSORIA', 2));
    expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied' })]);
  });

  it('GEN-068 / Q-156: the AI GM turn applies the period weather (Storm outdoors: Stamina +1; indoors: no extra)', async () => {
    await boot({}, noRoll);
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await clients[0]!.waitFor((m) => m.type === 'room' && m.weather !== null);
    server!.db.prepare("update period_weather set weather = 'Storm' where game_id = ? and day = 1 and phase = 'EOSORIA'").run(gameId);
    move(t.a, 'fountain');
    move(t.b, 'inn');
    move(t.c, 'inn');
    const before = [t.a, t.b, t.c].map(stats);
    await playTurn(clients, ['เดินหาของกินกลางลานน้ำพุ', 'นั่งฟังข่าว', 'ล้างแก้ว'], { day: 1, phase: 'EOSORIA', turn: 2 });
    expect(stats(t.a).stamina).toBe(before[0]!.stamina - 3 - 1);
    expect(stats(t.b).stamina).toBe(before[1]!.stamina - 3);
    expect(stats(t.c).stamina).toBe(before[2]!.stamina - 3);
  });

  it('Q-180: a succeeded action\'s skillFlags and grants are applied with the turn; a wrong flag / grant is repaired first', async () => {
    let refA = '';
    await boot({}, (req, n) => {
      if (!isTurn(req)) return noRoll(req, n);
      const proposal = mockTurnProposal(contextOf<TurnContext>(req));
      for (const a of proposal.actions) a.check = { type: 'none' };
      const mine = proposal.actions.find((a) => a.actor === refA)!;
      if (req.purpose === 'gm_adjudicate') {
        mine.skillFlags = ['protected_others', 'made_up_flag'];
        // Censer is the noble's grade A reward (open); Sanctuary Aegis only after he evolves (not open).
        mine.grants = [
          { kind: 'item', name: 'Censer of Purging Flame', npcId: 'noble' },
          { kind: 'skill', name: 'Sanctuary Aegis', npcId: 'noble' },
        ];
      } else {
        mine.skillFlags = ['protected_others'];
        mine.grants = [{ kind: 'item', name: 'Censer of Purging Flame', npcId: 'noble' }];
      }
      return mockReply.ok(proposal);
    });
    const t = await startedTable(server!, false);
    refA = refOf(t.a);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['ยืนบังเด็กจากรถม้า', 'นั่งฟังข่าว', 'ล้างแก้ว'], { day: 1, phase: 'EOSORIA', turn: 2 });

    const turnRequests = provider.requests.filter(isTurn);
    expect(turnRequests.map((r) => r.purpose)).toEqual(['gm_adjudicate', 'gm_repair']);
    const repairAsk = lastUserText(turnRequests[1]!);
    expect(repairAsk).toContain('unknown_flag');
    expect(repairAsk).toContain('not_unlocked');
    expect(server!.db.prepare('select member_id as m, flag, count from skill_flag').all()).toEqual([{ m: t.a.memberId, flag: 'protected_others', count: 1 }]);
    expect(server!.db.prepare('select member_id as m, npc_id as npc, reward from npc_reward').all()).toEqual([{ m: t.a.memberId, npc: 'noble', reward: 'Censer of Purging Flame' }]);
    expect(server!.db.prepare("select count(*) as n from owned_skill where name = 'Sanctuary Aegis'").get()).toEqual({ n: 0 });
  });

  it('Q-180 / Q-049: a grant still not allowed after the repair: the turn is stuck and no flag or reward is stored', async () => {
    let refA = '';
    await boot({}, (req, n) => {
      if (!isTurn(req)) return noRoll(req, n);
      const proposal = mockTurnProposal(contextOf<TurnContext>(req));
      const mine = proposal.actions.find((a) => a.actor === refA)!;
      mine.skillFlags = ['protected_others'];
      mine.grants = [
        { kind: 'item', name: 'Censer of Purging Flame', npcId: 'noble' },
        { kind: 'item', name: 'Not An Item', npcId: 'noble' },
      ];
      return mockReply.ok(proposal);
    });
    const t = await startedTable(server!, false);
    refA = refOf(t.a);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ช่วยคน', 'นั่ง', 'ยืน'][i]!);
    const shown = await clients[0]!.waitFor(gmStuck);
    expect(shown.gmStatus).toMatchObject({ code: 'stuck' });
    expect(lastUserText(provider.requests.filter(isTurn)[1]!)).toContain('unknown_item');
    expect(server!.db.prepare('select count(*) as n from skill_flag').get()).toEqual({ n: 0 });
    expect(server!.db.prepare('select count(*) as n from npc_reward').get()).toEqual({ n: 0 });
    expect(turnRows()).toEqual([]);
  });

  it('C3: A\'s private narration with B\'s real name (A does not know it) gets the alias instead, with no repair (GEN-117 C6)', async () => {
    let refA = '';
    await boot({}, async (req) => {
      if (!isNarration(req)) return undefined;
      const audience = narrationFor(req);
      if ('player' in audience && audience.player === refA && !lastUserText(req).includes('name_leak')) {
        const answer = (await cannedGmAnswer(req)) as { segments: { actionId: string; text: string }[] };
        answer.segments[0]!.text += ` แล้วคุยกับ${DARIN.name}`;
        return mockReply.ok(answer);
      }
      return undefined;
    });
    const t = await startedTable(server!, false);
    refA = refOf(t.a);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['ทักทายคนข้างโต๊ะ', 'ดื่มชา', 'อ่านประกาศ'], { day: 1, phase: 'EOSORIA', turn: 2 });

    const forA = provider.requests.filter((r) => isNarration(r) && 'player' in narrationFor(r) && (narrationFor(r) as { player: string }).player === refA);
    expect(forA).toHaveLength(1);
    expect(JSON.stringify(clients[0]!.entries())).not.toContain(DARIN.name);
    expect(turnEntries(clients[0]!, 1, 'EOSORIA', 1).filter((e) => e.kind === 'narration')).toHaveLength(1);
  });

  it('Q-219: a narration with a grade S NPC\'s real name is refused; its {{n:id}} token shows the sheet Public_Alias to a player who has not met it', async () => {
    let refA = '';
    await boot({}, async (req) => {
      if (!isNarration(req)) return undefined;
      const audience = narrationFor(req);
      if (!('player' in audience) || audience.player !== refA) return undefined;
      const answer = (await cannedGmAnswer(req)) as { segments: { actionId: string; text: string }[] };
      answer.segments[0]!.text += lastUserText(req).includes('name_leak') ? ' แล้วพบ{{n:horizon-watcher}}ที่หน้าผา' : ' แล้วพบแอสทราที่หน้าผา';
      return mockReply.ok(answer);
    });
    const t = await startedTable(server!, false);
    for (const who of [t.a, t.b, t.c]) move(who, 'sea');
    refA = refOf(t.a);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['มองทะเล', 'เก็บเปลือกหอย', 'นั่งริมผา'], { day: 1, phase: 'EOSORIA', turn: 2 });

    const forA = provider.requests.filter((r) => isNarration(r) && 'player' in narrationFor(r) && (narrationFor(r) as { player: string }).player === refA);
    expect(forA).toHaveLength(1);
    const mine = turnEntries(clients[0]!, 1, 'EOSORIA', 1).filter((e) => e.kind === 'narration');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain('ผู้เฝ้ามองเส้นขอบฟ้า');
    for (const c of clients) expect(JSON.stringify(c.entries())).not.toContain('แอสทรา');
  });

  it('Q-151: a narration still wrong after its repair gets the server template per beat and the game goes on', async () => {
    let refA = '';
    const BAD = 'ข้อความเสียของเอไอ';
    await boot({}, (req, n) => {
      if (!isNarration(req)) return noRoll(req, n);
      const audience = narrationFor(req);
      const broken = ('player' in audience && audience.player === refA) || ('place' in audience && audience.place === 'inn');
      return broken ? mockReply.ok({ segments: [{ actionId: 'act-made-up', text: `${BAD} กับ${DARIN.name}` }] }) : undefined;
    });
    const t = await startedTable(server!, false);
    refA = refOf(t.a);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const texts = ['เช็ดโต๊ะในโรงเตี๊ยม', 'สั่งน้ำชาร้อน', 'ซ่อมเก้าอี้'];
    // The game is not stuck: the next turn opens for everyone.
    await playTurn(clients, texts, { day: 1, phase: 'EOSORIA', turn: 2 });
    expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied' })]);

    // A's private narration and the inn feed: one first try + one repair each, then the template.
    const isBroken = (r: AiCallRequest) => {
      if (!isNarration(r)) return false;
      const a = narrationFor(r);
      return ('player' in a && a.player === refA) || ('place' in a && a.place === 'inn');
    };
    expect(provider.requests.filter(isBroken)).toHaveLength(4);
    const mine = turnEntries(clients[0]!, 1, 'EOSORIA', 1).filter((e) => e.kind === 'narration');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(texts[0]);
    expect(mine[0]!.text).toContain('คุณ');
    expect(mine[0]!.text).toMatch(/สำเร็จ|พลาด/);
    // Q-177: every template narration carries the fallback marker.
    expect(mine[0]).toMatchObject({ fallback: true });
    // The inn feed tells each Public action of the inn, from the validated outcome.
    const feed = turnEntries(clients[1]!, 1, 'EOSORIA', 1).filter((e) => e.kind === 'feed');
    expect(feed.some((e) => texts.every((x) => e.text.includes(x)))).toBe(true);
    for (const c of clients) {
      expect(JSON.stringify(c.entries())).not.toContain(BAD);
    }
    // A does not know B's real name: the template uses how B looks.
    expect(JSON.stringify(clients[0]!.entries())).not.toContain(DARIN.name);
    // The fallback is logged (which audience, not the text).
    // Only the GM narration lines: the GEN-068 weather pick logs its own `source=fallback` here.
    const fallbackLines = logs.filter((l) => l.startsWith('[gm]') && l.includes('fallback'));
    expect(fallbackLines).toHaveLength(2);
    for (const line of fallbackLines) expect(line).toContain('cause=invalid');
    for (const line of logs) {
      for (const secret of [...texts, BAD, LIN.name, DARIN.name, MEKHA.name]) expect(line).not.toContain(secret);
    }
  });

  it('Q-177: a narration call that times out is retried once, then the template goes out with the fallback marker and the cause is logged', async () => {
    let refA = '';
    // AI_MAX_RETRIES 2 for every other call: narration gets exactly one retry.
    await boot({ AI_MAX_RETRIES: '2' }, (req, n) => {
      if (!isNarration(req)) return noRoll(req, n);
      const audience = narrationFor(req);
      return 'player' in audience && audience.player === refA ? mockReply.fail('timeout') : undefined;
    });
    const t = await startedTable(server!, true);
    refA = refOf(t.a);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const texts = ['เช็ดโต๊ะในโรงเตี๊ยม', 'สั่งน้ำชาร้อน', 'ซ่อมเก้าอี้'];
    for (const [i, c] of clients.entries()) await send(c, texts[i]!);
    await approveHeldTurn(t.call, t.gm!.token);
    for (const c of clients) await c.waitFor(at(1, 'EOSORIA', 2));

    const toA = provider.requests.filter((r) => {
      if (!isNarration(r)) return false;
      const audience = narrationFor(r);
      return 'player' in audience && audience.player === refA;
    });
    expect(toA).toHaveLength(2);
    const mine = turnEntries(clients[0]!, 1, 'EOSORIA', 1).filter((e) => e.kind === 'narration');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ fallback: true });
    expect(mine[0]!.text).toContain(texts[0]);
    // The others got the AI's own narration: no marker.
    for (const c of clients.slice(1)) for (const e of turnEntries(c, 1, 'EOSORIA', 1)) expect(e.fallback).toBeUndefined();
    expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied' })]);

    const lines = logs.filter((l) => l.startsWith('[gm]') && l.includes('fallback'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cause=timeout');
    // The GM console shows the cause; players' payloads never carry it.
    const view = GmConsoleResponse.parse((await t.call('GET', '/api/game/gm/console', { token: t.gm!.token })).body);
    expect(view.fallbacks).toEqual([{ at: { day: 1, phase: 'EOSORIA', turn: 1 }, kind: 'narration', memberId: t.a.memberId, locationId: null, cause: 'timeout' }]);
    for (const c of clients) for (const frame of c.raw) expect(frame).not.toContain('timeout');
  });

  it('Q-177 / Q-221: the budget runs out after the adjudication: every narration is the template at once, and the owner sees a lasting gmStatus', async () => {
    const free = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    // Only the adjudication costs (4000 micro-USD) and the ceiling is 1000: it passes, the narrations do not.
    const env = { AI_GAME_MONTHLY_USD: '0.001' };
    const handler: Handler = async (req, n) => {
      if (isTurn(req)) return noRoll(req, n);
      return mockReply.ok(await cannedGmAnswer(req), free);
    };
    await boot(env, handler);
    const t = await startedTable(server!, false);
    let clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    // Before the ceiling: nobody has a gmStatus.
    for (const c of clients) expect(c.lastRoom()!.gmStatus).toBeNull();
    await playTurn(clients, ['ซื้อดาบ', 'ขายผ้า', 'ซ่อมรองเท้า'], { day: 1, phase: 'EOSORIA', turn: 2 });

    expect(provider.requests.filter(isNarration)).toEqual([]);
    for (const c of clients) {
      // GEN-114: the player's own `changes` log is the server's, never a narration.
      const entries = turnEntries(c, 1, 'EOSORIA', 1).filter((e) => e.kind !== 'changes');
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) expect(e.fallback).toBe(true);
      // Q-221: no one-off "ระบบ: ..." narration any more.
      expect(c.entries().filter((e) => e.text.startsWith('ระบบ:'))).toEqual([]);
    }
    // The owner (A) sees why in the room's gmStatus while the game goes on; the other players do not.
    const ownerStatus = (c: RoomClient) => c.lastRoom()!.gmStatus;
    expect(ownerStatus(clients[0]!)).toMatchObject({ code: 'budget_reached', canRetry: false });
    expect(ownerStatus(clients[0]!)!.message).toContain('เพดาน');
    expect(clients[0]!.lastRoom()).toMatchObject({ status: 'collecting', turn: 2 });
    expect(ownerStatus(clients[1]!)).toBeNull();
    expect(ownerStatus(clients[2]!)).toBeNull();
    const lines = logs.filter((l) => l.startsWith('[gm]') && l.includes('fallback'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toContain('cause=budget');

    // It stays on every later room update, and after a restart (read from the stored AI usage, not memory).
    const from = clients[0]!.messages.length;
    await send(clients[1]!, 'ขายผัก');
    await clients[0]!.waitFor((m) => m.type === 'room' && m.submittedCount === 1, from);
    expect(ownerStatus(clients[0]!)).toMatchObject({ code: 'budget_reached' });
    expect(ownerStatus(clients[1]!)).toBeNull();
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    await boot(env, handler);
    clients = [await enter(t.a), await enter(t.b)];
    expect(ownerStatus(clients[0]!)).toMatchObject({ code: 'budget_reached', canRetry: false });
    expect(ownerStatus(clients[1]!)).toBeNull();

    // The budget changes (raised ceiling): the status is gone.
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    await boot({}, handler);
    clients = [await enter(t.a)];
    expect(ownerStatus(clients[0]!)).toBeNull();
  });

  it('Q-221: with a Human GM the GM sees the budget gmStatus, players do not; it ends with the game', async () => {
    await boot({ AI_GAME_MONTHLY_USD: '0' });
    const t = await startedTable(server!, true);
    const gm = await enter(t.gm!);
    const players = [await enter(t.a), await enter(t.b)];
    expect(gm.lastRoom()!.gmStatus).toMatchObject({ code: 'budget_reached', canRetry: false });
    expect(gm.lastRoom()!.gmStatus!.message).toContain('เพดาน');
    for (const p of players) expect(p.lastRoom()!.gmStatus).toBeNull();

    // The game ends: no budget notice on an ended game.
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), status: 'game_over' }, CLOCK);
    const after = await enter(t.gm!);
    expect(after.lastRoom()!.gmStatus).toBeNull();
  });

  it('C4: a constraint the AI sets stays in activeConstraints every turn until the AI releases it with a reason', async () => {
    let refA = '';
    const answers: ((ctx: TurnContext, proposal: GmTurnProposal, repair: boolean) => GmTurnProposal)[] = [
      (_ctx, p) => ({ ...p, constraints: { add: [{ player: refA, text: 'ถูกขังในคุกใต้ป้อมยาม', reason: 'ทหารยามจับได้' }], release: [] } }),
      // Turn 2: a release without a reason is refused; the repair keeps it.
      (ctx, p, repair) => (repair ? p : { ...p, constraints: { add: [], release: [{ id: ctx.players.find((x) => x.ref === refA)!.constraints[0]!.id, reason: '' }] } }),
      (ctx, p) => ({ ...p, constraints: { add: [], release: [{ id: ctx.players.find((x) => x.ref === refA)!.constraints[0]!.id, reason: 'ทหารเปิดประตูคุกให้' }] } }),
    ];
    let turn = 0;
    await boot({}, (req) => {
      if (!isTurn(req)) return undefined;
      const ctx = contextOf<TurnContext>(req);
      const repair = req.purpose === 'gm_repair';
      if (!repair) turn++;
      const answer = answers[turn - 1];
      return answer ? mockReply.ok(answer(ctx, mockTurnProposal(ctx), repair)) : undefined;
    });
    const t = await startedTable(server!, false);
    refA = refOf(t.a);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const constraintsSeen = () =>
      provider.requests
        .filter((r) => r.purpose === 'gm_adjudicate')
        .map((r) => contextOf<TurnContext>(r).players.find((p) => p.ref === refA)!.constraints.map((c) => c.text));

    await playTurn(clients, ['ต่อยทหารยาม', 'ดู', 'ดู'], { day: 1, phase: 'EOSORIA', turn: 2 });
    await playTurn(clients, ['ขอให้ปล่อย', 'ดู', 'ดู'], { day: 1, phase: 'SOLARION', turn: 1 });
    const repairs = provider.requests.filter((r) => r.purpose === 'gm_repair');
    expect(repairs).toHaveLength(1);
    expect(lastUserText(repairs[0]!)).toContain('release_without_reason');
    await playTurn(clients, ['งัดกุญแจ', 'ดู', 'ดู'], { day: 1, phase: 'SOLARION', turn: 2 });
    await playTurn(clients, ['เดินออกจากคุก', 'ดู', 'ดู'], { day: 1, phase: 'HESPERION', turn: 1 });

    expect(constraintsSeen()).toEqual([[], ['ถูกขังในคุกใต้ป้อมยาม'], ['ถูกขังในคุกใต้ป้อมยาม'], []]);
    expect(server!.db.prepare('select release_reason from gm_constraint').all()).toEqual([{ release_reason: 'ทหารเปิดประตูคุกให้' }]);
    // GM-only: the constraint text never reaches a player socket as a field of its own.
    for (const c of clients) for (const raw of c.raw) expect(raw).not.toContain('release_reason');
  });

  it('C5: a new day makes a daily summary that the next turn reads', async () => {
    await boot();
    const t = await startedTable(server!, false);
    jumpTo(t, { day: 1, phase: 'NOCTHERION', turn: 2 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['เฝ้ายามทั้งคืน', 'นับดาว', 'จุดไฟ'], { day: 2, phase: 'EOSORIA', turn: 1 });
    await expect.poll(() => server!.db.prepare("select day from gm_memory where kind = 'day'").all(), { timeout: 5_000 }).toEqual([{ day: 1 }]);
    expect(provider.requests.filter((r) => r.purpose === 'summarize_day')).toHaveLength(1);
    await playTurn(clients, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น'], { day: 2, phase: 'EOSORIA', turn: 2 });
    const ctx = contextOf<TurnContext>(provider.requests.filter((r) => r.purpose === 'gm_adjudicate').at(-1)!);
    expect(ctx.memory.yesterday).toContain('เฝ้ายามทั้งคืน');
  });

  it('Q-153: a new day stores a journal per player from what that player saw, fed to that player\'s next narrations only', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const [refA, refB, refC] = [refOf(t.a), refOf(t.b), refOf(t.c)];
    move(t.c, 'forest');
    jumpTo(t, { day: 1, phase: 'NOCTHERION', turn: 2 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const texts = ['เฝ้ายามหน้าโรงเตี๊ยม', 'แอบนับเหรียญใต้โต๊ะ', 'ตัดไม้ไผ่ริมลำธาร'];
    await playTurn(clients, texts, { day: 2, phase: 'EOSORIA', turn: 1 }, ['public', 'secret', 'public']);

    const journals = () => server!.db.prepare("select member_id as member, day, text from gm_journal where kind = 'day' order by member_id").all() as { member: string; day: number; text: string }[];
    await expect.poll(() => journals().length, { timeout: 5_000 }).toBe(3);
    expect(new Set(journals().map((j) => j.day))).toEqual(new Set([1]));
    const journalReqs = provider.requests.filter((r) => r.purpose === 'summarize_journal');
    expect(journalReqs).toHaveLength(3);
    const reqFor = (ref: string) => journalReqs.find((r) => contextOf<JournalContext>(r).player === ref)!;
    // Only what each player saw that day: A saw its own action (and nothing of B's Secret or C in the forest).
    const seenA = reqFor(refA).messages[0]!.text;
    expect(seenA).toContain(texts[0]);
    expect(seenA).not.toContain(texts[1]);
    expect(seenA).not.toContain(texts[2]);
    expect(reqFor(refB).messages[0]!.text).toContain(texts[1]);
    const seenC = reqFor(refC).messages[0]!.text;
    expect(seenC).toContain(texts[2]);
    expect(seenC).not.toContain(texts[0]);
    for (const r of journalReqs) expect(requestTokens(r.system, r.messages)).toBeLessThanOrEqual(CONTEXT_BUDGET.summarize_journal);
    expectNoNamesInPrompts();

    // The next turn: each private narration gets only its reader's journal; a place feed gets none.
    await playTurn(clients, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น'], { day: 2, phase: 'EOSORIA', turn: 2 });
    const narrations = provider.requests.filter((r) => isNarration(r) && contextOf<NarrationContext>(r).turn.day === 2);
    const privateFor = (ref: string) => narrations.map((r) => contextOf<NarrationContext>(r)).find((c) => 'player' in c.audience && c.audience.player === ref)!;
    expect(privateFor(refA).journal?.yesterday).toContain(texts[0]);
    expect(JSON.stringify(privateFor(refA).journal)).not.toContain(texts[2]);
    expect(privateFor(refC).journal?.yesterday).toContain(texts[2]);
    expect(JSON.stringify(privateFor(refC).journal)).not.toContain(texts[0]);
    for (const c of narrations.map((r) => contextOf<NarrationContext>(r))) if ('place' in c.audience) expect(c.journal).toBeNull();
    // Day 1 is summarised once per player only.
    expect(provider.requests.filter((r) => r.purpose === 'summarize_journal')).toHaveLength(3);
  });

  it('Q-153: a failed journal summary does not hold the game and is made after the next turn', async () => {
    let failures = 0;
    await boot({}, (req) => {
      if (req.purpose === 'summarize_journal' && failures < 1) {
        failures++;
        return mockReply.fail('timeout');
      }
      return undefined;
    });
    const t = await startedTable(server!, false);
    jumpTo(t, { day: 1, phase: 'NOCTHERION', turn: 2 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['จุดตะเกียง', 'ปิดหน้าต่าง', 'ร้องเพลงกล่อม'], { day: 2, phase: 'EOSORIA', turn: 1 });
    await playTurn(clients, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น'], { day: 2, phase: 'EOSORIA', turn: 2 });
    await expect.poll(() => (server!.db.prepare("select count(*) as n from gm_journal where kind = 'day' and day = 1").get() as { n: number }).n, { timeout: 5_000 }).toBe(3);
  });

  it('C5: on day 12 the context stays within the ADR budget (saga + yesterday + today only)', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    const big = (mark: string, n: number) => `${mark} ${'ก'.repeat(n)}`;
    const insertMemory = server!.db.prepare('insert into gm_memory (game_id, kind, day, text, created_at) values (?, ?, ?, ?, 0)');
    for (let day = 1; day <= 11; day++) {
      insertMemory.run(gameId, 'day', day, big(`RECAP-${day}`, 1790));
      insertMemory.run(gameId, 'saga', day, big(`SAGA-${day}`, 4490));
    }
    // Day 12: seven earlier turns, each with three long actions and five notes.
    const insertTurn = server!.db.prepare("insert into gm_turn (game_id, day, phase, turn, status, proposal, rolls, narrations, updated_at) values (?, 12, ?, ?, 'applied', ?, '[]', '{}', 0)");
    const proposal = JSON.stringify({ actions: [1, 2, 3].map(() => ({ intentSummary: 'ข'.repeat(200) })), constraints: { add: [], release: [] }, eventOutcomes: [], remember: [1, 2, 3, 4, 5].map(() => 'ค'.repeat(200)) });
    for (const [phase, turn] of [['EOSORIA', 1], ['EOSORIA', 2], ['SOLARION', 1], ['SOLARION', 2], ['HESPERION', 1], ['HESPERION', 2], ['NOCTHERION', 1]] as const) {
      insertTurn.run(gameId, phase, turn, proposal);
    }
    jumpTo(t, { day: 12, phase: 'NOCTHERION', turn: 2 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['รอฟ้าสาง', 'สวดมนต์', 'เขียนจดหมาย'][i]!);
    for (const c of clients) await c.waitFor((m) => m.type === 'room' && m.status === 'finale');

    const adjudicate = provider.requests.find((r) => r.purpose === 'gm_adjudicate')!;
    const ctx = contextOf<TurnContext>(adjudicate);
    expect(ctx.memory.saga).toContain('SAGA-10');
    expect(ctx.memory.yesterday).toContain('RECAP-11');
    const prompt = JSON.stringify(adjudicate.messages);
    for (let day = 1; day <= 10; day++) expect(prompt).not.toContain(`RECAP-${day} `);
    for (let day = 1; day <= 9; day++) expect(prompt).not.toContain(`SAGA-${day} `);
    expect(requestTokens(adjudicate.system, adjudicate.messages)).toBeLessThanOrEqual(CONTEXT_BUDGET.gm_adjudicate);
    for (const r of provider.requests.filter(isNarration)) {
      const budget = 'player' in narrationFor(r) ? CONTEXT_BUDGET.narrate_player : CONTEXT_BUDGET.narrate_place;
      expect(requestTokens(r.system, r.messages)).toBeLessThanOrEqual(budget);
    }
  });

  it('C6: a restart while resolving goes on once: no second adjudicate, same dice, applied once', async () => {
    let narrations = 0;
    await boot({}, (req, n) => {
      if (!isNarration(req)) return noRoll(req, n);
      narrations++;
      if (narrations === 1) return undefined;
      // The second narration hangs until the server shuts down.
      return new Promise<AiCallResult>((resolve) => req.signal?.addEventListener('abort', () => resolve(mockReply.fail('timeout')), { once: true }));
    });
    const t = await startedTable(server!, false);
    const before = [t.a, t.b, t.c].map(stats);
    let clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ปีนหลังคา', 'เฝ้าประตู', 'นับเงิน'][i]!);
    // GEN-115: the narrations run together: the first passes and is stored, the others hang until the shutdown.
    const storedNarrations = () => Object.keys(JSON.parse((server!.db.prepare('select narrations from gm_turn').get() as { narrations: string } | undefined)?.narrations ?? '{}') as object).length;
    await expect.poll(() => [narrations >= 2, storedNarrations()], { timeout: 5_000 }).toEqual([true, 1]);
    const stored = turnRows();
    expect(stored).toEqual([expect.objectContaining({ status: 'adjudicated' })]);

    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();

    await boot();
    expect([t.a, t.b, t.c].map(stats)).toEqual(before);
    clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const c of clients) await c.waitFor(at(1, 'EOSORIA', 2));
    expect(provider.requests.filter(isTurn)).toEqual([]);
    expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied', rolls: stored[0]!.rolls })]);
    [t.a, t.b, t.c].forEach((who, i) => expect(stats(who).stamina).toBe(before[i]!.stamina - 3));
    for (const c of clients) expect(turnEntries(c, 1, 'EOSORIA', 1).filter((e) => e.kind === 'narration')).toHaveLength(1);
    // The narration that passed before the restart is not asked for again.
    const audiences = provider.requests.filter(isNarration).map((r) => JSON.stringify(narrationFor(r)));
    expect(new Set(audiences).size).toBe(audiences.length);
  });

  it('C7: at the token ceiling the AI is not called, the owner sees why, and the turn waits with nothing lost', async () => {
    await boot({ AI_GAME_MONTHLY_USD: '0' });
    const t = await startedTable(server!, false);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ซื้อดาบ', 'ขายผ้า', 'ซ่อมรองเท้า'][i]!);

    const owner = await clients[0]!.waitFor(gmStuck);
    expect(owner.gmStatus).toMatchObject({ code: 'budget_reached' });
    expect(owner.gmStatus!.message).toContain('เพดาน');
    const player = await clients[1]!.waitFor(gmStuck);
    expect(player.gmStatus!.message).toContain('AI GM ติดขัด');
    expect(provider.requests).toEqual([]);
    expect(player).toMatchObject({ status: 'resolving', day: 1, phase: 'EOSORIA', turn: 1 });

    // Raised ceiling + restart: the same actions resolve.
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    await boot();
    const again = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const c of again) await c.waitFor(at(1, 'EOSORIA', 2));
    expect(contextOf<TurnContext>(provider.requests.find(isTurn)!).actions.map((a) => a.text)).toHaveLength(3);
  });

  it('C8: A at the market, C in the forest: what the AI uses to narrate for A and what A gets hold nothing of C', async () => {
    let refA = '';
    let refC = '';
    let cAction = '';
    await boot({}, async (req) => {
      if (isTurn(req)) cAction = contextOf<TurnContext>(req).actions.find((a) => a.actor === refC)?.actionId ?? cAction;
      if (!isNarration(req)) return undefined;
      const audience = narrationFor(req);
      if ('player' in audience && audience.player === refA && !lastUserText(req).includes('unknown_')) {
        const answer = (await cannedGmAnswer(req)) as { segments: { actionId: string; text: string }[] };
        answer.segments.push({ actionId: cAction, text: `ได้ยินว่า {{p:${refC}}} ตัดไม้ไผ่อยู่` });
        return mockReply.ok(answer);
      }
      return undefined;
    });
    const t = await startedTable(server!, false);
    [refA, refC] = [refOf(t.a), refOf(t.c)];
    move(t.a, 'market');
    move(t.b, 'market');
    move(t.c, 'forest');
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await playTurn(clients, ['ซื้อขนมปังร้านหัวมุม', 'ต่อราคาผ้าไหม', 'ตัดไม้ไผ่ริมลำธาร'], { day: 1, phase: 'EOSORIA', turn: 2 });

    const forA = provider.requests.filter((r) => {
      if (!isNarration(r)) return false;
      const audience = narrationFor(r);
      return ('player' in audience && audience.player === refA) || ('place' in audience && audience.place === 'market');
    });
    expect(forA.length).toBeGreaterThanOrEqual(2);
    // The first request of each audience is what the AI was given (the repair adds its own error list).
    for (const r of forA) expect(r.messages[0]!.text).not.toContain('ตัดไม้ไผ่');
    for (const r of forA) expect(r.messages[0]!.text).not.toContain(refC);
    const repaired = forA.filter((r) => r.messages.length > 1);
    expect(repaired).toHaveLength(1);
    expect(lastUserText(repaired[0]!)).toMatch(/unknown_action|unknown_ref/);
    expect(JSON.stringify(clients[0]!.entries())).not.toContain('ตัดไม้ไผ่');
    expect(turnEntries(clients[2]!, 1, 'EOSORIA', 1).some((e) => e.text.includes('ตัดไม้ไผ่'))).toBe(true);
    expectNoNamesInPrompts();
  });

  describe('GEN-110 NPC lines with the narration', () => {
    const npcEntries = (c: RoomClient, day = 1, phase: Period = 'SOLARION', turn: Turn = 1) => turnEntries(c, day, phase, turn).filter((e) => e.kind === 'npc');
    /** The dialogue stage's answer set by `lines(audience)` (GEN-116); every other request gets the Mock GM's own answer. */
    const withLines =
      (lines: (audience: NarrationContext['audience'], ctx: DialogueContext) => unknown[]): Handler =>
      async (req) => {
        if (!isDialogue(req)) return noRoll(req, 0);
        const ctx = contextOf<DialogueContext>(req);
        return mockReply.ok({ npcLines: lines(ctx.audience, ctx) });
      };
    /** A and B at the fountain at SOLARION (Lucia and Noah are scheduled there), C at the inn. */
    async function atFountain(): Promise<{ t: Table; clients: RoomClient[] }> {
      const t = await startedTable(server!, false);
      move(t.a, 'fountain');
      move(t.b, 'fountain');
      jumpTo(t, { day: 1, phase: 'SOLARION', turn: 1 });
      return { t, clients: [await enter(t.a), await enter(t.b), await enter(t.c)] };
    }

    it('C1 + C2: a public action at a place with NPCs gets 1-3 dialogue lines of one NPC and 1-3 reactions of the others, 1 line each, for everyone there only', async () => {
      await boot({}, noRoll);
      const { clients } = await atFountain();
      await playTurn(clients, ['ขอร้องลูเซียให้เล่าเรื่องนาฬิกา', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });

      for (const c of clients.slice(0, 2)) {
        const lines = npcEntries(c);
        const dialogue = lines.filter((e) => e.npc?.kind === 'dialogue');
        const reactions = lines.filter((e) => e.npc?.kind === 'reaction');
        expect(dialogue.length).toBeGreaterThanOrEqual(1);
        expect(dialogue.length).toBeLessThanOrEqual(3);
        expect(new Set(dialogue.map((e) => e.npc!.ref)).size).toBe(1);
        expect(reactions.length).toBeGreaterThanOrEqual(1);
        expect(reactions.length).toBeLessThanOrEqual(3);
        expect(new Set(reactions.map((e) => e.npc!.ref)).size).toBe(reactions.length);
        expect(lines.length).toBeLessThanOrEqual(12);
        // GEN-107: AI-written NPC lines get the thumbs buttons like the narration.
        for (const e of lines) expect(e.myVote).toBeNull();
        for (const e of lines) expect(e.place).toMatchObject({ id: 'fountain' });
      }
      // The same lines in both feeds; C, at the inn, hears none of the fountain's.
      expect(npcEntries(clients[0]!).map((e) => e.text)).toEqual(npcEntries(clients[1]!).map((e) => e.text));
      expect(npcEntries(clients[2]!).filter((e) => e.place?.id === 'fountain')).toEqual([]);
      // The AI was given exactly the NPCs the schedule puts at the fountain at SOLARION.
      const place = provider.requests.filter(isNarration).map((r) => contextOf<NarrationContext>(r)).find((c) => 'place' in c.audience && c.audience.place === 'fountain')!;
      expect(place.npcs.filter((n) => n.here).map((n) => n.id).sort()).toEqual(['amnesiac', 'beggar']);
    });

    it('C3 + C7: an NPC the schedule does not put at the place, an id that does not exist, 15 lines and a 300-character line: trimmed, the turn still applies', async () => {
      await boot(
        {},
        withLines((audience) =>
          'place' in audience
            ? [
                { npcId: 'guard', kind: 'dialogue', text: 'ข้าไม่ได้อยู่ที่นี่' },
                { npcId: 'ghost', kind: 'reaction', text: 'ข้าไม่มีจริง' },
                { npcId: 'amnesiac', kind: 'dialogue', text: 'ก'.repeat(300) },
                ...Array.from({ length: 12 }, (_, i) => ({ npcId: 'amnesiac', kind: 'dialogue', text: `พูดครั้งที่ ${i + 1}` })),
                { npcId: 'beggar', kind: 'reaction', text: 'เด็กขอทานเงยหน้ามอง' },
              ]
            : [],
        ),
      );
      const { clients } = await atFountain();
      await playTurn(clients, ['ทักลูเซีย', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });

      expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied' })]);
      const lines = npcEntries(clients[0]!);
      expect(lines.map((e) => e.npc!.kind)).toEqual(['dialogue', 'dialogue', 'dialogue', 'reaction']);
      expect(lines.slice(0, 3).map((e) => e.text.length).every((n) => n <= 120)).toBe(true);
      expect(lines[0]!.text.endsWith('…')).toBe(true);
      expect(JSON.stringify(lines)).not.toContain('ไม่ได้อยู่ที่นี่');
      expect(provider.requests.filter(isNarration).every((r) => r.messages.length === 1)).toBe(true);
    });

    it('C3: at EOSORIA nobody is scheduled at the fountain, so a line from an NPC of the place is dropped too', async () => {
      await boot({}, withLines(() => [{ npcId: 'amnesiac', kind: 'dialogue', text: 'ข้ามาแล้ว' }]));
      const t = await startedTable(server!, false);
      move(t.a, 'fountain');
      move(t.b, 'fountain');
      const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
      await playTurn(clients, ['ทักทายคนแถวนี้', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'EOSORIA', turn: 2 });
      expect(npcEntries(clients[0]!, 1, 'EOSORIA')).toEqual([]);
      expect(turnEntries(clients[0]!, 1, 'EOSORIA', 1).filter((e) => e.kind === 'narration')).toHaveLength(1);
    });

    it('C4: a Secret action: nobody else gets a line about it, the owner gets a private line only they read', async () => {
      let refA = '';
      await boot({}, withLines((audience) => ('player' in audience ? (audience.player === refA ? [{ npcId: 'amnesiac', kind: 'dialogue', text: 'ข้าเห็นสิ่งที่เจ้าซ่อนอยู่นะ' }] : []) : [{ npcId: 'beggar', kind: 'reaction', text: 'เด็กขอทานไอเบา ๆ' }])));
      const { t, clients } = await atFountain();
      refA = refOf(t.a);
      await playTurn(clients, ['แอบเปิดกระเป๋าลูเซีย', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 }, ['secret', 'public', 'public']);

      const mine = npcEntries(clients[0]!).filter((e) => e.npc?.private);
      expect(mine.map((e) => e.text)).toEqual(['ข้าเห็นสิ่งที่เจ้าซ่อนอยู่นะ']);
      expect(mine[0]!.place).toBeNull();
      for (const other of clients.slice(1)) {
        expect(JSON.stringify(other.entries())).not.toContain('ข้าเห็นสิ่งที่เจ้าซ่อนอยู่นะ');
        expect(JSON.stringify(other.entries())).not.toContain('แอบเปิดกระเป๋า');
      }
      // The place audience was told about the public action only.
      const place = provider.requests.filter(isNarration).map((r) => contextOf<NarrationContext>(r)).find((c) => 'place' in c.audience)!;
      expect(JSON.stringify(place.beats)).not.toContain('แอบเปิดกระเป๋า');
    });

    it('C4: a player whose action is public gets no private line (what is said in front of everyone is in the place feed once)', async () => {
      await boot({}, withLines((audience) => ('player' in audience ? [{ npcId: 'amnesiac', kind: 'dialogue', text: 'พูดซ้ำอีกรอบ' }] : [])));
      const { clients } = await atFountain();
      await playTurn(clients, ['ทักลูเซีย', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });
      for (const c of clients) expect(npcEntries(c)).toEqual([]);
      const ctxs = provider.requests.filter(isNarration).map((r) => contextOf<NarrationContext>(r));
      expect(ctxs.filter((c) => 'player' in c.audience).every((c) => c.privateLines === false)).toBe(true);
    });

    it('C5: an NPC whose name the viewer has not learned shows as its alias, and as its name once the bond reveals it', async () => {
      await boot({}, noRoll);
      const { t, clients } = await atFountain();
      await playTurn(clients, ['ทักทาย', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });
      const names = (c: RoomClient) => npcEntries(c).map((e) => e.npc!.name);
      expect(names(clients[0]!).length).toBeGreaterThan(0);
      // GEN-121: no grade shows its real name until the player knows it.
      for (const name of names(clients[0]!)) expect(['หญิงสาวผู้พกนาฬิกาพกตาย', 'เด็กขอทานตาบอดข้างหนึ่ง']).toContain(name);

      // A grade S NPC: alias until revealed (Q-219), never the real name in the entry the viewer gets.
      const row = server!.db.prepare("select id from room_entry where kind = 'npc' and location_id = 'fountain' order by id limit 1").get() as { id: number };
      server!.db.prepare("update room_entry set meta = ? where id = ?").run(JSON.stringify({ npc: { id: 'light-spirit', kind: 'dialogue' } }), row.id);
      await clients[0]!.close();
      const again = await enter(t.a);
      const shown = again.entries().find((e) => e.seq === row.id)!;
      expect(shown.npc!.name).toBe('ภูตแห่งแสงในแท่นบูชา');
      expect(JSON.stringify(shown)).not.toContain('ออเรเลีย');
      expect(shown.npc!.grade).toBeUndefined();
    });

    it('C6: the narration prompt carries each player with their karma band and alias, and each NPC with the bond of each of them (never a real name)', async () => {
      await boot({}, noRoll);
      const t = await startedTable(server!, false);
      move(t.a, 'fountain');
      move(t.b, 'fountain');
      jumpTo(t, { day: 1, phase: 'SOLARION', turn: 1 });
      server!.db.prepare('update character set karma = 60 where member_id = ?').run(t.a.memberId);
      server!.db.prepare('update character set karma = -60 where member_id = ?').run(t.b.memberId);
      server!.db.prepare('insert into npc_bond (member_id, npc_id, affinity, name_revealed, updated_at) values (?, ?, 8, 0, 0)').run(t.a.memberId, 'amnesiac');
      const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
      await playTurn(clients, ['ทักลูเซีย', 'ขู่ลูเซีย', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });

      const [refA, refB] = [refOf(t.a), refOf(t.b)];
      const place = provider.requests.filter(isNarration).map((r) => contextOf<NarrationContext>(r)).find((c) => 'place' in c.audience && c.audience.place === 'fountain')!;
      const castOf = (ref: string) => place.cast.find((c) => c.ref === ref)!;
      // GEN-117: a place feed is read by everyone, so it carries nobody's looks (only the alias).
      expect(castOf(refA)).toMatchObject({ karmaBand: 2, looks: '' });
      expect(castOf(refB)).toMatchObject({ karmaBand: -2, looks: '' });
      const lucia = place.npcs.find((n) => n.id === 'amnesiac')!;
      expect(lucia.persona).toEqual(expect.any(String));
      expect(lucia.bonds).toEqual(expect.arrayContaining([
        { player: refA, affinity: 8, met: true },
        { player: refB, affinity: 0, met: false },
      ]));
      expect(lucia.alias).toContain('นาฬิกาพกตาย');
      expect(JSON.stringify(place.npcs)).not.toContain('Chronos');
      expectNoNamesInPrompts();
    });

    it('C8: a narration without npcLines is shown as before and nothing else is added', async () => {
      await boot({}, (req) => {
        if (!isNarration(req)) return noRoll(req, 0);
        return undefined;
      });
      const { clients } = await atFountain();
      await playTurn(clients, ['ขอน้ำ', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });
      for (const c of clients) expect(turnEntries(c, 1, 'SOLARION', 1).filter((e) => e.kind === 'narration')).toHaveLength(1);
      const asked = provider.requests.filter(isNarration);
      expect(asked.length).toBeGreaterThan(0);
    });

    it('the Mock GM gives the same NPC lines every time for the same context', async () => {
      const ctx = {
        kind: 'gm_dialogue',
        audience: { place: 'fountain' },
        turn: { day: 1, phase: 'SOLARION', turn: 1 },
        place: { id: 'fountain', name: 'น้ำพุกลางเมือง' },
        cast: [{ ref: 'r1', looks: 'หญิง', title: '', self: false, karmaBand: 0 }],
        npcs: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, alias: id, grade: 'F', here: true, persona: null, bonds: [] })),
        beats: [{ actionId: 'act-1', kind: 'public_action', actor: 'r1', text: 'ทัก', result: 'success', target: null, targetNpc: null, moved: null, items: [] }],
        privateLines: false,
        narration: [],
        limits: { dialoguePerNpc: 3, reactionNpcs: 3, privatePerPlayer: 2 },
      };
      const req = { output: { name: 'gm_dialogue' }, messages: [{ text: JSON.stringify(ctx) }] } as unknown as AiCallRequest;
      const first = (await cannedGmAnswer(req)) as { npcLines: { npcId: string; kind: string }[] };
      expect(first).toEqual(await cannedGmAnswer(req));
      expect(first.npcLines.filter((l) => l.kind === 'dialogue').length).toBeGreaterThan(0);
      expect(first.npcLines.filter((l) => l.kind === 'reaction').map((l) => l.npcId)).toEqual(['b', 'c', 'd']);
    });

    describe('GEN-116 two stages: the result and narration first, the NPC lines after', () => {
      /** A gate the dialogue stage waits on; `open()` lets every waiting (and later) dialogue call go. */
      function gate() {
        let open = () => {};
        const opened = new Promise<void>((r) => (open = r));
        return { opened, open };
      }
      const dialogueRequests = () => provider.requests.filter(isDialogue);
      const kindsOf = (c: RoomClient) => c.entries().filter((e) => e.kind !== 'changes');
      /** Sends the turn's actions and waits for the next turn to open, without waiting for the dialogue stage. */
      async function playWithoutDialogue(clients: RoomClient[], texts: string[], next: { day: number; phase: Period; turn: Turn }, visibility: ('public' | 'secret')[] = []) {
        for (const [i, c] of clients.entries()) await send(c, texts[i]!, visibility[i] ?? 'public');
        for (const c of clients) await c.waitFor(at(next.day, next.phase, next.turn));
      }
      const turn1 = (c: RoomClient) => turnEntries(c, 1, 'SOLARION', 1);

      it('C1 + C2: the narration is out and the next turn is open while the lines are still being written; players act at once, then the late lines arrive under their own turn, after the narration', async () => {
        const g = gate();
        await boot({}, async (req, n) => {
          if (isDialogue(req)) {
            await g.opened;
            return mockReply.ok({ npcLines: mockNpcLines(contextOf<DialogueContext>(req)) });
          }
          return noRoll(req, n);
        });
        const { clients } = await atFountain();
        await playWithoutDialogue(clients, ['ขอร้องลูเซียให้เล่าเรื่องนาฬิกา', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });

        // C1: result + narration are there, the dialogue stage was asked but has not answered, no line yet.
        expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied' })]);
        for (const c of clients) expect(turn1(c).some((e) => e.kind === 'narration' || e.kind === 'feed')).toBe(true);
        await until(() => dialogueRequests().length > 0);
        expect(dialogueRequests().length).toBeGreaterThan(0);
        for (const c of clients) expect(turn1(c).filter((e) => e.kind === 'npc')).toEqual([]);

        // C2: the next turn is open and takes actions while the dialogue is still pending; turn 2 resolves too.
        for (const c of clients) expect(c.lastRoom()).toMatchObject({ status: 'collecting', turn: 2 });
        await playWithoutDialogue(clients, ['ทักลูเซียอีกครั้ง', 'เดินรอบน้ำพุ', 'ล้างแก้วต่อ'], { day: 1, phase: 'HESPERION', turn: 1 });
        const lastSeqBefore = Math.max(...clients[0]!.entries().map((e) => e.seq));
        expect(npcEntries(clients[0]!)).toEqual([]);

        // Now the lines come. They belong to turn 1 (day / phase / turn) and come after everything already shown (seq).
        g.open();
        await until(() => npcEntries(clients[0]!).length > 0);
        const late = npcEntries(clients[0]!);
        expect(late.length).toBeGreaterThan(0);
        for (const e of late) {
          expect(e).toMatchObject({ day: 1, phase: 'SOLARION', turn: 1 });
          expect(e.seq).toBeGreaterThan(lastSeqBefore - 1);
        }
        const seqs = clients[0]!.entries().map((e) => e.seq);
        expect(new Set(seqs).size).toBe(seqs.length);
        // Nothing of turn 2 was held back or confused by the late lines.
        expect(turnEntries(clients[0]!, 1, 'HESPERION', 1).length).toBe(0);
        expect(turnEntries(clients[0]!, 1, 'SOLARION', 2).some((e) => e.kind === 'narration' || e.kind === 'feed')).toBe(true);
        // C at the inn never hears the fountain's lines.
        expect(npcEntries(clients[2]!).filter((e) => e.place?.id === 'fountain')).toEqual([]);
        expect(kindsOf(clients[0]!).length).toBeGreaterThan(late.length);
      });

      it('C3: the dialogue stage times out, or answers rubbish: the turn stays complete, no lines, at most the one retry, then a log line', async () => {
        await boot({}, (req, n) => {
          if (isDialogue(req)) return mockReply.fail('timeout');
          return noRoll(req, n);
        });
        const { clients } = await atFountain();
        await playTurn(clients, ['ทักลูเซีย', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });
        expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied' })]);
        for (const c of clients) {
          expect(npcEntries(c)).toEqual([]);
          expect(turn1(c).filter((e) => e.kind === 'narration' || e.kind === 'feed').length).toBeGreaterThan(0);
          for (const e of c.entries()) expect(e.fallback).toBeFalsy();
        }
        // The existing narration policy: one retry, so two attempts per audience, never more.
        const perAudience = dialogueRequests().length;
        expect(perAudience).toBeGreaterThan(0);
        expect(perAudience).toBeLessThanOrEqual(dialogueAudiences() * 2);
        expect(logs.some((l) => l.includes('purpose=npc_dialogue') && l.includes('gave up'))).toBe(true);
        for (const c of clients) expect(c.lastRoom()).toMatchObject({ status: 'collecting', turn: 2, gmStatus: null });

        // An answer that does not fit the schema counts the same.
        provider.use((req, n) => (isDialogue(req) ? mockReply.ok({ npcLines: 'nope' }) : noRoll(req, n)));
        const before = dialogueRequests().length;
        await playTurn(clients, ['ถามต่อ', 'มองน้ำ', 'ล้างแก้ว'], { day: 1, phase: 'HESPERION', turn: 1 });
        expect(dialogueRequests().length - before).toBeLessThanOrEqual(dialogueAudiences() * 2);
        for (const c of clients) expect(npcEntries(c, 1, 'SOLARION', 2)).toEqual([]);
      });

      /** Distinct audiences that were asked for lines (the first request of each). */
      const dialogueAudiences = () => new Set(dialogueRequests().map((r) => JSON.stringify(contextOf<DialogueContext>(r).audience))).size;

      it('C4: reload while lines are still arriving: the lines already there are all there once, the rest follow live, nothing twice (replay too)', async () => {
        const g = gate();
        let refA = '';
        await boot({}, async (req, n) => {
          if (!isDialogue(req)) return noRoll(req, n);
          const ctx = contextOf<DialogueContext>(req);
          // The place's lines are quick; A's private line waits for the gate.
          if ('player' in ctx.audience) await g.opened;
          return mockReply.ok({ npcLines: ctx.audience && 'player' in ctx.audience ? (ctx.audience.player === refA ? [{ npcId: 'amnesiac', kind: 'dialogue', text: 'ข้าเห็นสิ่งที่เจ้าซ่อนอยู่นะ' }] : []) : mockNpcLines(ctx) });
        });
        const { t, clients } = await atFountain();
        refA = refOf(t.a);
        await playWithoutDialogue(clients, ['แอบเปิดกระเป๋าลูเซีย', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 }, ['secret', 'public', 'public']);
        await until(() => npcEntries(clients[0]!).length > 0);
        const arrived = npcEntries(clients[0]!).map((e) => e.text);
        expect(arrived.length).toBeGreaterThan(0);

        // Reload A mid-way (a new socket asks for everything).
        await clients[0]!.close();
        const again = await enter(t.a);
        expect(npcEntries(again).map((e) => e.text)).toEqual(arrived);

        g.open();
        await until(() => npcEntries(again).some((e) => e.npc?.private));
        const seqs = again.entries().map((e) => e.seq);
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(npcEntries(again).map((e) => e.text)).toEqual([...arrived, 'ข้าเห็นสิ่งที่เจ้าซ่อนอยู่นะ']);

        // A reconnect with afterSeq = the last seq seen gets nothing twice, and a full replay equals what was shown live.
        const lastSeq = Math.max(...seqs);
        const resumed = await openRoom(server!, { token: t.a.token, afterSeq: lastSeq });
        sockets.push(resumed);
        await resumed.waitFor(isReady);
        expect(resumed.entries()).toEqual([]);
        const full = await openRoom(server!, { token: t.a.token, afterSeq: 0 });
        sockets.push(full);
        await full.waitFor(isReady);
        expect(full.entries().map((e) => e.seq)).toEqual(seqs);
      });

      it('C8: the dialogue stage has its own usage rows (npc_dialogue), apart from the result stage, and the lines follow the game level', async () => {
        await boot({}, noRoll);
        const t = await startedTable(server!, false);
        move(t.a, 'fountain');
        move(t.b, 'fountain');
        jumpTo(t, { day: 1, phase: 'SOLARION', turn: 1 });
        server!.db.prepare('update game set npc_dialogue = ? where id = ?').run('low', gameIdOf(t));
        const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
        await playTurn(clients, ['ทักลูเซีย', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });

        const rows = server!.db.prepare('select purpose, count(*) as n, sum(input_tokens) as inTok, sum(cost_usd_micros) as cost from ai_usage group by purpose').all() as { purpose: string; n: number; inTok: number; cost: number }[];
        const byPurpose = Object.fromEntries(rows.map((r) => [r.purpose, r]));
        expect(byPurpose.npc_dialogue!.n).toBeGreaterThan(0);
        expect(byPurpose.gm_adjudicate!.n).toBe(1);
        expect(Object.keys(byPurpose).some((p) => p.startsWith('narrate_'))).toBe(true);
        expect(byPurpose.npc_dialogue!.cost).toBeGreaterThan(0);
        // low = half of normal: 2 dialogue lines + 2 reactions at most
        const lines = npcEntries(clients[0]!);
        expect(lines.filter((e) => e.npc?.kind === 'dialogue').length).toBeLessThanOrEqual(2);
        expect(lines.filter((e) => e.npc?.kind === 'reaction').length).toBeLessThanOrEqual(2);
        expect(lines.length).toBeGreaterThan(0);
      });

      it('C5: the same answer is cut differently by the level of the game (low < normal < high)', async () => {
        const many = Array.from({ length: 8 }, (_, i) => ({ npcId: 'amnesiac', kind: 'dialogue', text: `พูดครั้งที่ ${i + 1}` }));
        const counts: number[] = [];
        const told: number[] = [];
        await boot({}, withLines((audience) => ('place' in audience ? many : [])));
        const t = await startedTable(server!, false);
        move(t.a, 'fountain');
        move(t.b, 'fountain');
        const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
        for (const [i, level] of ['low', 'normal', 'high'].entries()) {
          const day = i + 1;
          jumpTo(t, { day, phase: 'SOLARION', turn: 1 });
          server!.db.prepare('update game set npc_dialogue = ? where id = ?').run(level, gameIdOf(t));
          await playTurn(clients, ['ทักลูเซีย', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day, phase: 'SOLARION', turn: 2 });
          counts.push(npcEntries(clients[0]!, day).length);
          told.push(contextOf<DialogueContext>(dialogueRequests().at(-1)!).limits.dialoguePerNpc);
        }
        expect(counts).toEqual([2, 3, 6]);
        // the AI is told what will be kept
        expect(told).toEqual([2, 3, 6]);
      });

      it('C8: the budget runs out after the narration: the dialogue stage is stopped (no call) and the turn is complete with the AI narration', async () => {
        // The result stage costs 3000 (adjudicate) + 1000 per narration; the ceiling 3500 is reached before the dialogue asks.
        const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens });
        await boot({ AI_GAME_MONTHLY_USD: '0.0035' }, async (req, n) => {
          if (isTurn(req)) {
            const r = await noRoll(req, n);
            return r && r.ok ? { ...r, usage: usage(1000, 0) } : r;
          }
          return mockReply.ok(await cannedGmAnswer(req), isNarration(req) ? usage(0, 200) : usage(0, 0));
        });
        const { clients } = await atFountain();
        await playTurn(clients, ['ทักลูเซีย', 'ยืนมองน้ำพุ', 'ล้างแก้ว'], { day: 1, phase: 'SOLARION', turn: 2 });

        expect(turnRows()).toEqual([expect.objectContaining({ status: 'applied' })]);
        expect(provider.requests.filter(isNarration).length).toBeGreaterThan(0);
        expect(dialogueRequests()).toEqual([]);
        for (const c of clients) {
          expect(npcEntries(c)).toEqual([]);
          for (const e of turn1(c).filter((x) => x.kind === 'narration' || x.kind === 'feed')) expect(e.fallback).toBeFalsy();
        }
        expect(logs.some((l) => l.includes('purpose=npc_dialogue') && l.includes('budget_reached'))).toBe(true);
        expect(server!.db.prepare("select count(*) as n from ai_usage where purpose = 'npc_dialogue'").get()).toEqual({ n: 0 });
      });
    });
  });
});
