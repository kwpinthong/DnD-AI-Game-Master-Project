import { GameTimelineResponse, type RoomServerMessage } from '@isekai/protocol';
import type { Period, Turn } from '@isekai/rules';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { migrationsFolder } from '../src/db/client.ts';
import { RULES_BLOCK, type TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { GM_OUTPUT, GmTurnProposal } from '../src/gm/schema.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { buildEventContext } from '../src/timeline/context.ts';
import { advanceTimeline, getEventOutcomes, getTimeline, setEventOutcome } from '../src/timeline/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

/**
 * GEN-093 Q-243: the side of an event outcome (good / evil / neutral / null) is its own field `side` of the AI
 * GM's `eventOutcomes`, stored beside the text. The old convention (the text begins "Good: ..." ) is gone from
 * the prompt; text stored that way is split into text + side. Players never get the side; the Human GM does.
 */

type EventOutcome = GmTurnProposal['eventOutcomes'][number];
type Handler = (req: AiCallRequest) => AiCallResult | undefined;

const isTurn = (req: AiCallRequest) => req.output.name === GM_OUTPUT.turn;

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
      const scripted = current(req);
      if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
      return mockReply.ok(await cannedGmAnswer(req));
    },
  };
  return provider;
}

/** No dice; the first turn answer carries `first`, a repair answer carries `repaired`. */
const turnWith =
  (first: EventOutcome[], repaired: EventOutcome[] = first): Handler =>
  (req) => {
    if (!isTurn(req)) return undefined;
    const proposal = mockTurnProposal(contextOf<TurnContext>(req));
    for (const a of proposal.actions) a.check = { type: 'none' };
    return mockReply.ok({ ...proposal, eventOutcomes: req.purpose === 'gm_repair' ? repaired : first });
  };

const proposalWith = (eventOutcomes: unknown) => ({ actions: [], constraints: { add: [], release: [] }, eventOutcomes, endingPath: null, remember: [] });

describe('Q-243 schema: eventOutcomes[].side', () => {
  it.each(['good', 'evil', 'neutral', null])('side %s is accepted and kept', (side) => {
    const parsed = GmTurnProposal.parse(proposalWith([{ eventId: 'd5-disaster', outcome: 'อพยพชาวนาได้ทัน', side }]));
    expect(parsed.eventOutcomes).toEqual([{ eventId: 'd5-disaster', outcome: 'อพยพชาวนาได้ทัน', side }]);
  });

  it('a side outside the list, or no side at all, is refused', () => {
    expect(GmTurnProposal.safeParse(proposalWith([{ eventId: 'd5-disaster', outcome: 'อพยพ', side: 'holy' }])).success).toBe(false);
    expect(GmTurnProposal.safeParse(proposalWith([{ eventId: 'd5-disaster', outcome: 'อพยพ' }])).success).toBe(false);
  });

  it('the JSON schema sent to the AI lists side as a required field of good / evil / neutral / null', () => {
    const schema = JSON.stringify(GmTurnProposal.shape.eventOutcomes.toJSONSchema());
    expect(schema).toContain('"required":["eventId","outcome","side"]');
    expect(schema).toContain('"enum":["good","evil","neutral"]');
  });

  it('prompt rule 11 names the side field and no longer asks for a "Good: ..." text prefix', () => {
    const rule11 = RULES_BLOCK.text.split('\n').find((l) => l.startsWith('11.'))!;
    expect(rule11).toContain('eventOutcomes.side');
    expect(rule11).toContain('ห้ามขึ้นต้น outcome ด้วยชื่อฝ่าย');
    expect(RULES_BLOCK.text).not.toMatch(/"(Good|Evil|Neutral): \.\.\."/);
  });
});

describe('Q-243 AI GM loop + store', { timeout: 60_000 }, () => {
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

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const day5 = (t: Table) => getTimeline(server!.orm, gameIdOf(t))!.events.find((e) => e.id === 'd5-disaster')!;
  const at = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';

  function jumpTo(t: Table, to: { day: number; phase: Period; turn: Turn }) {
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), ...to }, CLOCK);
    expect(advanceTimeline(server!.orm, gameId, { day: to.day, phase: to.phase }, CLOCK)).toMatchObject({ ok: true });
  }

  /** Day 5 EOSORIA turn 1 (d5-disaster active), everyone acts; resolves once turn 2 opens. */
  async function playDay5(t: Table, marker = '') {
    jumpTo(t, { day: 5, phase: 'EOSORIA', turn: 1 });
    for (const [i, seat] of [t.a, t.b, t.c].entries()) {
      const client = await openRoom(server!, { token: seat.token });
      sockets.push(client);
      await client.waitFor(isReady);
      const from = client.messages.length;
      client.action([`ช่วยอพยพชาวนา ${marker}`.trim(), 'ขนสมุนไพร', 'เฝ้าประตูเมือง'][i]!, 'public');
      expect(await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
    for (const c of sockets) await c.waitFor(at(5, 'EOSORIA', 2));
  }

  it('the side the AI GM answers is stored beside the outcome text', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(turnWith([{ eventId: 'd5-disaster', outcome: 'กักตุนเสบียงปั่นราคาตลาดมืด', side: 'evil' }]));
    await playDay5(t);
    expect(provider.requests.filter(isTurn).map((r) => r.purpose)).toEqual(['gm_adjudicate']);
    expect(day5(t)).toMatchObject({ status: 'active', outcome: 'กักตุนเสบียงปั่นราคาตลาดมืด', outcomeSource: 'ai', outcomeSide: 'evil' });
  });

  it.each(['good', 'neutral'] as const)('Mock GM dev marker [mock:outcome=%s] sets the active event\'s outcome with that side (for offline checks)', async (side) => {
    await boot();
    const t = await startedTable(server!, false);
    await playDay5(t, `[mock:outcome=${side}]`);
    expect(day5(t)).toMatchObject({ outcomeSource: 'ai', outcomeSide: side });
    expect(day5(t).outcome).not.toMatch(/good|neutral/i);
  });

  it('side null (the outcome fits no side) is stored as no side', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(turnWith([{ eventId: 'd5-disaster', outcome: 'ชาวนาหนีกันเองได้ครึ่งหนึ่ง', side: null }]));
    await playDay5(t);
    expect(day5(t)).toMatchObject({ outcome: 'ชาวนาหนีกันเองได้ครึ่งหนึ่ง', outcomeSource: 'ai', outcomeSide: null });
  });

  it('an outcome text that still begins with a side name is repaired once; the repaired answer is stored', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(
      turnWith(
        [{ eventId: 'd5-disaster', outcome: 'Good: อพยพชาวนาได้ทัน', side: 'good' }],
        [{ eventId: 'd5-disaster', outcome: 'อพยพชาวนาได้ทัน', side: 'good' }],
      ),
    );
    await playDay5(t);
    const turns = provider.requests.filter(isTurn);
    expect(turns.map((r) => r.purpose)).toEqual(['gm_adjudicate', 'gm_repair']);
    expect(turns[1]!.messages.at(-1)!.text).toContain('outcome_side_prefix');
    expect(day5(t)).toMatchObject({ outcome: 'อพยพชาวนาได้ทัน', outcomeSide: 'good' });
  });

  it('a Thai outcome that merely contains a side word later in the text is not refused', async () => {
    await boot();
    const t = await startedTable(server!, false);
    provider.use(turnWith([{ eventId: 'd5-disaster', outcome: 'ชาวนารอดเพราะฝ่าย Good: ผู้เล่นช่วยไว้', side: 'good' }]));
    await playDay5(t);
    expect(provider.requests.filter(isTurn).map((r) => r.purpose)).toEqual(['gm_adjudicate']);
  });

  it('outcome text stored the old way (no side given) is split: "Good: x" → x + good, "Good/Neutral: x" → good, "Evil: x" → evil, "Neutral: x" → neutral, plain → null', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    jumpTo(t, { day: 5, phase: 'EOSORIA', turn: 1 });
    const stored = (text: string) => {
      expect(setEventOutcome(server!.orm, gameId, 'd5-disaster', text, undefined, CLOCK)).toEqual({ ok: true });
      const { outcome, outcomeSide } = day5(t);
      return { outcome, outcomeSide };
    };
    expect(stored('Good: อพยพชาวนาได้ทัน')).toEqual({ outcome: 'อพยพชาวนาได้ทัน', outcomeSide: 'good' });
    expect(stored(' good/Neutral:อพยพชาวนา')).toEqual({ outcome: 'อพยพชาวนา', outcomeSide: 'good' });
    expect(stored('Neutral/Good: ขายสมุนไพรก่อน')).toEqual({ outcome: 'ขายสมุนไพรก่อน', outcomeSide: 'neutral' });
    expect(stored('Evil: กักตุนเสบียง')).toEqual({ outcome: 'กักตุนเสบียง', outcomeSide: 'evil' });
    expect(stored('Neutral: ขายสมุนไพรให้ทั้งสองฝ่าย')).toEqual({ outcome: 'ขายสมุนไพรให้ทั้งสองฝ่าย', outcomeSide: 'neutral' });
    expect(stored('ชาวนาหนีได้ครึ่งหนึ่ง')).toEqual({ outcome: 'ชาวนาหนีได้ครึ่งหนึ่ง', outcomeSide: null });
    // A side given with the text is kept as given, and a later choice replaces the earlier side.
    expect(setEventOutcome(server!.orm, gameId, 'd5-disaster', 'อพยพครบ', 'good', CLOCK)).toEqual({ ok: true });
    expect(setEventOutcome(server!.orm, gameId, 'd5-disaster', 'ไม่เข้าฝ่ายใด', null, CLOCK)).toEqual({ ok: true });
    expect(day5(t)).toMatchObject({ outcome: 'ไม่เข้าฝ่ายใด', outcomeSide: null });
  });

  it('the side stays with the outcome once the event is resolved; an event nobody changed has no side', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    jumpTo(t, { day: 5, phase: 'EOSORIA', turn: 1 });
    setEventOutcome(server!.orm, gameId, 'd5-disaster', 'อพยพชาวนาได้ทัน', 'good', CLOCK);
    jumpTo(t, { day: 6, phase: 'EOSORIA', turn: 1 });
    const outcomes = getEventOutcomes(server!.orm, gameId);
    expect(outcomes.find((o) => o.eventId === 'd5-disaster')).toMatchObject({ outcome: 'อพยพชาวนาได้ทัน', intervened: true, side: 'good' });
    expect(outcomes.find((o) => o.eventId === 'd1-bread')).toMatchObject({ intervened: false, side: null });
    // The AI GM reads the side of past events as a field, not from the text.
    const past = buildEventContext(server!.orm, gameId, 6, 'EOSORIA').past;
    expect(past.find((e) => e.id === 'd5-disaster')).toMatchObject({ outcome: 'อพยพชาวนาได้ทัน', side: 'good' });
    expect(past.find((e) => e.id === 'd1-bread')).toMatchObject({ side: null });
  });

  it('the Human GM sees the side in the timeline and the console; a player gets neither the outcome nor the side', async () => {
    await boot();
    const t = await startedTable(server!, true);
    const gameId = gameIdOf(t);
    expect(advanceTimeline(server!.orm, gameId, { day: 5, phase: 'EOSORIA' }, CLOCK)).toMatchObject({ ok: true });
    setEventOutcome(server!.orm, gameId, 'd5-disaster', 'อพยพชาวนาได้ทัน', 'good', CLOCK);
    const call = caller(server!);

    const gmView = GameTimelineResponse.parse((await call('GET', '/api/game/timeline', { token: t.gm!.token })).body);
    expect(gmView.events.find((e) => e.id === 'd5-disaster')).toMatchObject({ outcome: 'อพยพชาวนาได้ทัน', outcomeSide: 'good' });
    expect(gmView.events.find((e) => e.id === 'd1-bread')).toMatchObject({ outcomeSide: null });
    const consoleView = (await call('GET', '/api/game/gm/console', { token: t.gm!.token })).body as { events: { id: string; outcomeSide: string | null }[] };
    expect(consoleView.events.find((e) => e.id === 'd5-disaster')).toMatchObject({ outcomeSide: 'good' });

    for (const path of ['/api/game/timeline', '/api/game/log']) {
      const res = await call('GET', path, { token: t.a.token });
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).not.toMatch(/outcomeSide|อพยพชาวนาได้ทัน/);
    }
  });
});

interface Journal {
  entries: { idx: number; tag: string }[];
}

describe('Q-243 migration event_outcome_side', () => {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;
  /** Found by name: the dispatcher may renumber it at merge. */
  const index = journal.entries.findIndex((e) => e.tag.endsWith('_event_outcome_side'));
  let dir = '';
  let cleanup = () => {};
  let sqlite: Database.Database | undefined;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
    cleanup();
  });

  it('moves the "Good: " / "Evil: " / "Neutral: " prefix of AI outcomes into outcome_side and leaves every other row alone', () => {
    expect(index).toBeGreaterThan(0);
    const partial = join(dir, 'drizzle-partial');
    mkdirSync(join(partial, 'meta'), { recursive: true });
    const entries = journal.entries.slice(0, index);
    for (const e of entries) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(partial, `${e.tag}.sql`));
    writeFileSync(join(partial, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));

    sqlite = new Database(join(dir, 'isekai.sqlite'));
    migrate(drizzle(sqlite), { migrationsFolder: partial });
    sqlite.prepare('insert into game (id, invite_code, created_at) values (?, ?, ?)').run('g1', 'ABC123', 1);
    const add = sqlite.prepare("insert into game_event_state (game_id, event_id, status, outcome, outcome_source, updated_at) values ('g1', ?, ?, ?, ?, 5)");
    add.run('e-good', 'resolved', 'Good: อพยพชาวนาได้ทัน', 'ai');
    add.run('e-both', 'resolved', 'Good/Neutral: อพยพชาวนา: ครบทุกคน', 'ai');
    add.run('e-evil', 'active', 'evil:กักตุนเสบียง', 'ai');
    add.run('e-neutral', 'resolved', ' Neutral:  ขายให้ทั้งสองฝ่าย', 'ai');
    // Q-281: the side is the one the text starts with: "Good..." → good, "Neutral..." → neutral.
    add.run('e-neutral-first', 'resolved', 'Neutral/Good: ขายสมุนไพรก่อนแล้วค่อยอพยพ', 'ai');
    add.run('e-plain', 'resolved', 'ชาวนาหนีได้ครึ่งหนึ่ง: ที่เหลือติดหมอก', 'ai');
    add.run('e-goodness', 'resolved', 'Goodwill ของชาวเมืองเพิ่มขึ้น', 'ai');
    add.run('e-drift', 'resolved', 'Good: ข้อความของ scenario เอง', 'default');
    add.run('e-pending', 'active', null, null);

    migrate(drizzle(sqlite), { migrationsFolder });

    const rows = sqlite.prepare('select event_id as id, outcome, outcome_side as side, updated_at as updatedAt from game_event_state order by event_id').all();
    expect(rows).toEqual([
      { id: 'e-both', outcome: 'อพยพชาวนา: ครบทุกคน', side: 'good', updatedAt: 5 },
      { id: 'e-drift', outcome: 'Good: ข้อความของ scenario เอง', side: null, updatedAt: 5 },
      { id: 'e-evil', outcome: 'กักตุนเสบียง', side: 'evil', updatedAt: 5 },
      { id: 'e-good', outcome: 'อพยพชาวนาได้ทัน', side: 'good', updatedAt: 5 },
      { id: 'e-goodness', outcome: 'Goodwill ของชาวเมืองเพิ่มขึ้น', side: null, updatedAt: 5 },
      { id: 'e-neutral', outcome: 'ขายให้ทั้งสองฝ่าย', side: 'neutral', updatedAt: 5 },
      { id: 'e-neutral-first', outcome: 'ขายสมุนไพรก่อนแล้วค่อยอพยพ', side: 'neutral', updatedAt: 5 },
      { id: 'e-pending', outcome: null, side: null, updatedAt: 5 },
      { id: 'e-plain', outcome: 'ชาวนาหนีได้ครึ่งหนึ่ง: ที่เหลือติดหมอก', side: null, updatedAt: 5 },
    ]);
  });
});
