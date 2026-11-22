import { ReplayRng, matchingSources, type PhaseAction, type ResolutionProposal, type TagClaim, type TagContext, type TagSource } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGameAssets } from '../src/assets/load.ts';
import {
  WEATHER_VERB_BOOST,
  abilitySource,
  itemSource,
  locationSources,
  parseWeatherVerbBoost,
  startPassiveSource,
  tagVocabulary,
} from '../src/assets/tags.ts';
import { applyPhaseActions } from '../src/crossplayer/phase.ts';
import { tagContexts, usesOnDay, type TaggingOptions } from '../src/crossplayer/tags.ts';
import { crossPlayerState } from '../src/crossplayer/phase.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/** GEN-064 on the server: tag sources from the real asset JSON (GEN-062) and Daily_Limit per game day. */

const assets = loadGameAssets();
const ability = (name: string) => assets.ability(name) ?? expect.fail(`no Ability ${name}`);
const item = (name: string) => assets.item(name) ?? expect.fail(`no Item ${name}`);
const ctx = (sources: TagSource[], locationTags: string[] = []): TagContext => ({ vocabulary: tagVocabulary(assets), sources, usesToday: {}, locationTags });
const ids = (sources: readonly TagSource[]) => sources.map((s) => s.id);

describe('tag sources from the game data (GEN-064)', () => {
  it('C1: Luminous Strike (Active, Daily_Limit 3) fits ATTACK on a MONSTER but not on an ALLY', () => {
    const luminous = abilitySource('skill-1', ability('Luminous Strike'));
    expect(luminous).toMatchObject({ id: 'skill-1', kind: 'skill', rank: 'B', trigger: 'active', dailyLimit: 3, verbTags: ['ATTACK'] });
    expect(ids(matchingSources(ctx([luminous]), ['ATTACK'], ['MONSTER']))).toEqual(['skill-1']);
    expect(ids(matchingSources(ctx([luminous]), ['ATTACK'], ['ALLY']))).toEqual([]);
  });

  it('C2: the tag list is every tag in the data, never ANY', () => {
    const vocabulary = tagVocabulary(assets);
    for (const tag of ['ATTACK', 'MONSTER', 'ALLY', 'PUBLIC', 'SAFE_ZONE', 'PERSUADE', 'PRAY', 'GATHER', 'SECRET_ACTION']) expect(vocabulary).toContain(tag);
    expect(vocabulary).not.toContain('ANY');
    expect(vocabulary).not.toContain('SMASH');
    expect([...vocabulary].sort()).toEqual(vocabulary);
    expect(new Set(vocabulary).size).toBe(vocabulary.length);
  });

  it('C4 / C6: Passive rows are passive with no quota; ANY in Match_Verb_Tags fits every verb', () => {
    const untouched = abilitySource('skill-2', ability('I AM UNTOUCHED'));
    expect(untouched).toMatchObject({ trigger: 'passive', dailyLimit: 0, rank: 'SS' });
    for (const verb of ['ATTACK', 'PERSUADE', 'STEAL']) expect(ids(matchingSources(ctx([untouched]), [verb], ['SELF']))).toEqual(['skill-2']);
    expect(itemSource('item-1', item('Grimoire of the Blood Moon'))).toMatchObject({ kind: 'item', rank: 'S', trigger: 'both', dailyLimit: 1 });
  });

  it('Q-090: the d20 bonus is the positive dice_bonus of the row; Rank caps and the Q-119 exception travel with it', () => {
    expect(abilitySource('s', ability('Feast of Malice')).diceBonus).toBe(2);
    expect(abilitySource('s', ability('Luminous Strike')).diceBonus).toBe(0); // qualitative only
    expect(abilitySource('s', ability('Venom of Despair')).diceBonus).toBe(0); // -3 is put on the target, not the actor
    expect(itemSource('i', item('Grimoire of the Blood Moon')).diceBonus).toBe(4);
    expect(itemSource('i', item('Prism of Truth')).diceBonusCap).toBe(3);
    expect(itemSource('i', item('Grimoire of the Blood Moon')).diceBonusCap).toBeNull();
  });

  it('start passives: a d20 passive with its location tag condition; a non-d20 passive gives no source', () => {
    const rows = assets.startScenarios;
    const busker = rows.find((r) => r.passive.stat === 'd20' && r.passive.condition === 'location tag PUBLIC') ?? expect.fail('no busker row');
    expect(startPassiveSource(busker)).toMatchObject({
      kind: 'start_passive',
      rank: null,
      trigger: 'passive',
      verbTags: busker.passive.verbTags,
      targetTags: [],
      requireLocationTags: ['PUBLIC'],
      diceBonus: busker.passive.value,
    });
    const stamina = rows.find((r) => r.passive.stat === 'Stamina') ?? expect.fail('no Stamina passive');
    expect(startPassiveSource(stamina)).toBeNull();
  });

  it('location: Weather_Verb_Boost gives +2 to the boosted verbs under that weather only', () => {
    expect(parseWeatherVerbBoost('Clear: [PERSUADE, SHARE] / Rain/Storm: [OBSERVE]')).toEqual([
      { conditions: ['Clear'], verbs: ['PERSUADE', 'SHARE'] },
      { conditions: ['Rain', 'Storm'], verbs: ['OBSERVE'] },
    ]);
    const fountain = assets.location('น้ำพุกลางเมือง') ?? expect.fail('no fountain');
    expect(locationSources(fountain, 'Clear')).toEqual([
      {
        id: 'location:น้ำพุกลางเมือง:Clear',
        kind: 'location',
        rank: null,
        trigger: 'passive',
        dailyLimit: 0,
        verbTags: ['PERSUADE', 'SHARE'],
        targetTags: [],
        requireLocationTags: [],
        diceBonus: WEATHER_VERB_BOOST,
        diceBonusCap: null,
      },
    ]);
    expect(WEATHER_VERB_BOOST).toBe(2);
    expect(locationSources(fountain, 'Fog')).toEqual([]);
    expect(locationSources(fountain, null)).toEqual([]);
    const inn = assets.location('โรงเตี๊ยมและกิลด์นักเดินทาง') ?? expect.fail('no inn');
    expect(locationSources(inn, 'Dark Night').map((s) => s.verbTags)).toEqual([['REST', 'PERSUADE']]); // "Night" = any night weather
  });

  it('Q-132: "Clear" also fits Clear Morning and Clear Night; a longer name does not fit plain Clear', () => {
    const fountain = assets.location('น้ำพุกลางเมือง') ?? expect.fail('no fountain');
    for (const weather of ['Clear', 'Clear Morning', 'Clear Night']) {
      expect(locationSources(fountain, weather).map((s) => s.verbTags), weather).toEqual([['PERSUADE', 'SHARE']]);
    }
    expect(locationSources(fountain, 'Dark Night')).toEqual([]);
    const sea = assets.location('ทะเล') ?? expect.fail('no sea');
    expect(locationSources(sea, 'Clear Night').map((s) => s.verbTags)).toEqual([['TRAVEL', 'TRADE', 'OBSERVE', 'RITUAL']]);
    expect(locationSources(sea, 'Clear Morning').map((s) => s.verbTags)).toEqual([['TRAVEL', 'TRADE']]);
    const dawn = assets.location('โบสถ์แห่งรุ่งอรุณ') ?? expect.fail('no dawn church');
    expect(locationSources(dawn, 'Clear')).toEqual([]);
  });

  it('Q-131: Venom of Despair\'s -3 is a bonus on the target, capped by Rank A', () => {
    const venom = abilitySource('s', ability('Venom of Despair'));
    expect(venom.diceBonus).toBe(0);
    expect(venom.targetDiceBonus).toBe(-3);
    expect(abilitySource('s', ability('Feast of Malice')).targetDiceBonus ?? 0).toBe(0);
  });
});

const noEffects = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };

function action(who: Seat, actionId: string, tagging: TagClaim, patch: Partial<ResolutionProposal> = {}): PhaseAction {
  const proposal: ResolutionProposal = {
    actionId,
    kind: 'complex',
    tags: [],
    opposed: false,
    staminaCost: 5,
    visibility: 'public',
    target: null,
    check: { type: 'dc', dc: 14 },
    modifiers: [],
    witnessNpcIds: [],
    repDeltaIfCaught: 0,
    onSuccess: noEffects,
    onFail: noEffects,
    reason: 'test action',
    tagging,
    ...patch,
  };
  return { actorId: who.memberId, proposal, targetPlayer: null, moveTo: null, awareness: 'normal' };
}

describe('tag matching in a phase on the server (GEN-064)', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function table(): Promise<Table & { gameId: string }> {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    return { ...t, gameId };
  }

  /** The loot step (GEN-048) gave `who` a skill and an item with these names. */
  function giveLoot(who: Seat, skillName: string, itemName: string) {
    const trait = (label: string, scope: string, value: number) => ({ label, description: label, scope, value });
    const option = (id: string, kind: 'item' | 'skill', name: string) => ({ id, kind, name, description: name, tier: 'Common', buffType: 'Qualitative', effect: null });
    const chosen = { strength: trait('ช่างฝีมือ', 'craft', 2), weakness: trait('ไม่ศรัทธา', 'faith', -2), skill: option(`skill-${who.name}`, 'skill', skillName), item: option(`item-${who.name}`, 'item', itemName) };
    server!.db
      .prepare('insert into character_loot (member_id, offer_json, chosen_json, rerolls_used, updated_at) values (?, null, ?, 0, ?)')
      .run(who.memberId, JSON.stringify(chosen), CLOCK);
  }

  const dbDump = () =>
    JSON.stringify(['character', 'character_presence', 'item_holder', 'tag_source_use'].map((t) => server!.db.prepare(`select * from ${t} order by rowid`).all()));
  const stamina = (who: Seat) => (server!.db.prepare('select stamina from character where member_id = ?').get(who.memberId) as { stamina: number }).stamina;
  const options = (day: number, patch: Partial<TaggingOptions> = {}): TaggingOptions => ({ assets, day, ...patch });
  const smite = (who: Seat, n: number) => action(who, `smite-${n}`, { verbTags: ['ATTACK'], targetTags: ['NPC'], activate: [{ ref: `skill-${who.name}`, stamina: 5 }] });

  it('C3: an Active skill with Daily_Limit 2 is refused the 3rd time on game day 1 (nothing changes) and works on day 2', async () => {
    const t = await table();
    giveLoot(t.a, 'Smite of Purgation', 'Mask of the Faceless');

    for (const n of [1, 2]) {
      const before = stamina(t.a);
      const r = applyPhaseActions(server!.orm, t.gameId, [smite(t.a, n)], new ReplayRng([10, 10]), CLOCK, options(1));
      expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
      expect(stamina(t.a)).toBe(before - 5 - 5); // action 5 + Active skill 5
    }
    expect(usesOnDay(server!.orm, t.a.memberId, 1)).toEqual({ [`skill-${t.a.name}`]: 2 });

    const before = dbDump();
    const third = applyPhaseActions(server!.orm, t.gameId, [smite(t.a, 3)], new ReplayRng([10, 10]), CLOCK, options(1));
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.errors.map((e) => [e.code, e.path])).toEqual([['daily_limit_reached', 'proposal.tagging.activate[0].ref']]);
    expect(dbDump()).toBe(before);

    const nextDay = applyPhaseActions(server!.orm, t.gameId, [smite(t.a, 4)], new ReplayRng([10, 10]), CLOCK, options(2));
    expect(nextDay.ok).toBe(true);
    expect(usesOnDay(server!.orm, t.a.memberId, 2)).toEqual({ [`skill-${t.a.name}`]: 1 });
    expect(usesOnDay(server!.orm, t.a.memberId, 1)).toEqual({ [`skill-${t.a.name}`]: 2 });
  });

  it('C2 / C7: an unknown tag, or a skill / item the player does not hold, rejects every action and nothing changes', async () => {
    const t = await table();
    giveLoot(t.a, 'Smite of Purgation', 'Mask of the Faceless');
    giveLoot(t.b, 'Luminous Strike', 'Prism of Truth');
    const before = dbDump();

    const unknownTag = applyPhaseActions(server!.orm, t.gameId, [action(t.a, 'x', { verbTags: ['SMASH'], targetTags: ['NPC'], activate: [] }), action(t.b, 'y', { verbTags: ['ATTACK'], targetTags: ['NPC'], activate: [] })], new ReplayRng([10, 10, 10, 10]), CLOCK, options(1));
    expect(unknownTag.ok).toBe(false);
    if (!unknownTag.ok) expect(unknownTag.errors).toContainEqual(expect.objectContaining({ code: 'unknown_tag', path: 'proposal.tagging.verbTags[0]', action: 0 }));

    // A tries to activate B's skill.
    const notHeld = applyPhaseActions(server!.orm, t.gameId, [action(t.a, 'x', { verbTags: ['ATTACK'], targetTags: ['MONSTER'], activate: [{ ref: `skill-${t.b.name}`, stamina: 4 }] }), action(t.b, 'y', { verbTags: ['ATTACK'], targetTags: ['NPC'], activate: [] })], new ReplayRng([10, 10, 10, 10]), CLOCK, options(1));
    expect(notHeld.ok).toBe(false);
    if (!notHeld.ok) expect(notHeld.errors.map((e) => [e.code, e.path, e.action])).toEqual([['ref_not_owned', 'proposal.tagging.activate[0].ref', 0]]);
    expect(dbDump()).toBe(before);
  });

  it('C8: the phase log lists each bonus with its source: skill, item, location, weather and start passive', async () => {
    const t = await table();
    giveLoot(t.a, 'Feast of Malice', 'Grimoire of the Blood Moon');
    // A starts at the scenario's first place; give it the name of a Location row.
    server!.db.prepare("update game_scenario set data = json_set(data, '$.locations[0].name', 'น้ำพุกลางเมือง') where game_id = ?").run(t.gameId);
    const busker = startPassiveSource(assets.startScenarios.find((r) => r.passive.condition === 'location tag PUBLIC' && r.passive.verbTags.includes('PERSUADE'))!)!;
    const breeze: TagSource = { id: 'weather:Clear', kind: 'weather', rank: null, trigger: 'passive', dailyLimit: 0, verbTags: ['PERSUADE'], targetTags: [], requireLocationTags: [], diceBonus: 1, diceBonusCap: null };
    const opts = options(1, { weather: 'Clear', startPassives: { [t.a.memberId]: [busker] }, weatherSources: { [t.a.memberId]: [breeze] } });

    const contexts = tagContexts(server!.orm, t.gameId, crossPlayerState(server!.orm, t.gameId), opts);
    expect(contexts[t.a.memberId]?.locationTags).toEqual(['PUBLIC', 'CROWD', 'OUTDOOR', 'CENTRAL']);
    // B stands at the same place but has no loot in the data: only the place's weather boost.
    expect(ids(contexts[t.b.memberId]?.sources ?? [])).toEqual(['location:น้ำพุกลางเมือง:Clear']);

    const claim: TagClaim = { verbTags: ['PERSUADE', 'STEAL', 'CURSE'], targetTags: ['SECRET_ACTION', 'CROWD'], activate: [] };
    const r = applyPhaseActions(server!.orm, t.gameId, [action(t.a, 'sway', claim, { kind: 'general', staminaCost: 3 })], new ReplayRng([10, 10]), CLOCK, opts);
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    if (!r.ok) return;
    const outcome = r.log.outcomes[0]!;
    if (outcome.status !== 'resolved') return expect.fail(`expected resolved, got ${outcome.status}`);
    expect(outcome.log.tagging?.bonuses).toEqual([
      { kind: 'skill', ref: `skill-${t.a.name}`, trigger: 'passive', value: 2 },
      { kind: 'item', ref: `item-${t.a.name}`, trigger: 'passive', value: 4 },
      { kind: 'location', ref: 'location:น้ำพุกลางเมือง:Clear', trigger: 'passive', value: 2 },
      { kind: 'weather', ref: 'weather:Clear', trigger: 'passive', value: 1 },
      { kind: 'start_passive', ref: busker.id, trigger: 'passive', value: 2 },
    ]);
    expect(outcome.log.check?.modifiers.map((m) => m.source)).toEqual(['skill', 'item', 'location', 'weather', 'start_passive']);
    expect(outcome.log.check?.modifierTotal).toBe(10);
    expect(usesOnDay(server!.orm, t.a.memberId, 1)).toEqual({}); // passives use no quota
  });
});
