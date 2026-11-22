import { GmConsoleResponse, type RoomEntry, type RoomServerMessage, type RoomState } from '@isekai/protocol';
import { approveHeldTurn } from './gm-console-client.ts';
import type { Period, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { CONTEXT_BUDGET, requestTokens, type JournalContext, type NarrationContext, type TurnContext } from '../src/gm/context.ts';
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

  /** The three players act; resolves once the next turn opens for everyone. */
  async function playTurn(clients: RoomClient[], texts: string[], next: { day: number; phase: Period; turn: Turn }, visibility: ('public' | 'secret')[] = []) {
    for (const [i, c] of clients.entries()) await send(c, texts[i]!, visibility[i] ?? 'public');
    for (const c of clients) await c.waitFor(at(next.day, next.phase, next.turn));
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
    const timing = logs.filter((l) => l.startsWith('[gm]') && l.includes(' timing '));
    expect(timing).toHaveLength(1);
    for (const key of ['build_ms', 'adjudicate_ms', 'rules_ms', 'narrate_ms', 'db_ms', 'total_ms', 'in', 'out']) expect(timing[0]).toMatch(new RegExp(`\\b${key}=\\d+`));
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

  it('C3: A\'s private narration with B\'s real name (A does not know it) is refused and repaired', async () => {
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
    expect(forA).toHaveLength(2);
    expect(lastUserText(forA[1]!)).toContain('name_leak');
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
    expect(forA).toHaveLength(2);
    expect(lastUserText(forA[1]!)).toContain('name_leak');
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
      const entries = turnEntries(c, 1, 'EOSORIA', 1);
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
    await expect.poll(() => narrations, { timeout: 5_000 }).toBe(2);
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
});
