import { z } from 'zod';

/**
 * Personality-driven loot (GDD §4.1, GEN-048 → GEN-073): the AI reads the personality, names one
 * strength and one weakness (permanent traits, Rules Spec §2.4 source 2, Q-051) and picks up to 3
 * skills and up to 3 items from the Rank B rows of the Asset sheet whose tags fit (Q-100, Q-128).
 * The player keeps exactly one of each.
 */
export const LOOT_OPTION_MAX = 3;
/** The sheet has no Common tier: the loot step offers Rank B rows only (Q-100). */
export const LOOT_RANK = 'B' as const;
/** The largest value an old GEN-048 Common Quantitative effect may carry (Rules Spec TIER_CAP.Common). */
export const LOOT_COMMON_CAP = 2;
/** Trait size (Q-051): strength +2 at one scope, weakness -2 at one scope. */
export const TRAIT_VALUE = 2;
/** Rerolls per character. `null` = unlimited (Q-029). */
export const LOOT_REROLL_LIMIT: number | null = null;

export const BUFF_TYPES = ['Qualitative', 'Quantitative'] as const;
export type BuffType = (typeof BUFF_TYPES)[number];

/** Same list as `STATUS_SCOPES` in @isekai/rules (a server test keeps them equal). */
export const LOOT_SCOPES = [
  'general',
  'complex',
  'exertion',
  'physical',
  'social',
  'stealth',
  'perception',
  'craft',
  'faith',
  'knowledge',
  'observe',
  'defense',
  'priority',
  'all',
] as const;
export type LootScope = (typeof LOOT_SCOPES)[number];

const commonValue = z.number().int().min(1).max(LOOT_COMMON_CAP);

/**
 * The Quantitative effects of an old GEN-048 Common option, kept so a game that started with one
 * still applies it (GEN-073 C5). New options carry the sheet's `effects` instead:
 * - `check_bonus`: a gear status mod at one scope (Rules Spec §2.4 source 4).
 * - `damage_reduction`: ActorState.damageReduction (§12.1).
 * - `stamina_refund`: ActorState.afterActionStamina, net cost still at least 1 (§3, Q-037).
 */
export const LootEffect = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('check_bonus'), scope: z.enum(LOOT_SCOPES), value: commonValue }),
  z.strictObject({ type: z.literal('damage_reduction'), value: commonValue }),
  z.strictObject({ type: z.literal('stamina_refund'), value: commonValue }),
]);
export type LootEffect = z.infer<typeof LootEffect>;
export const LOOT_EFFECT_TYPES = ['check_bonus', 'damage_reduction', 'stamina_refund'] as const;

/** One numeric effect of a sheet row as the asset JSON has it (GEN-062, Q-090). */
export const LootSheetEffect = z.strictObject({
  type: z.string(),
  stats: z.array(z.string()),
  value: z.number(),
  duration: z.strictObject({ unit: z.string(), count: z.number().int().positive().optional() }),
});
export type LootSheetEffect = z.infer<typeof LootSheetEffect>;

export const LootOption = z.strictObject({
  /** Server-made; a new set gets new ids, so a pick from an old set never lands on the new one. */
  id: z.string(),
  kind: z.enum(['skill', 'item']),
  /** The sheet row's name exactly (Ability `Name` / Item English name): tag matching binds by it. */
  name: z.string(),
  /** Ability `Description` / Item `Effect`. */
  description: z.string(),
  /** 'B' = a row of the sheet. null = an old GEN-048 Common option, not in the sheet (C5). */
  rank: z.literal(LOOT_RANK).nullable(),
  /** The sheet's Trigger_Type ("Active", "Passive", "Passive + Active"); null for an old option. */
  triggerType: z.string().nullable(),
  /** Uses per game day; 0 = no limit. */
  dailyLimit: z.number().int().min(0),
  verbTags: z.array(z.string()),
  targetTags: z.array(z.string()),
  effects: z.array(LootSheetEffect),
});
export type LootOption = z.infer<typeof LootOption>;

/** A trait as the player sees it: a word and why, no number (Screens and Flows: ▲/▼ only). */
export const TraitView = z.strictObject({ label: z.string(), description: z.string() });
export type TraitView = z.infer<typeof TraitView>;

export const LootOffer = z.strictObject({
  strength: TraitView,
  weakness: TraitView,
  skills: z.array(LootOption).min(1).max(LOOT_OPTION_MAX),
  items: z.array(LootOption).min(1).max(LOOT_OPTION_MAX),
});
export type LootOffer = z.infer<typeof LootOffer>;

export const LootChosen = z.strictObject({
  strength: TraitView,
  weakness: TraitView,
  skill: LootOption,
  item: LootOption,
});
export type LootChosen = z.infer<typeof LootChosen>;

/** The caller's own loot step. Nobody else's personality, traits, skills or items ever appear here. */
export const LootView = z.strictObject({
  /** The set on offer now; null before the first analysis and after the choice. */
  offer: LootOffer.nullable(),
  chosen: LootChosen.nullable(),
  rerollsUsed: z.number().int().min(0),
  /** null = unlimited (Q-029). */
  rerollLimit: z.number().int().min(0).nullable(),
  /** False after the game starts, or when the quota is used up. */
  canReroll: z.boolean(),
  /**
   * True before the start when the kept set is an old GEN-048 Common one the sheet has no row for:
   * `chosen` is then null and the player must choose again (GEN-073 C5).
   */
  needsNewChoice: z.boolean(),
});
export type LootView = z.infer<typeof LootView>;

/** 200 from GET / POST /api/game/character/loot and POST /api/game/character/loot/choose. */
export const LootResponse = z.strictObject({ loot: LootView });
export type LootResponse = z.infer<typeof LootResponse>;

/** Body of POST /api/game/character/loot/choose: exactly one skill and one item from the offer (C4). */
export const LootChooseRequest = z.object({
  skillIds: z
    .array(z.string(), { error: 'กรุณาเลือก skill 1 อย่าง' })
    .min(1, 'กรุณาเลือก skill 1 อย่าง')
    .max(1, 'เลือก skill ได้ 1 อย่างเท่านั้น'),
  itemIds: z
    .array(z.string(), { error: 'กรุณาเลือกไอเท็ม 1 อย่าง' })
    .min(1, 'กรุณาเลือกไอเท็ม 1 อย่าง')
    .max(1, 'เลือกไอเท็มได้ 1 อย่างเท่านั้น'),
});
export type LootChooseRequest = z.infer<typeof LootChooseRequest>;
