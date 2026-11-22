import { describe, expect, it } from 'vitest';
import {
  defaultScenario,
  parseScenario,
  SCENARIO_SCHEMA_VERSION,
  SOCIAL_TITLE_BANDS,
  type ScenarioIssue,
} from '../src/index.ts';

/** A plain JSON copy of the default template, for editing in tests. */
const draft = (): Record<string, any> => JSON.parse(JSON.stringify(defaultScenario()));

const paths = (errors: ScenarioIssue[]) => errors.map((e) => e.path);

function expectInvalid(input: unknown): ScenarioIssue[] {
  const result = parseScenario(input);
  if (result.ok) throw new Error('expected the scenario to be rejected');
  for (const issue of result.errors) expect(issue.message).toMatch(/\S/);
  return result.errors;
}

describe('default scenario template (GDD §5-6)', () => {
  // C1
  it('C1 (GEN-071): has the 5 World_Timeline events on days 1, 5, 7, 10, 12 and day 12 is the finale', () => {
    const { timeline } = defaultScenario();

    expect(timeline.map((e) => e.day)).toEqual([1, 5, 7, 10, 12]);
    for (const event of timeline) expect(['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION']).toContain(event.phase);
    const finale = timeline.filter((e) => e.kind === 'finale');
    expect(finale).toHaveLength(1);
    expect(finale[0]?.day).toBe(12);
    expect(timeline.find((e) => e.day === 10)?.kind).toBe('climax');
  });

  it('GEN-063 C8: a scenario saved with MORNING / AFTERNOON / NIGHT loads as EOSORIA / SOLARION / HESPERION', () => {
    const old = draft();
    old.timeline[0].phase = 'MORNING';
    old.timeline[1].phase = 'AFTERNOON';
    old.timeline[2].phase = 'NIGHT';
    const result = parseScenario(old);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.scenario.timeline.slice(0, 3).map((e) => e.phase)).toEqual(['EOSORIA', 'SOLARION', 'HESPERION']);
    old.timeline[0].phase = 'EVENING';
    expect(expectInvalid(old)).toContainEqual({ path: 'timeline.0.phase', message: expect.stringContaining('NOCTHERION') });
  });

  it('is itself a valid scenario at the current schema version', () => {
    const result = parseScenario(defaultScenario());
    expect(result.ok).toBe(true);
    expect(defaultScenario().schemaVersion).toBe(SCENARIO_SCHEMA_VERSION);
  });

  // C2
  it('C2: origin weights are 70 / 29 / 1 (total 100); the 1% is the Astral Rift (no Pocket Dimension, Q-093)', () => {
    const { origins } = defaultScenario();

    expect(origins.map((o) => [o.kind, o.weight])).toEqual([
      ['standard', 70],
      ['special', 29],
      ['secret', 1],
    ]);
    expect(origins.reduce((sum, o) => sum + o.weight, 0)).toBe(100);

    const standard = origins.find((o) => o.kind === 'standard');
    const special = origins.find((o) => o.kind === 'special');
    // GEN-071: the sheet Start_Scenarios rows of each tier.
    expect(standard?.kind === 'standard' && standard.spawnPoints).toHaveLength(10);
    expect(special?.kind === 'special' && special.spawnPoints).toHaveLength(4);

    const secret = origins.find((o) => o.kind === 'secret');
    expect(secret?.kind === 'secret' && secret.spawnPoints).toEqual([{ id: 'astral-drifter', label: 'ผู้หลงทางเหนือกาลเวลา', locationId: 'astral-rift' }]);
    expect(origins.some((o) => o.kind === 'pocket')).toBe(false);
  });

  it('carries the starting roster by grade, the 7 Social Titles of GEN-042 and a secret Legendary', () => {
    const s = defaultScenario();

    expect(new Set(s.npcs.map((n) => n.rank))).toEqual(new Set(['F', 'B', 'A', 'S']));
    expect(s.socialTitles.map((t) => [t.min, t.max])).toEqual(SOCIAL_TITLE_BANDS.map((b) => [b.min, b.max]));
    expect(s.socialTitles.find((t) => t.min === -10)?.title).toBe('คนแปลกหน้า');
    expect(s.legendaries.length).toBeGreaterThan(0);
    expect(s.legendaries[0]).toMatchObject({ counter: 'streak_days', target: 10, progress: 0, unlocked: false });
  });

  it('hands out independent copies', () => {
    const a = defaultScenario();
    a.timeline[0]!.title = 'แก้แล้ว';
    expect(defaultScenario().timeline[0]?.title).not.toBe('แก้แล้ว');
  });
});

describe('scenario validation', () => {
  // C3
  it('C3: rejects a starting NPC of grade SS (SS only evolves from F)', () => {
    const input = draft();
    input.npcs[1].rank = 'SS';

    const errors = expectInvalid(input);
    expect(paths(errors)).toEqual(['npcs.1.rank']);
    expect(errors[0]?.message).toContain('SS');
  });

  // C4
  it.each([
    ['an event on day 0', (s: Record<string, any>) => (s.timeline[0].day = 0), 'timeline.0.day'],
    ['an event on day 13', (s: Record<string, any>) => (s.timeline[3].day = 13), 'timeline.3.day'],
    ['origin weights totalling 99', (s: Record<string, any>) => (s.origins[0].weight = 69), 'origins'],
    ['origin weights totalling 101', (s: Record<string, any>) => (s.origins[2].weight = 2), 'origins'],
    ['a duplicate NPC id', (s: Record<string, any>) => s.npcs.splice(3, 0, { ...s.npcs[0] }), 'npcs.3.id'],
    ['a duplicate location id', (s: Record<string, any>) => s.locations.splice(2, 0, { ...s.locations[0] }), 'locations.2.id'],
    ['a duplicate event id', (s: Record<string, any>) => (s.timeline[3].id = s.timeline[2].id), 'timeline.3.id'],
    [
      'a duplicate spawn point id across origin tiers',
      (s: Record<string, any>) => (s.origins[1].spawnPoints[0].id = s.origins[0].spawnPoints[0].id),
      'origins.1.spawnPoints.0.id',
    ],
    ['an NPC in an unknown location', (s: Record<string, any>) => (s.npcs[0].locationId = 'nowhere'), 'npcs.0.locationId'],
    ['a finale before day 12', (s: Record<string, any>) => (s.timeline[4].day = 11), 'timeline.4.kind'],
    ['an event range that ends before it starts', (s: Record<string, any>) => (s.timeline[2].endPhase = 'SOLARION'), 'timeline.2.endPhase'],
    ['an event range ending in a period that does not exist', (s: Record<string, any>) => (s.timeline[2].endPhase = 'EVENING'), 'timeline.2.endPhase'],
    ['foreshadowing after its event began', (s: Record<string, any>) => (s.timeline[1].foreshadowAt = { day: 5, phase: 'EOSORIA' }), 'timeline.1.foreshadowAt'],
    ['a Social Title band that moved', (s: Record<string, any>) => (s.socialTitles[3].max = 12), 'socialTitles.3.max'],
    ['a Legendary target of 13 days', (s: Record<string, any>) => (s.legendaries[0].target = 13), 'legendaries.0.target'],
  ])('C4: rejects %s and names the field', (_label, edit, path) => {
    const input = draft();
    edit(input);

    expect(paths(expectInvalid(input))).toEqual([path]);
  });

  it('C4: reports every wrong field at once', () => {
    const input = draft();
    input.timeline[0].day = 0;
    input.origins[0].weight = 10;
    input.npcs.splice(3, 0, { ...input.npcs[0] });

    expect(paths(expectInvalid(input)).sort()).toEqual(['npcs.3.id', 'origins', 'timeline.0.day']);
  });

  it('rejects something that is not a scenario at all', () => {
    expect(paths(expectInvalid(null))).toEqual(['']);
    expect(expectInvalid({}).length).toBeGreaterThan(0);
  });
});

describe('older template versions', () => {
  it('Q-161: rest quality uses the sheet values; a saved rough / basic / inn is upgraded, and RESTRICTED is a safety', () => {
    const old = draft();
    old.locations = old.locations.map((l: Record<string, unknown>, i: number) => ({ ...l, restQuality: ['rough', 'basic', 'inn'][i % 3] }));
    const result = parseScenario(old);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.scenario.locations.map((l) => l.restQuality)).toEqual(old.locations.map((_: unknown, i: number) => ['poor', 'normal', 'good'][i % 3]));

    const sheet = draft();
    sheet.locations[0].restQuality = 'excellent';
    sheet.locations[0].safety = 'restricted';
    const ok = parseScenario(sheet);
    if (!ok.ok) throw new Error(JSON.stringify(ok.errors));
    expect(ok.scenario.locations[0]).toMatchObject({ restQuality: 'excellent', safety: 'restricted' });

    sheet.locations[0].restQuality = 'luxury';
    expect(parseScenario(sheet)).toMatchObject({ ok: false, errors: [{ path: 'locations.0.restQuality' }] });
  });

  // C6
  it('C6: loads a template saved before the newer fields existed and fills their defaults', () => {
    const old = draft();
    delete old.schemaVersion;
    delete old.town.taboos;
    delete old.legendaries;
    for (const location of old.locations) {
      delete location.safety;
      delete location.gmNote;
    }
    for (const npc of old.npcs) delete npc.obsTrait;
    for (const event of old.timeline) {
      delete event.crisis;
      delete event.npcIds;
      delete event.locationIds;
      for (const key of ['endPhase', 'interventionEffects', 'foreshadowing', 'foreshadowAt', 'strategyIds']) delete event[key];
    }
    for (const npc of old.npcs) delete npc.otherNames;

    const result = parseScenario(old);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    expect(result.scenario.schemaVersion).toBe(SCENARIO_SCHEMA_VERSION);
    expect(result.scenario.town.taboos).toEqual([]);
    expect(result.scenario.legendaries).toEqual([]);
    expect(result.scenario.locations.every((l) => l.safety === 'normal' && l.gmNote === '')).toBe(true);
    expect(result.scenario.npcs.every((n) => n.obsTrait === 0)).toBe(true);
    expect(result.scenario.timeline.every((e) => !e.crisis && e.npcIds.length === 0 && e.locationIds === null)).toBe(
      true,
    );
    expect(
      result.scenario.timeline.every(
        (e) => e.endPhase === null && e.interventionEffects === '' && e.foreshadowAt === null && e.strategyIds.length === 0,
      ),
    ).toBe(true);
    expect(result.scenario.npcs.every((n) => n.otherNames.length === 0)).toBe(true);
    // fields the old template did have are kept as they were
    expect(result.scenario.timeline.map((e) => e.day)).toEqual([1, 5, 7, 10, 12]);
  });

  it('GEN-096 C3: an event without startTurn / endTurn runs turn 1 to turn 2, as before', () => {
    const old = draft();
    for (const event of old.timeline) {
      delete event.startTurn;
      delete event.endTurn;
    }
    const result = parseScenario(old);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.scenario.timeline.every((e) => e.startTurn === 1 && e.endTurn === 2)).toBe(true);
  });

  it('GEN-096: startTurn 2 / endTurn 1 are kept', () => {
    const s = draft();
    s.timeline[2].startTurn = 2;
    s.timeline[4].endTurn = 1;
    const result = parseScenario(s);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.scenario.timeline[2]).toMatchObject({ startTurn: 2, endTurn: 2 });
    expect(result.scenario.timeline[4]).toMatchObject({ startTurn: 1, endTurn: 1 });
  });

  it('GEN-096 C4: turn 0 or 3 is refused and the error names the field', () => {
    const s = draft();
    s.timeline[2].startTurn = 0;
    s.timeline[3].endTurn = 3;
    s.timeline[1].startTurn = 1.5;
    const errors = expectInvalid(s);
    expect(paths(errors).sort()).toEqual(['timeline.1.startTurn', 'timeline.2.startTurn', 'timeline.3.endTurn']);
    expect(errors.find((e) => e.path === 'timeline.2.startTurn')!.message).toContain('1 หรือ 2');
  });

  it('GEN-096 C4: a one-period event cannot end on turn 1 when it starts on turn 2', () => {
    const s = draft();
    s.timeline[2].startTurn = 2;
    s.timeline[2].endTurn = 1;
    expect(paths(expectInvalid(s))).toEqual(['timeline.2.endTurn']);
    // Over two periods it is fine: HESPERION turn 2 to NOCTHERION turn 1.
    const twoPeriods = draft();
    twoPeriods.timeline[4].startTurn = 2;
    twoPeriods.timeline[4].endTurn = 1;
    expect(parseScenario(twoPeriods).ok).toBe(true);
  });

  it('GEN-097 C2: a saved event with one locationId loads as a list of that one place; null stays the whole town', () => {
    const old = draft();
    for (const event of old.timeline) delete event.locationIds;
    old.timeline[0].locationId = 'fountain';
    old.timeline[1].locationId = null;
    old.timeline[2].locationId = 'temple';
    const result = parseScenario(old);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.scenario.timeline.slice(0, 3).map((e) => e.locationIds)).toEqual([['fountain'], null, ['temple']]);
    expect(result.scenario.timeline.every((e) => !('locationId' in e))).toBe(true);
  });

  it('GEN-097 C2: an unknown place in an old single locationId is still refused', () => {
    const old = draft();
    delete old.timeline[2].locationIds;
    old.timeline[2].locationId = 'atlantis';
    expect(expectInvalid(old).map((e) => e.path)).toEqual(['timeline.2.locationIds.0']);
  });

  it('GEN-097: an event keeps several places', () => {
    const s = draft();
    s.timeline[2].locationIds = ['temple', 'fountain'];
    const result = parseScenario(s);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.scenario.timeline[2]!.locationIds).toEqual(['temple', 'fountain']);
  });

  it('GEN-097 C5: an unknown place, a repeated place or an empty list is refused and names the field', () => {
    const s = draft();
    s.timeline[2].locationIds = ['temple', 'atlantis'];
    s.timeline[3].locationIds = [];
    s.timeline[0].locationIds = ['fountain', 'fountain'];
    const errors = expectInvalid(s);
    expect(paths(errors).sort()).toEqual(['timeline.0.locationIds.1', 'timeline.2.locationIds.1', 'timeline.3.locationIds']);
    expect(errors.find((e) => e.path === 'timeline.2.locationIds.1')!.message).toContain('atlantis');
  });

  it('GEN-097 C6: the sheet events of day 10 have two places', () => {
    const day10 = defaultScenario().timeline.find((e) => e.day === 10)!;
    expect(day10.locationIds).toEqual(['temple', 'fountain']);
  });

  it('rejects a template from a newer schema version than this server knows', () => {
    const future = draft();
    future.schemaVersion = SCENARIO_SCHEMA_VERSION + 1;
    expect(paths(expectInvalid(future))).toEqual(['schemaVersion']);
  });
});
