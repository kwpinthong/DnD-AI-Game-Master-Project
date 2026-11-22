import { describe, expect, it } from 'vitest';
import {
  PERIODS,
  ReplayRng,
  WEATHERS,
  boostConditions,
  isDisasterDay,
  periodWeather,
  replayResolution,
  resolveAction,
  resolvePhaseActions,
  weatherChoices,
  weatherProblem,
  type ActionWeather,
  type PlayerState,
  type ResolutionProposal,
} from '../src/index.ts';
import { baseState, proposal } from './resolution-fixtures.ts';

/** GEN-068 weather per period (Q-089), the rules of the sheet's "กฎทั้ง 5 สภาพอากาศ" row. */

const w = (weather: ActionWeather['weather'], patch: Partial<ActionWeather> = {}): ActionWeather => ({ weather, disaster: false, outdoor: false, ...patch });

const resolve = (p: Partial<ResolutionProposal>, weather?: ActionWeather) => {
  const tags = p.tagging ? { tags: { vocabulary: ['STEALTH', 'OBSERVE'], sources: [], usesToday: {}, locationTags: [] } } : {};
  const r = resolveAction({ state: baseState(), proposal: proposal(p), ...tags, ...(weather ? { weather } : {}) }, new ReplayRng([10, 1, 1]));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};

const stealthClaim = { verbTags: ['STEALTH'], targetTags: [], activate: [] };

describe('GEN-068 the weathers the AI may pick', () => {
  it('C2: EOSORIA / SOLARION have no night weather; HESPERION / NOCTHERION have all six', () => {
    for (const phase of ['EOSORIA', 'SOLARION'] as const) {
      expect(weatherChoices(phase)).toEqual(['Clear', 'Rain', 'Fog', 'Storm']);
      expect(weatherProblem(phase, 'Dark Night')).toMatch(/Dark Night/);
      expect(weatherProblem(phase, 'Clear Night')).not.toBeNull();
    }
    for (const phase of ['HESPERION', 'NOCTHERION'] as const) expect(weatherChoices(phase)).toEqual([...WEATHERS]);
    for (const phase of PERIODS) for (const ok of weatherChoices(phase)) expect(weatherProblem(phase, ok)).toBeNull();
  });

  it('C2: a value not in the list is a problem (Disaster is never picked: it comes from the day)', () => {
    for (const bad of ['Sunny', 'Disaster', 'clear', '', null, 3, undefined]) expect(weatherProblem('HESPERION', bad)).not.toBeNull();
  });

  it('C6: Disaster holds from day 5 on, whatever the weather', () => {
    expect([1, 4, 5, 12].map(isDisasterDay)).toEqual([false, false, true, true]);
    expect(periodWeather(4, 'Clear')).toEqual({ weather: 'Clear', disaster: false });
    expect(periodWeather(5, 'Clear')).toEqual({ weather: 'Clear', disaster: true });
    expect(periodWeather(9, 'Fog')).toEqual({ weather: 'Fog', disaster: true });
  });

  it('Weather_Verb_Boost conditions: Clear in EOSORIA is Clear Morning; Disaster from day 5', () => {
    expect(boostConditions({ weather: 'Clear', disaster: false }, 'EOSORIA')).toEqual(['Clear Morning']);
    expect(boostConditions({ weather: 'Clear', disaster: false }, 'SOLARION')).toEqual(['Clear']);
    expect(boostConditions({ weather: 'Dark Night', disaster: true }, 'NOCTHERION')).toEqual(['Dark Night', 'Disaster']);
  });
});

describe('GEN-068 weather in the resolution engine', () => {
  it('C3: Clear + a Secret action rolls d20 -2, and the log names the weather as the source', () => {
    const plain = resolve({ visibility: 'secret' });
    const sunny = resolve({ visibility: 'secret' }, w('Clear'));
    expect(sunny.log.check!.modifiers).toContainEqual({ source: 'weather', ref: 'Clear:secret', value: -2 });
    expect(sunny.log.check!.total).toBe(plain.log.check!.total - 2);
    expect(sunny.log.weather).toMatchObject({ weather: 'Clear', modifiers: [{ ref: 'Clear:secret', value: -2 }], stamina: 0 });
    // A Public action under the sun has no penalty.
    expect(resolve({ visibility: 'public' }, w('Clear')).log.check!.modifiers.some((m) => m.source === 'weather')).toBe(false);
    expect(replayResolution(sunny.log)).toEqual(sunny);
  });

  it('C4: Rain + an OUTDOOR action costs 1 more Stamina; indoors it does not', () => {
    const base = resolve({}).log.stamina.after;
    expect(resolve({}, w('Rain', { outdoor: true })).log.stamina.after).toBe(base - 1);
    expect(resolve({}, w('Rain', { outdoor: true })).log.weather!.stamina).toBe(1);
    expect(resolve({}, w('Rain')).log.stamina.after).toBe(base);
    expect(resolve({}, w('Fog', { outdoor: true })).log.stamina.after).toBe(base);
  });

  it('C4: Rain + verb STEALTH rolls +2 (also for the action tag stealth); other verbs do not', () => {
    const stealth = resolve({ tagging: stealthClaim }, w('Rain'));
    expect(stealth.log.check!.modifiers).toContainEqual({ source: 'weather', ref: 'Rain:STEALTH', value: 2 });
    const tagged = resolve({ tags: ['stealth'] }, w('Rain'));
    expect(tagged.log.check!.modifiers).toContainEqual({ source: 'weather', ref: 'Rain:STEALTH', value: 2 });
    const other = resolve({ tagging: { verbTags: ['OBSERVE'], targetTags: [], activate: [] } }, w('Rain'));
    expect(other.log.check!.modifiers.some((m) => m.source === 'weather')).toBe(false);
    // Stealth under Fog: no number (qualitative weathers give the AI text only).
    expect(resolve({ tagging: stealthClaim }, w('Fog')).log.check!.modifiers.some((m) => m.source === 'weather')).toBe(false);
  });

  it('C6: Disaster + OUTDOOR costs 2 more Stamina whatever the weather; Rain adds its own 1', () => {
    const base = resolve({}).log.stamina.after;
    for (const weather of ['Clear', 'Fog', 'Storm', 'Clear Night'] as const) {
      const r = resolve({}, w(weather, { disaster: true, outdoor: true }));
      expect(r.log.stamina.after).toBe(base - 2);
      expect(r.log.weather!.stamina).toBe(2);
    }
    expect(resolve({}, w('Rain', { disaster: true, outdoor: true })).log.weather!.stamina).toBe(3);
    expect(resolve({}, w('Clear', { disaster: true })).log.stamina.after).toBe(base);
  });

  it('C4 / C6: a phase resolves each actor outdoor or not by the place they act at', () => {
    const player = (id: string, seat: number, locationId: string): PlayerState => ({
      id, seat, locationId, hp: 100, stamina: 30, rep: 0, karma: 0, affinity: {}, items: [], skills: [], statuses: [],
      afterActionStamina: 0, damageReduction: 0, remoteReach: [],
    });
    const act = (actorId: string) => ({
      actorId, proposal: proposal({ actionId: `act-${actorId}`, witnessNpcIds: [] }), targetPlayer: null, moveTo: null, awareness: 'normal' as const,
    });
    const r = resolvePhaseActions(
      {
        state: { players: { a: player('a', 0, 'fountain'), b: player('b', 1, 'inn') }, npcs: {} },
        actions: [act('a'), act('b')],
        weather: { current: { weather: 'Rain', disaster: true }, outdoorLocationIds: ['fountain'] },
      },
      new ReplayRng([5, 6, 10, 10]),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const cost = Object.fromEntries(r.log.outcomes.map((o) => [o.actorId, o.status === 'resolved' ? o.log.weather?.stamina : null]));
    expect(cost).toEqual({ a: 3, b: 0 });
  });
});
