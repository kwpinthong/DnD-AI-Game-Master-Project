import { defaultScenario } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { createAiService } from '../src/ai/core/service.ts';
import { createUsageStore } from '../src/ai/core/usage.ts';
import { createMockProvider, mockReply, type MockProvider } from '../src/ai/providers/mock.ts';
import { openDatabase, type OpenedDatabase } from '../src/db/client.ts';
import { game } from '../src/db/schema.ts';
import { copyTemplateForGame, getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import { buildEventContext } from '../src/timeline/context.ts';
import {
  advanceTimeline,
  applyEventOutcomes,
  getEventOutcomes,
  getTimeline,
  setEventOutcome,
} from '../src/timeline/store.ts';
import { startPhaseEvents } from '../src/timeline/trigger.ts';
import { makeTempDir } from './helpers.ts';

const GAME = 'game-a';
const MOCK_AI = loadAiConfig({ AI_PROVIDER: 'mock' });

describe('timeline events: pending → active → resolved + outcome (GEN-053)', () => {
  let opened: OpenedDatabase;
  let cleanup = () => {};

  beforeEach(() => {
    const temp = makeTempDir();
    cleanup = temp.cleanup;
    opened = openDatabase(join(temp.dir, 'isekai.sqlite'));
    opened.db.insert(game).values({ id: GAME, inviteCode: 'CODEA', createdAt: 1 }).run();
    copyTemplateForGame(opened.db, GAME);
  });

  afterEach(() => {
    opened.sqlite.close();
    cleanup();
  });

  const statusOf = (eventId: string) => getTimeline(opened.db, GAME)!.events.find((e) => e.id === eventId)!;
  const activeIds = () => getTimeline(opened.db, GAME)!.events.filter((e) => e.status === 'active').map((e) => e.id);

  function aiWith(mock: MockProvider) {
    return createAiService({ provider: mock, config: MOCK_AI, usage: createUsageStore(opened.db), log: () => {} });
  }

  it('before day 1 Morning every event is pending and the game has no point yet', () => {
    const timeline = getTimeline(opened.db, GAME)!;
    expect(timeline.at).toBeNull();
    expect(timeline.events.every((e) => e.status === 'pending')).toBe(true);
    expect(timeline.events.map((e) => e.id)).toEqual(defaultScenario().timeline.map((e) => e.id));
  });

  it('C1: entering day 1 Morning makes the day 1 event active and puts it in the context sent to the AI', async () => {
    const mock = createMockProvider(MOCK_AI);
    const result = await startPhaseEvents({ db: opened.db, ai: aiWith(mock) }, GAME, { day: 1, phase: 'EOSORIA' });

    expect(result.timeline).toMatchObject({ ok: true, activated: ['d1-bread'] });
    expect(activeIds()).toEqual(['d1-bread']);
    expect(statusOf('d2-first-companion').status).toBe('pending');

    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0]!;
    expect(request.purpose).toBe('gm_adjudicate');
    const prompt = request.system.map((b) => b.text).join('\n');
    const scenario = defaultScenario();
    const bread = scenario.timeline.find((e) => e.id === 'd1-bread')!;
    expect(prompt).toContain('d1-bread');
    expect(prompt).toContain(bread.title);
    // Leak rules: no future event, no real NPC name (Q-045) — NPCs go in as tokens.
    for (const future of scenario.timeline.filter((e) => e.id !== 'd1-bread')) {
      expect(prompt).not.toContain(future.id);
      expect(prompt).not.toContain(future.title);
    }
    for (const npc of scenario.npcs) expect(prompt).not.toContain(npc.name);
    expect(prompt).toContain('{{n:cult-acolyte}}');
    expect(result.ai.ok).toBe(true);
  });

  it('C1: a real NPC name the GM typed into the event text reaches the AI only as a token', () => {
    const scenario = getGameScenario(opened.db, GAME)!;
    const npc = scenario.npcs.find((n) => n.id === 'cult-acolyte')!;
    scenario.timeline[0]!.description = `${npc.name} ยิ้มขณะยื่นขนมปัง`;
    expect(updateGameScenario(opened.db, GAME, scenario).ok).toBe(true);
    advanceTimeline(opened.db, GAME, { day: 1, phase: 'EOSORIA' });

    const text = JSON.stringify(buildEventContext(opened.db, GAME, 1, 'EOSORIA'));
    expect(text).not.toContain(npc.name);
    expect(text).toContain('{{n:cult-acolyte}} ยิ้มขณะยื่นขนมปัง');
  });

  it('C2: day 4 has no event, so nothing is active in any of its phases', () => {
    for (const phase of ['EOSORIA', 'SOLARION', 'HESPERION'] as const) {
      expect(advanceTimeline(opened.db, GAME, { day: 4, phase })).toMatchObject({ ok: true, activated: [] });
      expect(activeIds()).toEqual([]);
      expect(buildEventContext(opened.db, GAME, 4, phase).active).toEqual([]);
    }
    // Everything before day 4 is over; everything after is still to come.
    expect(statusOf('d3-cult-clue').status).toBe('resolved');
    expect(statusOf('d5-disaster').status).toBe('pending');
  });

  it('C3: the AI may set the outcome of the day 7 event while it is active', () => {
    advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION' });
    expect(setEventOutcome(opened.db, GAME, 'd7-kidnapping', 'prevented')).toEqual({ ok: true });
    expect(statusOf('d7-kidnapping')).toMatchObject({ status: 'active', outcome: 'prevented', outcomeSource: 'ai' });

    advanceTimeline(opened.db, GAME, { day: 8, phase: 'EOSORIA' });
    expect(statusOf('d7-kidnapping')).toMatchObject({ status: 'resolved', outcome: 'prevented', outcomeSource: 'ai' });
  });

  it('C3: an event that is not active yet (or already over) refuses an outcome and stores nothing', () => {
    advanceTimeline(opened.db, GAME, { day: 5, phase: 'EOSORIA' });
    expect(setEventOutcome(opened.db, GAME, 'd7-kidnapping', 'prevented')).toMatchObject({ ok: false, code: 'not_active' });
    expect(statusOf('d7-kidnapping')).toMatchObject({ status: 'pending', outcome: null, outcomeSource: null });

    expect(setEventOutcome(opened.db, GAME, 'd1-bread', 'prevented')).toMatchObject({ ok: false, code: 'already_resolved' });
    expect(statusOf('d1-bread').outcomeSource).toBe('default');
    expect(setEventOutcome(opened.db, GAME, 'no-such-event', 'prevented')).toMatchObject({ ok: false, code: 'not_found' });
    expect(setEventOutcome(opened.db, GAME, 'd5-disaster', '   ')).toMatchObject({ ok: false, code: 'invalid_outcome' });
  });

  it('C3 / Q-049: a batch of outcome requests is all-or-nothing', () => {
    advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION' });
    const result = applyEventOutcomes(opened.db, GAME, [
      { eventId: 'd7-kidnapping', outcome: 'prevented' },
      { eventId: 'd10-summoning', outcome: 'prevented' },
    ]);
    expect(result).toMatchObject({ ok: false, errors: [{ index: 1, eventId: 'd10-summoning', code: 'not_active' }] });
    expect(statusOf('d7-kidnapping').outcome).toBeNull();

    expect(applyEventOutcomes(opened.db, GAME, [{ eventId: 'd7-kidnapping', outcome: 'prevented' }])).toEqual({ ok: true });
    expect(statusOf('d7-kidnapping').outcome).toBe('prevented');
  });

  it('C3: the AI answer of a phase trigger maps onto the outcome operation', async () => {
    advanceTimeline(opened.db, GAME, { day: 7, phase: 'SOLARION' });
    const mock = createMockProvider(MOCK_AI, {
      steps: [mockReply.ok({ eventOutcomes: [{ eventId: 'd7-kidnapping', outcome: 'prevented' }] })],
    });
    const result = await startPhaseEvents({ db: opened.db, ai: aiWith(mock) }, GAME, { day: 7, phase: 'HESPERION' });
    expect(result.ai.ok).toBe(true);
    if (!result.ai.ok) return;
    expect(applyEventOutcomes(opened.db, GAME, result.ai.value.eventOutcomes)).toEqual({ ok: true });
    expect(statusOf('d7-kidnapping')).toMatchObject({ status: 'active', outcome: 'prevented' });
  });

  it('C4: an event whose phase ends without anyone stepping in resolves with its default outcome', () => {
    const scenario = getGameScenario(opened.db, GAME)!;
    scenario.timeline[0]!.outcome = 'ชาวเมืองครึ่งหนึ่งกินขนมปังและเริ่มเชื่อลัทธิ';
    expect(updateGameScenario(opened.db, GAME, scenario).ok).toBe(true);

    advanceTimeline(opened.db, GAME, { day: 1, phase: 'EOSORIA' });
    expect(statusOf('d1-bread')).toMatchObject({ status: 'active', outcome: null });
    advanceTimeline(opened.db, GAME, { day: 1, phase: 'SOLARION' });
    expect(statusOf('d1-bread')).toMatchObject({
      status: 'resolved',
      outcome: 'ชาวเมืองครึ่งหนึ่งกินขนมปังและเริ่มเชื่อลัทธิ',
      outcomeSource: 'default',
    });
  });

  it('C4: jumping past events resolves them with defaults; the end resolves the finale; outcomes are readable in order', () => {
    advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION' });
    setEventOutcome(opened.db, GAME, 'd7-kidnapping', 'prevented');
    expect(advanceTimeline(opened.db, GAME, 'end')).toMatchObject({ ok: true, activated: [] });

    const timeline = getTimeline(opened.db, GAME)!;
    expect(timeline.ended).toBe(true);
    expect(timeline.events.every((e) => e.status === 'resolved')).toBe(true);
    const outcomes = getEventOutcomes(opened.db, GAME);
    expect(outcomes.map((o) => o.eventId)).toEqual(defaultScenario().timeline.map((e) => e.id));
    expect(outcomes.find((o) => o.eventId === 'd7-kidnapping')).toMatchObject({ outcome: 'prevented', intervened: true });
    expect(outcomes.find((o) => o.eventId === 'd12-meteor')).toMatchObject({ kind: 'finale', outcome: '', intervened: false });
  });

  it('the timeline never moves backwards and repeating the same point changes nothing', () => {
    advanceTimeline(opened.db, GAME, { day: 2, phase: 'SOLARION' });
    expect(advanceTimeline(opened.db, GAME, { day: 2, phase: 'SOLARION' })).toMatchObject({ ok: true, activated: [], resolved: [] });
    expect(advanceTimeline(opened.db, GAME, { day: 1, phase: 'HESPERION' })).toMatchObject({ ok: false, code: 'backwards' });
    expect(activeIds()).toEqual(['d2-first-companion']);
    expect(advanceTimeline(opened.db, 'no-game', { day: 1, phase: 'EOSORIA' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('the context holds the active event and past outcomes, never a pending event', () => {
    advanceTimeline(opened.db, GAME, { day: 3, phase: 'HESPERION' });
    const context = buildEventContext(opened.db, GAME, 3, 'HESPERION');
    expect(context.active.map((e) => e.id)).toEqual(['d3-cult-clue']);
    expect(context.past.map((e) => e.id)).toEqual(['d1-bread', 'd2-first-companion']);
    const text = JSON.stringify(context);
    for (const future of defaultScenario().timeline.filter((e) => e.day > 3)) expect(text).not.toContain(future.title);
    // GM notes stay out of prompts.
    expect(text).not.toContain('gmNote');
  });
});
