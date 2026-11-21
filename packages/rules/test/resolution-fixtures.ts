import type { Effects, ResolutionProposal, ResolutionState, Rng } from '../src/index.ts';

/** Snapshot used by most resolution tests: actor Lin in the market with a guard and a priest. */
export function baseState(): ResolutionState {
  return {
    actor: {
      id: 'pc-lin',
      locationId: 'market',
      hp: 100,
      stamina: 30,
      rep: 0,
      karma: 0,
      affinity: { 'npc-guard': 0 },
      items: [
        { id: 'item-letter', tier: 'Common' },
        { id: 'item-dagger', tier: 'Rare' },
        { id: 'item-hairpin', tier: 'Common' },
      ],
      skills: [{ id: 'skill-climb', tier: 'Common' }],
      statuses: [],
      afterActionStamina: 0,
      damageReduction: 0,
    },
    npcs: {
      'npc-guard': { id: 'npc-guard', grade: 'B', hp: 60, locationId: 'market', obsTrait: 0, damageReduction: 0 },
      'npc-priest': { id: 'npc-priest', grade: 'A', hp: 100, locationId: 'market', obsTrait: 0, damageReduction: 0 },
      'npc-far': { id: 'npc-far', grade: 'F', hp: 40, locationId: 'temple', obsTrait: 0, damageReduction: 0 },
    },
  };
}

export function noEffects(overrides: Partial<Effects> = {}): Effects {
  return {
    repDelta: 0,
    karmaDelta: 0,
    affinity: [],
    damage: null,
    selfDamage: null,
    heal: null,
    addStatus: [],
    removeStatus: [],
    ...overrides,
  };
}

export function proposal(overrides: Partial<ResolutionProposal> = {}): ResolutionProposal {
  return {
    actionId: 'act-1',
    kind: 'general',
    tags: [],
    opposed: false,
    staminaCost: 3,
    visibility: 'public',
    target: null,
    check: { type: 'dc', dc: 11 },
    modifiers: [{ source: 'stat' }],
    witnessNpcIds: [],
    repDeltaIfCaught: 0,
    onSuccess: noEffects(),
    onFail: noEffects(),
    reason: 'test action',
    ...overrides,
  };
}

/** Wraps an Rng and counts how many numbers were drawn. */
export class CountingRng implements Rng {
  calls = 0;
  readonly #inner: Rng;

  constructor(inner: Rng) {
    this.#inner = inner;
  }

  nextInt(min: number, max: number): number {
    this.calls++;
    return this.#inner.nextInt(min, max);
  }
}
