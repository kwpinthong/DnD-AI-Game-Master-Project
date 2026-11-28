// ISK-098: each player's memory of the game by topic, made by the day's `summarize_journal` from what reached that
// player only, fed to what that player alone reads (narrate_player, their NPC chat, NPC lines to them only).
import { AdminPlayerMemory, defaultScenario, SurroundingsResponse, type RoomServerMessage } from '@isekai/protocol';
import { CONTRACT, type HttpItem } from '@isekai/protocol/contract';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { hashPin } from '../src/auth/pin.ts';
import { estimateTokens, type DialogueContext, type JournalContext, type NarrationContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf } from '../src/gm/mock-gm.ts';
import type { NpcChatContext } from '../src/npc-chat/prompt.ts';
import { ensurePhaseState, insertEntry, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { moveCharacter, presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, CREATE_CODE, DARIN, LIN, MEKHA, startedTable, type Seat, type Table } from './visibility-fixture.ts';

type Handler = (req: AiCallRequest) => AiCallResult | undefined | Promise<AiCallResult | undefined>;

const ADMIN_CODE = 'เจ้าของ-ความจำ-2026';
const MARKET = 'market';
const merchant = defaultScenario().npcs.find((n) => n.id === 'merchant')!;
const OTHER = 'เรื่องอื่นๆ';
const cps = (s: string) => [...s].length;
const charsOf = (topics: readonly { title: string; summary: string }[]) => topics.reduce((n, t) => n + cps(t.title) + cps(t.summary), 0);
const graphemes = (s: string) => [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);

/** A Mock provider: `use(handler)` answers what it wants; the rest gets the Mock GM's answer (and a plain NPC chat reply). */
function memoryProvider() {
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
      const scripted = await current(req);
      if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
      if (req.purpose === 'npc_chat') return mockReply.ok({ reply: 'ตลาดวันนี้คึกคักดี', suggestion: null, mood: 'same' });
      return mockReply.ok(await cannedGmAnswer(req));
    },
  };
  return provider;
}

describe('ISK-098 player memory', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let provider: ReturnType<typeof memoryProvider>;
  const sockets: RoomClient[] = [];
  const logs: string[] = [];

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function boot(handler: Handler = () => undefined) {
    provider = memoryProvider();
    provider.use(handler);
    logs.length = 0;
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }), aiLog: (line) => logs.push(line), rng: null, aiProvider: provider },
    );
  }

  const db = () => server!.db;
  const gameIdOf = (t: Table) => (db().prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const refOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.ref;
  const jumpTo = (t: Table, to: { day: number; phase: 'EOSORIA' | 'SOLARION' | 'HESPERION' | 'NOCTHERION'; turn: 1 | 2 }) =>
    savePhaseState(server!.orm, gameIdOf(t), { ...ensurePhaseState(server!.orm, gameIdOf(t), CLOCK), ...to }, CLOCK);
  const at = (day: number) => (m: RoomServerMessage) => m.type === 'room' && m.day === day && m.phase === 'EOSORIA' && m.turn === 1 && m.status === 'collecting';
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(done: () => boolean, ms = 8_000) {
    for (const end = Date.now() + ms; !done() && Date.now() < end; ) await pause(20);
    expect(done(), 'condition reached in time').toBe(true);
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }
  async function send(client: RoomClient, text: string, visibility: 'public' | 'secret') {
    const from = client.messages.length;
    client.action(text, visibility);
    expect(await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
  }

  /** Plays the last turn of `day` (A, B, C act) and waits until day + 1 opens. */
  async function endDay(t: Table, day: number, opts: { texts?: string[]; visibility?: ('public' | 'secret')[]; before?: () => void; seats?: Seat[] } = {}) {
    jumpTo(t, { day, phase: 'NOCTHERION', turn: 2 });
    opts.before?.();
    const clients: RoomClient[] = [];
    for (const seat of opts.seats ?? [t.a, t.b, t.c]) clients.push(await enter(seat));
    const texts = opts.texts ?? ['เฝ้ายามทั้งคืน', 'นับดาว', 'จุดไฟ'];
    for (const [i, c] of clients.entries()) await send(c, texts[i]!, opts.visibility?.[i] ?? 'public');
    for (const c of clients) await c.waitFor(at(day + 1));
    for (const c of clients) {
      await c.close();
      sockets.splice(sockets.indexOf(c), 1);
    }
  }

  const journalOf = (r: AiCallRequest) => contextOf<JournalContext>(r);
  /** The first narrate_player context of `ref` (on `day` when given). */
  const narrationFor = (ref: string, day?: number) =>
    provider.requests
      .filter((r) => r.purpose === 'narrate_player')
      .map((r) => contextOf<NarrationContext>(r))
      .find((c) => 'player' in c.audience && c.audience.player === ref && (day === undefined || c.turn.day === day));
  const journalReqs = (ref: string, day?: number) =>
    provider.requests.filter((r) => r.purpose === 'summarize_journal' && journalOf(r).player === ref && (day === undefined || journalOf(r).day === day));
  const journalRow = (memberId: string, day: number) => db().prepare("select text from gm_journal where member_id = ? and kind = 'day' and day = ?").get(memberId, day) as { text: string } | undefined;
  /** Waits until the summary of `day` for `who` was stored or logged as failed / invalid. */
  const settled = (who: Seat, ref: string, day: number) => until(() => journalRow(who.memberId, day) !== undefined || logs.some((l) => l.includes(`summarize_journal day=${day} player=${ref} `)));
  const topicsOf = (memberId: string) =>
    db()
      .prepare('select topic_id as topicId, title, summary, first_day as firstDay, last_day as lastDay from player_memory where member_id = ? order by last_day desc, first_day desc, topic_id')
      .all(memberId) as { topicId: string; title: string; summary: string; firstDay: number; lastDay: number }[];
  const pendingOf = (memberId: string) => (db().prepare('select memory_pending_from_day as p from member where id = ?').get(memberId) as { p: number | null }).p;
  function seedTopic(t: Table, who: Seat, topic: { topicId: string; title: string; summary: string; firstDay: number; lastDay: number }) {
    db()
      .prepare('insert into player_memory (game_id, member_id, topic_id, title, summary, first_day, last_day, updated_at) values (?, ?, ?, ?, ?, ?, ?, 0)')
      .run(gameIdOf(t), who.memberId, topic.topicId, topic.title, topic.summary, topic.firstDay, topic.lastDay);
  }
  /** A's summary of `day` gets `value`; every other summary changes no topic. */
  const forA = (ref: string, day: number, value: unknown): Handler => (req) => {
    if (req.purpose !== 'summarize_journal') return undefined;
    const c = journalOf(req);
    if (c.player === ref && c.day === day) return typeof value === 'function' ? (value as () => AiCallResult)() : mockReply.ok(value);
    return mockReply.ok({ journal: `วันที่ ${c.day} ผ่านไปเงียบๆ`, topics: [] });
  };
  const at4 = (t: Table, who: Seat, day: number, text: string, kind: 'npc' | 'feed' | 'narration', extra: { locationId?: string | null; meta?: object } = {}) =>
    insertEntry(server!.orm, gameIdOf(t), { kind, at: { day, phase: 'NOCTHERION', turn: 1 }, locationId: extra.locationId ?? null, text, ...(extra.meta ? { meta: extra.meta } : {}) } as never, [who.memberId], CLOCK);
  const whisper = (t: Table, from: Seat, to: Seat, day: number, text: string) =>
    insertEntry(server!.orm, gameIdOf(t), { kind: 'whisper', at: { day, phase: 'NOCTHERION', turn: 1 }, locationId: null, text, fromMemberId: from.memberId, toMemberId: to.memberId }, [from.memberId, to.memberId], CLOCK);
  const seedChat = (t: Table, who: Seat, day: number, text: string, reply: string) =>
    db()
      .prepare("insert into npc_chat (game_id, member_id, npc_id, day, phase, whisper, text, reply, affinity, created_at) values (?, ?, 'merchant', ?, 'NOCTHERION', 0, ?, ?, 0, 0)")
      .run(gameIdOf(t), who.memberId, day, text, reply);
  async function admin(): Promise<string> {
    const t = await (await fetch(`${server!.url}/api/admin/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: ADMIN_CODE }) })).json();
    return (t as { token: string }).token;
  }
  async function http(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${server!.url}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined, text };
  }
  const saveSettings = async (token: string, value: unknown) => http('PUT', '/api/admin/game-data/Player_Memory', token, { value });
  async function merchantRef(t: Table, who: Seat): Promise<string> {
    const seen = SurroundingsResponse.parse((await t.call('GET', '/api/game/surroundings', { token: who.token })).body);
    const refs = seen.view === 'player' ? seen.npcs.map((n) => n.ref) : [];
    const ref = refs.find((r) => (db().prepare('select npc_id from npc_ref where ref = ?').get(r) as { npc_id: string }).npc_id === merchant.id);
    expect(ref, 'the merchant is at the market').toBeTypeOf('string');
    return ref!;
  }
  const thaiText = (n: number) => 'ก่อนหน้านั้นเขาเดินผ่านป่าที่มืดมิดและเงียบงัน '.repeat(Math.ceil(n / 40)).slice(0, n);

  it('ISK-098 C1: day 2 of A (action, narration, NPC chat, whispers with B, NPC line) all go into A\'s summary; A keeps ≤ 6 topics ≤ 10,000 code points', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    await endDay(t, 2, {
      texts: ['ตามรอยเท้าในตรอกมืด', 'นับดาว', 'จุดไฟ'],
      before: () => {
        seedChat(t, t.a, 2, 'ผ้าไหมราคาเท่าไร', 'ผืนละสามเหรียญ ไม่ต่อนะ');
        whisper(t, t.a, t.b, 2, 'เจอกันที่ท่าเรือ');
        whisper(t, t.b, t.a, 2, 'ได้ ตอนเที่ยงคืน');
        at4(t, t.a, 2, 'พ่อค้าตะโกนเรียกลูกค้าเสียงดัง', 'npc', { meta: { npc: { id: 'merchant', kind: 'dialogue' } } });
      },
    });
    await settled(t.a, refA, 2);
    const ctx = journalOf(journalReqs(refA, 2).at(-1)!);
    const today = ctx.days.find((d) => d.day === 2)!;
    expect(today.actions.join('\n')).toContain('ตามรอยเท้าในตรอกมืด');
    expect(today.seen.join('\n')).toContain('ตามรอยเท้าในตรอกมืด'); // A's own narration (the Mock tells the action)
    expect(today.seen.join('\n')).toContain('พ่อค้าตะโกนเรียกลูกค้าเสียงดัง');
    expect(today.npcChats).toEqual([{ npc: '{{n:merchant}}', said: 'ผ้าไหมราคาเท่าไร', reply: 'ผืนละสามเหรียญ ไม่ต่อนะ' }]);
    expect(today.whispers.map((w) => w.text)).toEqual(['เจอกันที่ท่าเรือ', 'ได้ ตอนเที่ยงคืน']);
    expect(today.whispers[0]).toMatchObject({ from: `{{p:${refA}}}`, to: `{{p:${refOf(t.b)}}}` });
    const topics = topicsOf(t.a.memberId);
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.length).toBeLessThanOrEqual(6);
    expect(charsOf(topics)).toBeLessThanOrEqual(10_000);
  });

  it('ISK-098 C2: B\'s Secret action and private clue are in neither A\'s summary input nor A\'s topics', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const [refA, refB] = [refOf(t.a), refOf(t.b)];
    await endDay(t, 1, {
      texts: ['เดินเล่นในโรงเตี๊ยม', 'แอบซ่อนกุญแจลับใต้พื้นไม้', 'จุดไฟ'],
      visibility: ['public', 'secret', 'public'],
      before: () => at4(t, t.b, 1, 'พบร่องรอยลับเครื่องหมายนกฮูกที่หลังตู้', 'narration', { meta: { clue: true } }),
    });
    await settled(t.a, refA, 1);
    await settled(t.b, refB, 1);
    expect(journalOf(journalReqs(refA, 1).at(-1)!).days.at(-1)!.actions).toEqual(['เดินเล่นในโรงเตี๊ยม']);
    const inputA = JSON.stringify(journalReqs(refA).map((r) => r.messages));
    expect(inputA).not.toContain('แอบซ่อนกุญแจลับใต้พื้นไม้');
    expect(inputA).not.toContain('นกฮูก');
    // B's own input has both, so the test would see a leak.
    expect(JSON.stringify(journalReqs(refB).map((r) => r.messages))).toContain('นกฮูก');
    expect(JSON.stringify(topicsOf(t.a.memberId))).not.toMatch(/แอบซ่อนกุญแจ|นกฮูก/);
  });

  it('ISK-098 C3: the AI answers 8 topics: 6 are kept, the oldest by lastDay folded into เรื่องอื่นๆ', async () => {
    const titles = ['ตลาด', 'โบสถ์', 'ป่า', 'ท่าเรือ', 'คุก', 'บ่อน้ำ', 'หอคอย', 'สุสาน'];
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    seedTopic(t, t.a, { topicId: 'old-1', title: 'เรื่องเก่า', summary: 'เคยพบขอทานที่ประตูเมือง', firstDay: 1, lastDay: 1 });
    provider.use(forA(refA, 4, { journal: 'วันวุ่นวาย', topics: titles.map((title) => ({ topicId: 'new', title, summary: `เรื่องที่${title}ของวันนี้` })) }));
    await endDay(t, 4);
    await settled(t.a, refA, 4);
    const topics = topicsOf(t.a.memberId);
    expect(topics).toHaveLength(6);
    const other = topics.find((x) => x.title === OTHER)!;
    // 9 topics → 6: the one from day 1 first, then the three the AI listed last (same lastDay, same firstDay).
    expect(other.summary).toContain('เคยพบขอทานที่ประตูเมือง');
    for (const title of titles.slice(5)) expect(other.summary).toContain(`เรื่องที่${title}ของวันนี้`);
    expect(other).toMatchObject({ firstDay: 1, lastDay: 4 });
    expect(topics.filter((x) => x.title !== OTHER).map((x) => x.title).sort()).toEqual(titles.slice(0, 5).sort());
  });

  it('ISK-098 C4: the AI answers 12,000 code points: the oldest topic is cut first until ≤ 10,000, never a split tone mark', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    seedTopic(t, t.a, { topicId: 'first', title: 'หนึ่ง', summary: 'สั้น', firstDay: 1, lastDay: 1 });
    seedTopic(t, t.a, { topicId: 'second', title: 'สอง', summary: 'สั้น', firstDay: 2, lastDay: 2 });
    const long = (k: string) => `${k} ${thaiText(2_995)}`;
    const answer = [
      { topicId: 'first', title: 'หนึ่ง', summary: long('หนึ่ง') },
      { topicId: 'second', title: 'สอง', summary: long('สอง') },
      { topicId: 'new', title: 'สาม', summary: long('สาม') },
      { topicId: 'new', title: 'สี่', summary: long('สี่') },
    ];
    expect(charsOf(answer)).toBeGreaterThanOrEqual(12_000);
    provider.use(forA(refA, 4, { journal: 'วันยาว', topics: answer }));
    await endDay(t, 4);
    await settled(t.a, refA, 4);
    const topics = topicsOf(t.a.memberId);
    expect(charsOf(topics)).toBeLessThanOrEqual(10_000);
    const byTitle = new Map(topics.map((x) => [x.title, x.summary]));
    // The oldest (firstDay 1, all lastDay 4 now) is the one cut; the others are whole.
    for (const k of ['สอง', 'สาม', 'สี่']) expect(byTitle.get(k)).toBe(long(k));
    const cut = byTitle.get('หนึ่ง')!;
    expect(cps(cut)).toBeLessThan(cps(long('หนึ่ง')));
    // Whole graphemes of the old text: no tone mark or vowel left without its consonant.
    const kept = graphemes(cut.replace(/…$/u, ''));
    expect(graphemes(long('หนึ่ง')).slice(0, kept.length)).toEqual(kept);
  });

  it('ISK-098 C5: the AI answers only the one topic that changed: the others stay as they were', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    const before = [
      { topicId: 'a1', title: 'ตลาด', summary: 'ซื้อผ้าไหมจาก {{n:merchant}}', firstDay: 1, lastDay: 1 },
      { topicId: 'a2', title: 'โบสถ์', summary: 'สวดมนต์ตอนเช้า', firstDay: 1, lastDay: 2 },
      { topicId: 'a3', title: 'ป่า', summary: 'หลงทางในป่า', firstDay: 2, lastDay: 3 },
    ];
    for (const x of before) seedTopic(t, t.a, x);
    provider.use(forA(refA, 4, { journal: 'วันในโบสถ์', topics: [{ topicId: 'a2', title: 'โบสถ์', summary: 'สวดมนต์ตอนเช้าและพบนักบวชลึกลับ' }] }));
    await endDay(t, 4);
    await settled(t.a, refA, 4);
    const after = new Map(topicsOf(t.a.memberId).map((x) => [x.topicId, x]));
    expect(after.size).toBe(3);
    expect(after.get('a1')).toEqual(before[0]);
    expect(after.get('a3')).toEqual(before[2]);
    expect(after.get('a2')).toEqual({ topicId: 'a2', title: 'โบสถ์', summary: 'สวดมนต์ตอนเช้าและพบนักบวชลึกลับ', firstDay: 1, lastDay: 4 });
  });

  it('ISK-098 C6: admin sets maxChars 5,000 / maxTopics 4: the next day\'s topics fit; 1,000 or 13 topics is 400 and nothing is saved', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    const token = await admin();
    expect((await saveSettings(token, { maxChars: 5_000, maxTopics: 4, promptTokens: 2_500 })).status).toBe(200);
    for (const bad of [{ maxChars: 1_000, maxTopics: 4, promptTokens: 2_500 }, { maxChars: 5_000, maxTopics: 13, promptTokens: 2_500 }]) {
      const res = await saveSettings(token, bad);
      expect(res.status).toBe(400);
    }
    expect((await http('GET', '/api/admin/game-data/Player_Memory', token)).body).toMatchObject({ value: { maxChars: 5_000, maxTopics: 4, promptTokens: 2_500 } });
    provider.use(forA(refA, 3, { journal: 'วันยาว', topics: [1, 2, 3, 4, 5, 6].map((n) => ({ topicId: 'new', title: `เรื่อง ${n}`, summary: thaiText(1_500) })) }));
    await endDay(t, 3);
    await settled(t.a, refA, 3);
    const topics = topicsOf(t.a.memberId);
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.length).toBeLessThanOrEqual(4);
    expect(charsOf(topics)).toBeLessThanOrEqual(5_000);
    const req = journalReqs(refA, 3).at(-1)!;
    expect(journalOf(req).limits).toEqual({ maxTopics: 4, maxChars: 5_000 });
  });

  it('ISK-098 C7: narrate_player of A gets A\'s topics newest first within promptTokens, never another player\'s', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    for (const [i, lastDay] of [1, 4, 2, 3].entries()) seedTopic(t, t.a, { topicId: `a${i}`, title: `วัน ${lastDay}`, summary: thaiText(1_000), firstDay: 1, lastDay });
    seedTopic(t, t.b, { topicId: 'b1', title: 'ของบี', summary: 'ความลับของดารินMEMORYB', firstDay: 1, lastDay: 5 });
    provider.use(forA('nobody', 0, null));
    jumpTo(t, { day: 5, phase: 'EOSORIA', turn: 1 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น'][i]!, 'public');
    await until(() => narrationFor(refA) !== undefined);
    const topics = narrationFor(refA)!.journal!.topics;
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.length).toBeLessThan(4);
    expect(topics.map((x) => x.lastDay)).toEqual([4, 3, 2].slice(0, topics.length));
    expect(estimateTokens(JSON.stringify(topics))).toBeLessThanOrEqual(2_500);
    const all = JSON.stringify(
      provider.requests
        .filter((r) => r.purpose === 'narrate_player' || r.purpose === 'narrate_place')
        .map((r) => contextOf<NarrationContext>(r))
        .filter((c) => !('player' in c.audience) || c.audience.player !== refOf(t.b)),
    );
    expect(all).not.toContain('MEMORYB');
  });

  it('ISK-098 C8: A\'s NPC chat with X gets the topic that names {{n:X}} first, within promptTokens / 2', async () => {
    await boot();
    const t = await startedTable(server!, false);
    moveCharacter(server!.orm, t.a.memberId, MARKET, CLOCK);
    seedTopic(t, t.a, { topicId: 'm1', title: 'พ่อค้า', summary: 'ต่อราคาผ้าไหมกับ {{n:merchant}} ไม่สำเร็จ', firstDay: 1, lastDay: 1 });
    seedTopic(t, t.a, { topicId: 'm2', title: 'ป่า', summary: thaiText(200), firstDay: 2, lastDay: 2 });
    seedTopic(t, t.a, { topicId: 'm3', title: 'ท่าเรือ', summary: thaiText(200), firstDay: 3, lastDay: 3 });
    seedTopic(t, t.a, { topicId: 'm4', title: 'ยาวมาก', summary: thaiText(1_300), firstDay: 4, lastDay: 4 });
    const ref = await merchantRef(t, t.a);
    const res = await t.call('POST', '/api/game/npc-chat', { token: t.a.token, body: { npc: ref, text: 'จำข้าได้ไหม' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ctx = contextOf<NpcChatContext>(provider.requests.find((r) => r.purpose === 'npc_chat')!);
    expect(ctx.memory[0]!.summary).toContain('{{n:merchant}}');
    expect(ctx.memory.map((x) => x.title)).toEqual(['พ่อค้า', 'ท่าเรือ', 'ป่า']);
    expect(estimateTokens(JSON.stringify(ctx.memory))).toBeLessThanOrEqual(1_250);
  });

  it('ISK-098 review: public chat with another listener at the place gets no memory; a whisper or being alone still gets A\'s topics', async () => {
    await boot();
    const t = await startedTable(server!, false);
    moveCharacter(server!.orm, t.a.memberId, MARKET, CLOCK);
    seedTopic(t, t.a, { topicId: 'm1', title: 'กระซิบ', summary: 'บีกระซิบเรื่องลับกับ {{n:merchant}}', firstDay: 1, lastDay: 1 });
    const ref = await merchantRef(t, t.a);
    const chat = async (whisper: boolean) => {
      const n = provider.requests.filter((r) => r.purpose === 'npc_chat').length;
      const res = await t.call('POST', '/api/game/npc-chat', { token: t.a.token, body: { npc: ref, text: 'จำข้าได้ไหม', ...(whisper ? { whisper: true } : {}) } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return contextOf<NpcChatContext>(provider.requests.filter((r) => r.purpose === 'npc_chat')[n]!).memory;
    };
    expect((await chat(false)).length, 'alone').toBe(1);
    moveCharacter(server!.orm, t.b.memberId, MARKET, CLOCK);
    expect(await chat(false), 'B is here').toEqual([]);
    expect((await chat(true)).length, 'whisper').toBe(1);
  });

  it('ISK-098 C9: a failed summary on day 3 keeps the topics and day 4 sums up days 3 + 4; 3 failed days in a row keep only the last 2', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    seedTopic(t, t.a, { topicId: 'keep', title: 'เดิม', summary: 'เรื่องเดิมของวันก่อน', firstDay: 1, lastDay: 2 });
    const failing = new Set([3]);
    provider.use((req) => {
      if (req.purpose !== 'summarize_journal') return undefined;
      const c = journalOf(req);
      if (c.player === refA && failing.has(c.day)) return mockReply.fail('provider_error');
      return mockReply.ok({ journal: `วันที่ ${c.day}`, topics: c.player === refA ? [{ topicId: 'new', title: `วัน ${c.day}`, summary: c.days.map((d) => d.actions.join(' ')).join(' / ') }] : [] });
    });
    await endDay(t, 3, { texts: ['ขุดหลุมที่สวนหลังโบสถ์', 'นับดาว', 'จุดไฟ'] });
    await settled(t.a, refA, 3);
    expect(topicsOf(t.a.memberId)).toEqual([{ topicId: 'keep', title: 'เดิม', summary: 'เรื่องเดิมของวันก่อน', firstDay: 1, lastDay: 2 }]);
    expect(pendingOf(t.a.memberId)).toBe(3);
    await endDay(t, 4, { texts: ['ซ่อนกล่องในหลุม', 'นับดาว', 'จุดไฟ'] });
    await settled(t.a, refA, 4);
    const day4 = journalOf(journalReqs(refA, 4).at(-1)!);
    expect(day4.days.map((d) => d.day)).toEqual([3, 4]);
    expect(JSON.stringify(day4.days)).toContain('ขุดหลุมที่สวนหลังโบสถ์');
    expect(JSON.stringify(day4.days)).toContain('ซ่อนกล่องในหลุม');
    expect(pendingOf(t.a.memberId)).toBeNull();
    expect(topicsOf(t.a.memberId).map((x) => x.topicId)).toContain('keep');

    // Days 5, 6, 7 fail: only the last 2 wait for day 8.
    for (const d of [5, 6, 7]) failing.add(d);
    await endDay(t, 5, { texts: ['ห้าวันแรก', 'นับดาว', 'จุดไฟ'] });
    await settled(t.a, refA, 5);
    await endDay(t, 6, { texts: ['หกวันสอง', 'นับดาว', 'จุดไฟ'] });
    await settled(t.a, refA, 6);
    await endDay(t, 7, { texts: ['เจ็ดวันสาม', 'นับดาว', 'จุดไฟ'] });
    await settled(t.a, refA, 7);
    expect(pendingOf(t.a.memberId)).toBe(6);
    await endDay(t, 8, { texts: ['แปดวันสี่', 'นับดาว', 'จุดไฟ'] });
    await settled(t.a, refA, 8);
    const day8 = journalOf(journalReqs(refA, 8).at(-1)!);
    expect(day8.days.map((d) => d.day)).toEqual([6, 7, 8]);
    expect(JSON.stringify(day8.days)).not.toContain('ห้าวันแรก');
  });

  it('ISK-098 review: a late retry of a failed day keeps the next day waiting when that day\'s topics failed too', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    let failDay3 = true;
    provider.use((req) => {
      if (req.purpose !== 'summarize_journal') return undefined;
      const c = journalOf(req);
      if (c.player === refA && c.day === 3 && failDay3) return mockReply.fail('provider_error');
      if (c.player === refA && c.day === 4) return mockReply.ok({ journal: 'วันสี่', topics: 'ผิดรูป' });
      return mockReply.ok({ journal: `วันที่ ${c.day}`, topics: [] });
    });
    await endDay(t, 3);
    await settled(t.a, refA, 3);
    await endDay(t, 4, { texts: ['ฝังสมบัติใต้ต้นไทร', 'นับดาว', 'จุดไฟ'] });
    await settled(t.a, refA, 4);
    expect(pendingOf(t.a.memberId)).toBe(3);
    failDay3 = false;
    jumpTo(t, { day: 5, phase: 'EOSORIA', turn: 1 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น'][i]!, 'public');
    await until(() => journalRow(t.a.memberId, 3) !== undefined);
    expect(pendingOf(t.a.memberId)).toBe(4);
    for (const c of clients) {
      await c.close();
      sockets.splice(sockets.indexOf(c), 1);
    }
    await endDay(t, 5);
    await settled(t.a, refA, 5);
    const day5 = journalOf(journalReqs(refA, 5).at(-1)!);
    expect(day5.days.map((d) => d.day)).toEqual([4, 5]);
    expect(JSON.stringify(day5.days)).toContain('ฝังสมบัติใต้ต้นไทร');
  });

  it('ISK-098 C10: the AI calls of a day are as before: one summarize_journal per player, no new purpose', async () => {
    await boot();
    const t = await startedTable(server!, false);
    await endDay(t, 1);
    await until(() => (db().prepare("select count(*) as n from gm_journal where kind = 'day' and day = 1").get() as { n: number }).n === 3);
    const usage = db().prepare('select purpose, day, count(*) as n from ai_usage group by purpose, day').all() as { purpose: string; day: number; n: number }[];
    expect(usage.filter((u) => u.purpose === 'summarize_journal')).toEqual([{ purpose: 'summarize_journal', day: 1, n: 3 }]);
    // Every AiPurpose there was before ISK-098.
    const known = ['gm_adjudicate', 'gm_repair', 'gm_weather', 'narrate_place', 'narrate_player', 'npc_dialogue', 'summarize_day', 'summarize_journal', 'finale', 'character_analyze', 'style_review', 'learning_extract', 'npc_chat'];
    for (const u of usage) expect(known, u.purpose).toContain(u.purpose);
  });

  it('ISK-098 C11: topics hold tokens only, never a real name as letters', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    provider.use(forA(refA, 1, { journal: 'คุยกัน', topics: [{ topicId: 'new', title: `${DARIN.name}กับ${merchant.name}`, summary: `${LIN.name} คุยกับ ${DARIN.name} และ ${merchant.name} ที่ตลาด` }] }));
    await endDay(t, 1);
    await settled(t.a, refA, 1);
    const topics = topicsOf(t.a.memberId);
    expect(topics).toHaveLength(1);
    const text = JSON.stringify(topics);
    for (const name of [LIN.name, DARIN.name, merchant.name]) expect(text).not.toContain(name);
    expect(topics[0]!.summary).toBe(`{{p:${refA}}} คุยกับ {{p:${refOf(t.b)}}} และ {{n:merchant}} ที่ตลาด`);
  });

  /** A game played to day 2 under the old journal (a saga row for A), then the DB set back before this migration. */
  async function oldGameWithSaga(saga: string) {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    await endDay(t, 1);
    await until(() => (db().prepare("select count(*) as n from gm_journal where kind = 'day' and day = 1").get() as { n: number }).n === 3);
    db().prepare("insert or replace into gm_journal (game_id, member_id, kind, day, text, created_at) values (?, ?, 'saga', 1, ?, 0)").run(gameIdOf(t), t.a.memberId, saga);
    await server!.close();
    server = undefined;
    const sqlite = new Database(`${dir}/isekai.sqlite`);
    sqlite.exec('drop table player_memory');
    sqlite.exec('alter table member drop column memory_pending_from_day');
    const last = sqlite.prepare('delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)').run();
    expect(last.changes).toBe(1);
    sqlite.close();
    await boot();
    return { t, refA };
  }

  it('ISK-098 C12: the migration turns an old game\'s journal saga into the topic เรื่องที่ผ่านมา and the game plays on', async () => {
    const saga = '{{p:x}} มาถึงเมืองและพักที่โรงเตี๊ยม ได้ยินข่าวลือเรื่องอุกกาบาต';
    const { t, refA } = await oldGameWithSaga(saga);
    expect(topicsOf(t.a.memberId)).toEqual([{ topicId: expect.any(String), title: 'เรื่องที่ผ่านมา', summary: saga, firstDay: 1, lastDay: 1 }]);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น'][i]!, 'public');
    for (const c of clients) await c.waitFor((m) => m.type === 'room' && m.day === 2 && m.phase === 'EOSORIA' && m.turn === 2 && m.status === 'collecting');
    expect(narrationFor(refA, 2)!.journal!.topics.map((x) => x.title)).toEqual(['เรื่องที่ผ่านมา']);
  });

  it('ISK-098 C13: no player endpoint or field returns topics; admin GET memory does; no admin session is 401', async () => {
    await boot();
    const t = await startedTable(server!, false);
    seedTopic(t, t.a, { topicId: 'c1', title: 'ลับ', summary: 'MEMORYCANARY อยู่ในความจำ', firstDay: 1, lastDay: 1 });
    const items = CONTRACT.filter((i): i is HttpItem => i.kind === 'http' && i.status === 'ready');
    for (const item of items) if (/\/memory$/.test(item.path)) expect(item.path.startsWith('/api/admin/'), item.path).toBe(true);
    for (const item of items.filter((i) => i.method === 'GET' && !i.path.includes(':') && !i.path.startsWith('/api/admin'))) {
      const res = await t.call('GET', item.path, { token: t.a.token });
      expect(JSON.stringify(res.body ?? null), item.path).not.toContain('MEMORYCANARY');
    }
    const client = await enter(t.a);
    expect(client.raw.join('\n')).not.toContain('MEMORYCANARY');
    const path = `/api/admin/games/${gameIdOf(t)}/memory`;
    const ok = await http('GET', path, await admin());
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('MEMORYCANARY');
    expect((await http('GET', path)).status).toBe(401);
    expect((await http('GET', path, t.a.token)).status).toBe(401);
  });

  it('ISK-098 C14: with the Mock AI the day journal, the game saga and NPC memory work as before', async () => {
    await boot();
    const t = await startedTable(server!, false);
    await endDay(t, 1);
    await until(() => (db().prepare("select count(*) as n from gm_journal where kind = 'day' and day = 1").get() as { n: number }).n === 3);
    await until(() => (db().prepare("select count(*) as n from gm_memory where kind = 'saga' and day = 1").get() as { n: number }).n === 1);
    // The journal saga is not written any more (its rows stay readable); the topics carry the story.
    expect((db().prepare("select count(*) as n from gm_journal where kind = 'saga'").get() as { n: number }).n).toBe(0);
    expect(topicsOf(t.a.memberId).length).toBeGreaterThan(0);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) await send(c, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น'][i]!, 'public');
    for (const c of clients) await c.waitFor((m) => m.type === 'room' && m.day === 2 && m.turn === 2 && m.status === 'collecting');
    expect(narrationFor(refOf(t.a), 2)!.journal!.yesterday).toBe(journalRow(t.a.memberId, 1)!.text);
  });

  it('ISK-098 C15: a whisper between B and C, B\'s NPC chat, a feed where A is not, karma and DC never reach A\'s summary or topics', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    moveCharacter(server!.orm, t.a.memberId, MARKET, CLOCK);
    moveCharacter(server!.orm, t.b.memberId, MARKET, CLOCK);
    const ref = await merchantRef(t, t.b);
    provider.use((req) => (req.purpose === 'npc_chat' ? mockReply.ok({ reply: 'ราคาพิเศษเฉพาะดารินNPCCHATB', suggestion: null, mood: 'same' }) : undefined));
    expect((await t.call('POST', '/api/game/npc-chat', { token: t.b.token, body: { npc: ref, text: 'ขอราคาพิเศษCHATBTEXT' } })).status).toBe(200);
    provider.use(() => undefined);
    await endDay(t, 1, {
      before: () => {
        whisper(t, t.b, t.c, 1, 'แผนลับของบีกับซีWHISPERBC');
        whisper(t, t.a, t.b, 1, 'ของเอเองWHISPERAB');
        at4(t, t.c, 1, 'เสียงหมาป่าหอนในป่าFEEDFOREST', 'feed', { locationId: 'forest' });
      },
    });
    await settled(t.a, refA, 1);
    const input = JSON.stringify(journalReqs(refA).map((r) => journalOf(r)));
    // A's own whisper is there, so the test would see the others' if they leaked.
    expect(input).toContain('WHISPERAB');
    for (const leak of ['WHISPERBC', 'NPCCHATB', 'CHATBTEXT', 'FEEDFOREST']) expect(input, leak).not.toContain(leak);
    expect(input).not.toMatch(/"(karma|karmaBand|dc|total|hp)"/i);
    expect(JSON.stringify(topicsOf(t.a.memberId))).not.toMatch(/WHISPERBC|NPCCHATB|CHATBTEXT|FEEDFOREST/);
  });

  it('ISK-098 C16: place narration and place NPC lines get no topics; NPC lines to A alone get A\'s', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const [refA, refB] = [refOf(t.a), refOf(t.b)];
    moveCharacter(server!.orm, t.a.memberId, MARKET, CLOCK);
    moveCharacter(server!.orm, t.b.memberId, MARKET, CLOCK);
    seedTopic(t, t.a, { topicId: 'x1', title: 'ของเอ', summary: 'TOPICOFA', firstDay: 1, lastDay: 1 });
    seedTopic(t, t.b, { topicId: 'y1', title: 'ของบี', summary: 'TOPICOFB', firstDay: 1, lastDay: 1 });
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await send(clients[0]!, 'กระซิบถามพ่อค้าเรื่องสินค้าเถื่อน', 'secret');
    await send(clients[1]!, 'ต่อราคาผ้าไหมกับพ่อค้า', 'public');
    await send(clients[2]!, 'ยืดเส้น', 'public');
    await until(() => provider.requests.some((r) => r.output.name === 'gm_dialogue' && 'player' in contextOf<DialogueContext>(r).audience));
    await until(() => provider.requests.some((r) => r.output.name === 'gm_dialogue' && 'place' in contextOf<DialogueContext>(r).audience));
    const places = provider.requests.filter((r) => r.purpose === 'narrate_place' || (r.output.name === 'gm_dialogue' && 'place' in contextOf<DialogueContext>(r).audience));
    expect(places.length).toBeGreaterThan(1);
    for (const r of places) expect(JSON.stringify(r.messages)).not.toMatch(/TOPICOFA|TOPICOFB/);
    const own = provider.requests.find((r) => r.output.name === 'gm_dialogue' && 'player' in contextOf<DialogueContext>(r).audience)!;
    const ctx = contextOf<DialogueContext>(own);
    expect(ctx.audience).toEqual({ player: refA });
    expect(ctx.memory!.map((x) => x.summary)).toEqual(['TOPICOFA']);
    expect(JSON.stringify(own.messages)).not.toContain('TOPICOFB');
    void refB;
  });

  it('ISK-098 C17: a topicId of B in A\'s answer becomes a new topic of A; B\'s topics do not change', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    seedTopic(t, t.b, { topicId: 'b-topic', title: 'ของบี', summary: 'เรื่องของบี', firstDay: 1, lastDay: 1 });
    const before = topicsOf(t.b.memberId);
    provider.use(forA(refA, 2, { journal: 'วันหนึ่ง', topics: [{ topicId: 'b-topic', title: 'ยึดของบี', summary: 'เอาไปเขียนทับ' }] }));
    await endDay(t, 2);
    await settled(t.a, refA, 2);
    expect(topicsOf(t.b.memberId)).toEqual(before);
    const mine = topicsOf(t.a.memberId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'ยึดของบี', summary: 'เอาไปเขียนทับ', firstDay: 2, lastDay: 2 });
    expect(mine[0]!.topicId).not.toBe('b-topic');
  });

  it('ISK-098 C18: journal right but topics malformed → journal kept, topics as before, pending = that day; topics right but journal wrong → topics kept', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    const before = { topicId: 'k1', title: 'เดิม', summary: 'ก่อนหน้านี้', firstDay: 1, lastDay: 1 };
    seedTopic(t, t.a, before);
    provider.use(forA(refA, 2, { journal: 'บันทึกที่ถูกต้อง', topics: 'ผิดรูป' }));
    await endDay(t, 2);
    await settled(t.a, refA, 2);
    expect(journalRow(t.a.memberId, 2)?.text).toBe('บันทึกที่ถูกต้อง');
    expect(topicsOf(t.a.memberId)).toEqual([before]);
    expect(pendingOf(t.a.memberId)).toBe(2);

    provider.use(forA(refA, 3, { journal: 42, topics: [{ topicId: 'k1', title: 'เดิม', summary: 'ก่อนหน้านี้และวันนี้' }] }));
    await endDay(t, 3);
    await settled(t.a, refA, 3);
    expect(journalRow(t.a.memberId, 3)).toBeUndefined();
    expect(topicsOf(t.a.memberId)).toEqual([{ ...before, summary: 'ก่อนหน้านี้และวันนี้', lastDay: 3 }]);
    expect(pendingOf(t.a.memberId)).toBeNull();
  });

  it('ISK-098 C19: a 60 code point title keeps ≤ 40; a summary cut below 20 removes the topic; an existing เรื่องอื่นๆ takes the next one with firstDay / lastDay right', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    seedTopic(t, t.a, { topicId: 's1', title: 'เล็ก', summary: 'ก'.repeat(25), firstDay: 1, lastDay: 1 });
    const title = 'ข'.repeat(60);
    provider.use(forA(refA, 2, { journal: 'วันหนึ่ง', topics: [{ topicId: 'new', title, summary: 'ค'.repeat(10_000 - 40 - 4 - 25 + 10) }] }));
    await endDay(t, 2);
    await settled(t.a, refA, 2);
    const first = topicsOf(t.a.memberId);
    expect(first).toHaveLength(1);
    expect(cps(first[0]!.title)).toBeLessThanOrEqual(40);
    expect(charsOf(first)).toBeLessThanOrEqual(10_000);
    expect(first.some((x) => x.topicId === 's1')).toBe(false);

    db().prepare('delete from player_memory where member_id = ?').run(t.a.memberId);
    seedTopic(t, t.a, { topicId: 'o', title: OTHER, summary: 'เรื่องเล็กน้อยเดิม', firstDay: 2, lastDay: 2 });
    seedTopic(t, t.a, { topicId: 'old', title: 'เก่าสุด', summary: 'เรื่องเก่าที่สุด', firstDay: 1, lastDay: 3 });
    for (const d of [4, 4, 4, 4]) seedTopic(t, t.a, { topicId: `n${Math.random()}`, title: `ใหม่ ${d}`, summary: 'เรื่องใหม่', firstDay: d, lastDay: d });
    provider.use(forA(refA, 5, { journal: 'วันห้า', topics: [{ topicId: 'new', title: 'ล่าสุด', summary: 'เรื่องวันห้า' }] }));
    await endDay(t, 5);
    await settled(t.a, refA, 5);
    const second = topicsOf(t.a.memberId);
    expect(second).toHaveLength(6);
    const other = second.find((x) => x.topicId === 'o')!;
    expect(other.title).toBe(OTHER);
    expect(other.summary.startsWith('เรื่องเล็กน้อยเดิม')).toBe(true);
    expect(other.summary).toContain('เรื่องเก่าที่สุด');
    expect(other).toMatchObject({ firstDay: 1, lastDay: 3 });
  });

  it('ISK-098 C20: an NPC\'s real name is stored as {{n:id}}; a name that cannot become a token rejects that topic and keeps its old version', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const refA = refOf(t.a);
    const before = { topicId: 'z1', title: 'เพื่อน', summary: 'รู้จักกันที่โรงเตี๊ยม', firstDay: 1, lastDay: 1 };
    seedTopic(t, t.a, before);
    // C removed by the owner: their character's real name has no token any more.
    const kicked = await http('POST', `/api/admin/games/${gameIdOf(t)}/members/${t.c.memberId}/kick`, await admin());
    expect(kicked.status, kicked.text).toBe(200);
    provider.use(
      forA(refA, 2, {
        journal: 'วันสอง',
        topics: [
          { topicId: 'new', title: 'ตลาด', summary: `ต่อราคากับ ${merchant.name} ที่ตลาด` },
          { topicId: 'z1', title: 'เพื่อน', summary: `คุยกับ ${MEKHA.name} ที่ท่าเรือ` },
        ],
      }),
    );
    await endDay(t, 2, { seats: [t.a, t.b] });
    await settled(t.a, refA, 2);
    const topics = topicsOf(t.a.memberId);
    expect(topics.find((x) => x.title === 'ตลาด')?.summary).toBe('ต่อราคากับ {{n:merchant}} ที่ตลาด');
    expect(topics.find((x) => x.topicId === 'z1')).toEqual(before);
  });

  it('ISK-098 C21: 2,000 / 30,000, 1 / 12, 500 / 8,000 save; promptTokens 499 or 8,001, a non-integer or a missing field is 400', async () => {
    await boot();
    const token = await admin();
    for (const value of [
      { maxChars: 2_000, maxTopics: 1, promptTokens: 500 },
      { maxChars: 30_000, maxTopics: 12, promptTokens: 8_000 },
    ]) {
      const res = await saveSettings(token, value);
      expect(res.status, res.text).toBe(200);
      expect((await http('GET', '/api/admin/game-data/Player_Memory', token)).body).toMatchObject({ value });
    }
    for (const value of [
      { maxChars: 30_000, maxTopics: 12, promptTokens: 499 },
      { maxChars: 30_000, maxTopics: 12, promptTokens: 8_001 },
      { maxChars: 2_500.5, maxTopics: 12, promptTokens: 2_500 },
      { maxChars: 30_000, maxTopics: 12 },
    ]) {
      const res = await saveSettings(token, value);
      expect(res.status, JSON.stringify(value)).toBe(400);
    }
    expect((await http('GET', '/api/admin/game-data/Player_Memory', token)).body).toMatchObject({ value: { maxChars: 30_000, maxTopics: 12, promptTokens: 8_000 } });
  });

  it('ISK-098 C22: the migration of a 12,000 code point saga gives เรื่องที่ผ่านมา within maxChars, firstDay 1, lastDay the last day summarised', async () => {
    const { t } = await oldGameWithSaga(thaiText(12_000));
    const topics = topicsOf(t.a.memberId);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ title: 'เรื่องที่ผ่านมา', firstDay: 1, lastDay: 1 });
    expect(charsOf(topics)).toBeLessThanOrEqual(10_000);
  });

  it('ISK-098 C23: GET memory matches AdminPlayerMemory, charCount counts title + summary, names has every token used', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const [refA, refB] = [refOf(t.a), refOf(t.b)];
    seedTopic(t, t.a, { topicId: 'g1', title: 'ตลาด', summary: `{{p:${refB}}} ต่อราคากับ {{n:merchant}}`, firstDay: 1, lastDay: 2 });
    seedTopic(t, t.a, { topicId: 'g2', title: 'โบสถ์', summary: 'สวดมนต์', firstDay: 1, lastDay: 1 });
    const res = await http('GET', `/api/admin/games/${gameIdOf(t)}/memory`, await admin());
    expect(res.status).toBe(200);
    const body = AdminPlayerMemory.parse(res.body);
    expect(body).toMatchObject({ maxChars: 10_000, maxTopics: 6 });
    const a = body.players.find((p) => p.memberId === t.a.memberId)!;
    expect(a.name).toBe(LIN.name);
    expect(a.topics.map((x) => x.topicId)).toEqual(['g1', 'g2']);
    expect(a.charCount).toBe(charsOf(a.topics));
    expect(body.players.find((p) => p.memberId === t.b.memberId)).toMatchObject({ charCount: 0, topics: [] });
    expect(body.names).toMatchObject({ [`{{p:${refB}}}`]: DARIN.name, '{{n:merchant}}': merchant.name });
    void refA;
  });
});
