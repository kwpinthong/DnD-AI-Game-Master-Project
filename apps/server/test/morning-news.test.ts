import type { RoomEntry, RoomServerMessage } from '@isekai/protocol';
import type { Period, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { estimateTokens, type DayContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockDaySummary } from '../src/gm/mock-gm.ts';
import { clipNews, NEWS_CODE_POINTS, QUIET_NEWS } from '../src/gm/news.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startTestServer, startedTable, type Table } from './visibility-fixture.ts';

/**
 * ISK-014: the morning news. The day summary (no extra call) also answers `news`; the room publishes it as one `news`
 * entry for everyone at the start of the next day's first turn, before the period's scene. Day 1 and a summary
 * without usable news get the server's template. No real AI: the Mock answers, a test overrides the summary.
 */

type SummaryAnswer = (req: AiCallRequest) => unknown;

/** The Mock GM, with the day summary's answer replaced (`summary`) or failing (`'fail'`). */
function provider(summary?: SummaryAnswer | 'fail') {
  const requests: AiCallRequest[] = [];
  const p: AiProvider & { requests: AiCallRequest[] } = {
    id: 'mock',
    requests,
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      requests.push(req);
      if (req.purpose === 'summarize_day' && summary === 'fail') return mockReply.fail('timeout');
      const answer = req.purpose === 'summarize_day' && typeof summary === 'function' ? summary(req) : await cannedGmAnswer(req);
      return { ...mockReply.ok(answer), model: req.model };
    },
  };
  return p;
}

const SECRET_OUTCOME = 'ผลลับวันที่เจ็ด ลัทธิยึดหอระฆังได้สำเร็จ';
const SECRET_EFFECT = 'ทางแก้ลับ ช่วยแม่ชีขโมยกุญแจห้องใต้ดิน';
const SECRET_NOTE = 'บันทึกจีเอ็ม ห้ามบอกผู้เล่น';
const FESTIVAL = 'งานเทศกาลโคมไฟลอยฟ้า';
const FESTIVAL_PUBLIC = 'ชาวเมืองแขวนโคมไฟทั่วลานน้ำพุ';
const BELL = 'ระฆังหอคอยดังผิดเวลา';

describe('ISK-014 morning news', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let ai: ReturnType<typeof provider> | undefined;
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

  async function boot(summary?: SummaryAnswer | 'fail') {
    ai = provider(summary);
    server = await startTestServer(dataDir, { aiProvider: ai, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }) });
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function sendAll(clients: RoomClient[], texts: string[]) {
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(texts[i]!, 'public');
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
  }

  const at = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';
  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const newsRows = (day: number) =>
    server!.db.prepare("select id, text, phase, turn from room_entry where kind = 'news' and day = ? order by id").all(day) as { id: number; text: string; phase: string; turn: number }[];
  const recipientsOf = (entryId: number) => (server!.db.prepare('select member_id as id from room_entry_recipient where entry_id = ?').all(entryId) as { id: string }[]).map((r) => r.id).sort();
  const newsOf = (c: RoomClient, day: number) => c.entries().filter((e: RoomEntry) => e.kind === 'news' && e.day === day);
  const items = (text: string) => text.split('\n');
  const summaryRequests = () => ai!.requests.filter((r) => r.purpose === 'summarize_day');

  /** Adds events to the game's own scenario copy (day, title, public description, and the hidden parts). */
  function addEvents(t: Table, events: { id: string; day: number; title: string; description?: string; npcIds?: string[] }[]) {
    const gameId = gameIdOf(t);
    const scenario = getGameScenario(server!.orm, gameId)!;
    const added = events.map((e) => ({
      id: e.id,
      day: e.day,
      phase: 'EOSORIA' as const,
      title: e.title,
      description: e.description ?? '',
      outcome: SECRET_OUTCOME,
      interventionEffects: SECRET_EFFECT,
      gmNote: SECRET_NOTE,
      npcIds: e.npcIds ?? [],
      locationIds: null,
    }));
    const result = updateGameScenario(server!.orm, gameId, { ...scenario, timeline: [...scenario.timeline, ...added] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  }

  /** Plays the last turn of `day` with everyone; resolves once day + 1 is open for them. */
  async function endDay(day: number, opts: { t?: Table } = {}): Promise<{ t: Table; clients: RoomClient[] }> {
    const t = opts.t ?? (await startedTable(server!, false));
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day, phase: 'NOCTHERION', turn: 2 }, CLOCK);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await sendAll(clients, ['เฝ้ายามทั้งคืน', 'นับดาว', 'จุดไฟ']);
    for (const c of clients) await c.waitFor(at(day + 1, 'EOSORIA', 1));
    return { t, clients };
  }

  async function waitNews(c: RoomClient, day: number): Promise<RoomEntry> {
    await c.waitFor((m) => m.type === 'entry' && m.entry.kind === 'news' && m.entry.day === day);
    return newsOf(c, day)[0]!;
  }

  it('C1: day 3 with an event starting: one news entry of 1-3 items to everyone, under day 3 EOSORIA turn 1, before the scene', async () => {
    await boot();
    const t = await startedTable(server!, false);
    addEvents(t, [{ id: 'd3-festival', day: 3, title: FESTIVAL, description: FESTIVAL_PUBLIC }]);
    const { clients } = await endDay(2, { t });
    const news = await Promise.all(clients.map((c) => waitNews(c, 3)));
    for (const n of news) {
      expect(n).toMatchObject({ kind: 'news', day: 3, phase: 'EOSORIA', turn: 1, place: null });
      expect(items(n.text).length).toBeGreaterThanOrEqual(1);
      expect(items(n.text).length).toBeLessThanOrEqual(3);
      expect(n.text).toContain(FESTIVAL);
    }
    const rows = newsRows(3);
    expect(rows).toHaveLength(1);
    expect(recipientsOf(rows[0]!.id)).toEqual([t.a.memberId, t.b.memberId, t.c.memberId].sort());
    // Before the period's scene: the scene's feed entries of day 3 morning come after the news.
    await expect.poll(() => server!.db.prepare("select count(*) as n from room_entry where kind = 'feed' and day = 3").get(), { timeout: 5_000 }).not.toEqual({ n: 0 });
    const firstScene = server!.db.prepare("select min(id) as id from room_entry where kind = 'feed' and day = 3 and phase = 'EOSORIA' and turn = 1").get() as { id: number };
    expect(rows[0]!.id).toBeLessThan(firstScene.id);
  });

  it('C2: no event starts: one item (a rumour / the town mood)', async () => {
    await boot();
    const { clients } = await endDay(3);
    const n = await waitNews(clients[0]!, 4);
    expect(items(n.text)).toHaveLength(1);
    expect(n.text.length).toBeGreaterThan(0);
  });

  it('C3: the summary context carries the events by name + public description only; no outcome / intervention / GM note anywhere', async () => {
    await boot();
    const t = await startedTable(server!, false);
    addEvents(t, [{ id: 'd3-festival', day: 3, title: FESTIVAL, description: FESTIVAL_PUBLIC }]);
    const { clients } = await endDay(2, { t });
    const n = await waitNews(clients[0]!, 3);
    const req = summaryRequests().find((r) => contextOf<DayContext>(r).day === 2)!;
    const sent = JSON.stringify(req.messages) + req.system.map((b) => b.text).join('\n');
    expect(sent).toContain(FESTIVAL);
    expect(sent).toContain(FESTIVAL_PUBLIC);
    for (const hidden of [SECRET_OUTCOME, SECRET_EFFECT, SECRET_NOTE]) {
      expect(sent).not.toContain(hidden);
      expect(n.text).not.toContain(hidden);
    }
  });

  it('C4: the summary call fails: the news is the template from the starting event names', async () => {
    await boot('fail');
    const t = await startedTable(server!, false);
    addEvents(t, [{ id: 'd3-festival', day: 3, title: FESTIVAL }, { id: 'd3-bell', day: 3, title: BELL }]);
    const { clients } = await endDay(2, { t });
    const n = await waitNews(clients[0]!, 3);
    expect(items(n.text)).toHaveLength(2);
    expect(items(n.text)[0]).toContain(FESTIVAL);
    expect(items(n.text)[1]).toContain(BELL);
  });

  it('C4: the summary call fails and no event starts: "เช้าวันใหม่ในเมืองยังเงียบสงบ"', async () => {
    await boot('fail');
    const { clients } = await endDay(3);
    const n = await waitNews(clients[0]!, 4);
    expect(n.text).toBe(QUIET_NEWS);
  });

  it('C5: day 1 opens with the template news (the day-1 event by name), and no AI call for it', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const c = await enter(t.a);
    const n = await waitNews(c, 1);
    expect(n).toMatchObject({ kind: 'news', day: 1, phase: 'EOSORIA', turn: 1 });
    expect(n.text).toContain('พิธีแจกขนมปังแห่งความเมตตา');
    expect(newsRows(1)).toHaveLength(1);
    expect(recipientsOf(newsRows(1)[0]!.id)).toEqual([t.a.memberId, t.b.memberId, t.c.memberId].sort());
    expect(summaryRequests()).toEqual([]);
    expect(server!.db.prepare("select count(*) as n from ai_usage where purpose = 'summarize_day'").get()).toEqual({ n: 0 });
    // C7: the game log (history) has it too, with no vote fields.
    const log = await t.call('GET', '/api/game/log', { token: t.b.token });
    const logged = (log.body as { entries: RoomEntry[] }).entries.filter((e) => e.kind === 'news');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.text).toBe(n.text);
    expect(logged[0]!.myVote).toBeUndefined();
    expect(n.myVote).toBeUndefined();
  });

  it('C6: an item of 200 code points is cut to 160 ending in …', async () => {
    const long = 'ข่าว'.repeat(50);
    expect([...long]).toHaveLength(200);
    const cut = clipNews(long);
    expect([...cut]).toHaveLength(NEWS_CODE_POINTS);
    expect(cut.endsWith('…')).toBe(true);
    expect(clipNews('สั้น')).toBe('สั้น');
    // Through the summary too.
    await boot((req) => ({ ...(cannedSummary(req) as object), news: [long] }));
    const { clients } = await endDay(3);
    const n = await waitNews(clients[0]!, 4);
    expect([...n.text]).toHaveLength(NEWS_CODE_POINTS);
    expect(n.text.endsWith('…')).toBe(true);
  });

  it('C8: the day change makes the same AI calls: one summarize_day per finished day, nothing new for the news', async () => {
    await boot();
    const { clients } = await endDay(2);
    await waitNews(clients[0]!, 3);
    // Day 1 and day 2 are summarised (the game jumped to day 2), once each.
    expect(summaryRequests().map((r) => contextOf<DayContext>(r).day).sort()).toEqual([1, 2]);
    expect(server!.db.prepare("select count(*) as n from ai_usage where purpose = 'summarize_day'").get()).toEqual({ n: 2 });
    const known = new Set(['period_weather', 'gm_turn_proposal', 'gm_narration', 'gm_dialogue', 'gm_day_summary', 'gm_journal', 'gm_scene', 'gm_weather']);
    expect(ai!.requests.map((r) => r.output.name).filter((name) => !known.has(name))).toEqual([]);
  });

  for (const [label, news] of [
    ['[]', []],
    ['no field', undefined],
    ['the wrong type', 'ข่าวเดียวไม่ใช่รายการ'],
  ] as const) {
    it(`C9: news ${label} → the template; the recap and saga are still kept`, async () => {
      await boot((req) => {
        const { news: _drop, ...rest } = cannedSummary(req) as { news?: unknown };
        return news === undefined ? rest : { ...rest, news };
      });
      const t = await startedTable(server!, false);
      addEvents(t, [{ id: 'd4-festival', day: 4, title: FESTIVAL }]);
      const { clients } = await endDay(3, { t });
      const n = await waitNews(clients[0]!, 4);
      expect(n.text).toContain(FESTIVAL);
      expect(server!.db.prepare("select day from gm_memory where kind = 'day' order by day").all()).toEqual([{ day: 1 }, { day: 2 }, { day: 3 }]);
    });
  }

  it('C9: 5 items → the first 3', async () => {
    await boot((req) => ({ ...(cannedSummary(req) as object), news: ['ข่าวหนึ่ง', 'ข่าวสอง', 'ข่าวสาม', 'ข่าวสี่', 'ข่าวห้า'] }));
    const { clients } = await endDay(3);
    const n = await waitNews(clients[0]!, 4);
    expect(items(n.text)).toEqual(['ข่าวหนึ่ง', 'ข่าวสอง', 'ข่าวสาม']);
  });

  it('C10: a restart after the summary, before the news went out: the news is published once, from the stored summary', async () => {
    await boot((req) => ({ ...(cannedSummary(req) as object), news: ['ข่าวจากสรุปวัน'] }));
    const { t, clients } = await endDay(3);
    await waitNews(clients[0]!, 4);
    const gameId = gameIdOf(t);
    // The publish never happened: the stored news stays, the entry is gone.
    server!.db.prepare("delete from room_entry where kind = 'news' and day = 4 and game_id = ?").run(gameId);
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();

    await boot();
    const c = await enter(t.a);
    const n = await waitNews(c, 4);
    expect(n.text).toBe('ข่าวจากสรุปวัน');
    expect(newsRows(4)).toHaveLength(1);
    // Another restart and join: still once.
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    await boot();
    await enter(t.b);
    await new Promise((r) => setTimeout(r, 300));
    expect(newsRows(4)).toHaveLength(1);
    expect(newsRows(1)).toHaveLength(1);
  });

  it('C11: a player offline that morning sees the news when they come back', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 3, phase: 'NOCTHERION', turn: 2 }, CLOCK);
    // C sends the night's action, then goes offline before the morning.
    const away = await enter(t.c);
    await sendAll([away], ['หลับยาว']);
    await away.close();
    sockets.splice(sockets.indexOf(away), 1);
    const clients = [await enter(t.a), await enter(t.b)];
    await sendAll(clients, ['เฝ้ายามทั้งคืน', 'นับดาว']);
    for (const c of clients) await c.waitFor(at(4, 'EOSORIA', 1));
    await waitNews(clients[0]!, 4);
    expect(newsOf(away, 4)).toEqual([]);
    const late = await enter(t.c);
    expect(newsOf(late, 4)).toHaveLength(1);
    expect(newsOf(late, 4)[0]!.text).toBe(newsOf(clients[0]!, 4)[0]!.text);
  });

  it('C12: no real name of a player or an NPC (other names too): the alias everyone reads', async () => {
    await boot((req) => ({ ...(cannedSummary(req) as object), news: ['ลินถูกเห็นคุยกับซิสเตอร์เอเลน่าที่โบสถ์', 'การ์เร็ตสั่งปิดประตูเมือง', 'คนเห็น {{n:merchant}} ขนของออกจากตลาด'] }));
    const t = await startedTable(server!, false);
    const { clients } = await endDay(3, { t });
    const n = await waitNews(clients[1]!, 4);
    for (const real of ['ลิน', 'ซิสเตอร์เอเลน่า', 'การ์เร็ต', 'มาร์คัส', '{{']) expect(n.text).not.toContain(real);
    expect(n.text).toContain('แม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่า');
    expect(n.text).toContain('พ่อค้าเร่ผู้สวมแว่นหนา');
    // The sources are events only (name + public description), never a player's or a place's private thing.
    const ctx = contextOf<DayContext & { news: { starting: object[]; yesterday: object[] } }>(summaryRequests().at(-1)!);
    for (const e of [...ctx.news.starting, ...ctx.news.yesterday]) expect(Object.keys(e).sort()).toEqual(['description', 'title']);
    // The summary rules forbid outcomes, private clues and Secret actions in the news.
    const rules = summaryRequests().at(-1)!.system.map((b) => b.text).join('\n');
    expect(rules).toMatch(/news/);
    expect(rules).toMatch(/Secret/);
  });

  it('C13: the recap / saga / journals are as before, and the summary may write at most 300 more output tokens', async () => {
    await boot();
    const { clients } = await endDay(3);
    await waitNews(clients[0]!, 4);
    const req = summaryRequests().find((r) => contextOf<DayContext>(r).day === 3)!;
    expect(req.maxOutputTokens).toBeGreaterThan(1_500);
    expect(req.maxOutputTokens! - 1_500).toBeLessThanOrEqual(300);
    const ctx = contextOf<DayContext>(req);
    const recap = server!.db.prepare("select text from gm_memory where kind = 'day' and day = 3").get() as { text: string };
    expect(recap.text).toBe(`วันที่ 3: ${ctx.log.join(' / ')}`.slice(0, 1800));
    expect(server!.db.prepare("select count(*) as n from gm_memory where kind = 'saga'").get()).toEqual({ n: 3 });
    await expect.poll(() => server!.db.prepare("select count(*) as n from gm_journal where kind = 'day' and day = 3").get(), { timeout: 5_000 }).toEqual({ n: 3 });
    // The most news can add (3 items of 160 code points, the JSON around them) stays within those 300 tokens on a real
    // tokenizer that is about 2 Thai characters a token; the server's own estimate (1 per Thai character) is the ceiling.
    const most = JSON.stringify({ news: [0, 1, 2].map(() => 'ก'.repeat(NEWS_CODE_POINTS)) });
    expect(Math.ceil(estimateTokens(most) / 2)).toBeLessThanOrEqual(300);
  });

  it('C14: day 12 has its news as usual', async () => {
    await boot();
    const { clients } = await endDay(11);
    const n = await waitNews(clients[0]!, 12);
    expect(n.text).toContain('วันพิพากษา');
    expect(newsRows(12)).toHaveLength(1);
  });
});

/** The Mock's own day summary (recap + saga + its news). */
const cannedSummary = (req: AiCallRequest): unknown => mockDaySummary(contextOf<DayContext>(req));
