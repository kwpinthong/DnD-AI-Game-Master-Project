import type { ActionKind, ActionTag, ActorState, NpcGrade, Severity, StatUse, StatusEffect, Tier } from './types.ts';

/** Rules Spec §14 parameters used by the resolution engine. */
export const RULES = {
  hpMax: 100,
  staminaMax: 30,
  modCapTotal: 10,
  statCap: 6,
  minNetCost: 1,
  rangeMin: -100,
  rangeMax: 100,
  deltaCap: 10,
  affinityPerAction: 10,
  repDeltaIfCaughtMin: -10,
  maxItems: 2,
  maxSkills: 1,
  maxModifiers: 6,
  maxTags: 2,
  maxWitnesses: 6,
  maxAffinityEntries: 3,
  eventStatusCap: 3,
  eventStatusPhases: 9,
  eventStatusPerAction: 2,
  eventStatusMaxActive: 4,
  maxStatusMods: 2,
  statusLabelMax: 30,
  removeStatusPerAction: 2,
  judgedMin: -2,
  overexert: -2,
} as const;

export const TIER_CAP: Readonly<Record<Tier, number>> = { Common: 2, Rare: 3, Legendary: 5 };

export const SEVERITY_BASE: Readonly<Record<Severity, number>> = {
  minor: 3,
  light: 8,
  moderate: 15,
  heavy: 25,
  severe: 40,
  lethal: 70,
};

export const GRADE_OBS_MOD: Readonly<Record<NpcGrade, number>> = { F: 0, B: 1, A: 3, S: 5, SS: 7 };
export const NPC_HP_MAX: Readonly<Record<NpcGrade, number>> = { F: 40, B: 60, A: 100, S: 150, SS: 300 };

/** Allowed Stamina cost per kind (spec §3): general 3, complex 5 (6 when opposed), exertion 7..10. */
export function staminaCostRange(kind: ActionKind, opposed: boolean): readonly [number, number] {
  switch (kind) {
    case 'general':
      return [3, 3];
    case 'complex':
      return opposed ? [6, 6] : [5, 5];
    case 'exertion':
      return [7, 10];
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type ConditionUse = ActionKind | StatUse;
type ConditionRow = Readonly<Record<ConditionUse, number>>;

/** Spec §2.4 condition debuffs (Q-050 sizes confirmed). */
const CONDITIONS: readonly { readonly label: string; readonly when: (a: ActorState) => boolean; readonly mods: ConditionRow }[] = [
  { label: 'เหนื่อย', when: (a) => a.stamina >= 5 && a.stamina <= 9, mods: { general: 0, complex: -1, exertion: -2, observe: 0, defense: 0, priority: 0 } },
  { label: 'อ่อนล้า', when: (a) => a.stamina >= 1 && a.stamina <= 4, mods: { general: -1, complex: -2, exertion: -4, observe: -1, defense: -1, priority: 0 } },
  { label: 'บาดเจ็บ', when: (a) => a.hp >= 25 && a.hp <= 49, mods: { general: 0, complex: -1, exertion: -1, observe: 0, defense: 0, priority: -1 } },
  { label: 'สาหัส', when: (a) => a.hp >= 1 && a.hp <= 24, mods: { general: -1, complex: -2, exertion: -3, observe: -1, defense: -2, priority: -2 } },
];

/** Labels of the HP/Stamina conditions the actor is in. */
export function conditionsOf(actor: ActorState): string[] {
  return CONDITIONS.filter((c) => c.when(actor)).map((c) => c.label);
}

export type StatQuery =
  | { readonly kind: ActionKind; readonly tags: readonly ActionTag[]; readonly staminaCost: number }
  | { readonly use: StatUse };

/**
 * `stat` modifier (ค่าสถานะ): conditions + overexert + every status whose scope matches, clamped to +/-6.
 * Overexert (ฝืนเกินแรง) = -2 when cost > Stamina on complex/exertion. Q-053 wins over Q-050: no fumble widening.
 */
export function computeStat(actor: ActorState, query: StatQuery): number {
  const use: ConditionUse = 'use' in query ? query.use : query.kind;
  const tags: readonly string[] = 'use' in query ? [] : query.tags;
  let value = 0;
  for (const condition of CONDITIONS) {
    if (condition.when(actor)) value += condition.mods[use];
  }
  if ('kind' in query && query.kind !== 'general' && query.staminaCost > actor.stamina) value += RULES.overexert;
  for (const status of actor.statuses) {
    // A curse on the actor's own action roll is its own logged modifier (`curseMods`), never inside stat.
    if (status.origin === 'curse' && 'kind' in query) continue;
    for (const mod of status.mods) {
      if (mod.scope === use || mod.scope === 'all' || tags.includes(mod.scope)) value += mod.value;
    }
  }
  return clamp(value, -RULES.statCap, RULES.statCap);
}

/**
 * GEN-095: what each curse (`origin: 'curse'`) adds to a roll of its holder for `use` (an action kind / tags, or
 * observe / defense / priority). Not capped by the stat cap; one entry per curse with a non-zero sum.
 */
export function curseMods(
  statuses: readonly StatusEffect[] | undefined,
  use: ActionKind | StatUse,
  tags: readonly string[] = [],
): { readonly ref: string; readonly value: number }[] {
  return (statuses ?? []).flatMap((s) => {
    if (s.origin !== 'curse') return [];
    const value = s.mods.reduce((sum, m) => (m.scope === use || m.scope === 'all' || tags.includes(m.scope) ? sum + m.value : sum), 0);
    return value === 0 ? [] : [{ ref: s.id, value }];
  });
}

export interface RepTier {
  readonly title: string;
  readonly mod: number;
}

const REP_TIERS: readonly (RepTier & { readonly min: number })[] = [
  { min: 61, title: 'วีรชนแห่งเมือง', mod: 3 },
  { min: 31, title: 'ผู้ใจบุญ', mod: 2 },
  { min: 11, title: 'คนคุ้นหน้า', mod: 1 },
  { min: -10, title: 'คนแปลกหน้า', mod: 0 },
  { min: -30, title: 'คนน่าสงสัย', mod: -1 },
  { min: -60, title: 'เงามืดผู้ต้องสงสัย', mod: -2 },
  { min: -100, title: 'ภัยของเมือง', mod: -3 },
];

/** Social Title for a reputation value (spec §5). */
export function repTier(rep: number): RepTier {
  const tier = REP_TIERS.find((t) => rep >= t.min) ?? REP_TIERS[REP_TIERS.length - 1]!;
  return { title: tier.title, mod: tier.mod };
}

/** Karma band -2..+2 (spec §6). */
export function karmaBand(karma: number): number {
  if (karma >= 50) return 2;
  if (karma >= 20) return 1;
  if (karma <= -50) return -2;
  if (karma <= -20) return -1;
  return 0;
}

/** Affinity modifier trunc(affinity / 20), -5..+5 (spec §7). */
export function affinityMod(affinity: number): number {
  return Math.trunc(affinity / 20) + 0; // + 0 turns -0 into 0
}
