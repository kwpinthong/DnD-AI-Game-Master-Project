/**
 * Game data from the sheet "Asset Isekai v1.0 (Nok working copy)" (GEN-062). The sheet is the
 * source of truth over the GDD when they disagree (Nok 2026-11-22). `pnpm assets:import` turns
 * each tab into one JSON file in apps/server/assets/; the server only ever reads those files.
 *
 * These zod schemas describe the JSON files: the importer checks its own output against them and
 * the server checks the files again at start-up (a hand edit cannot slip past).
 */
import { z } from 'zod';

export const REQUIRED_TABS = ['Ability', 'Item', 'NPC', 'Location', 'Start_Scenarios', 'System_Rules', 'World_Timeline'] as const;
/** Tabs Nok adds later (Q-092 NPC_Schedule, GEN-072 Day10_Strategies): missing = a warning, not a failure. */
export const OPTIONAL_TABS = ['NPC_Schedule', 'Day10_Strategies'] as const;
export const ALL_TABS = [...REQUIRED_TABS, ...OPTIONAL_TABS] as const;
export type TabName = (typeof ALL_TABS)[number];

export const TAB_FILES: Readonly<Record<TabName, string>> = {
  Ability: 'ability.json',
  Item: 'item.json',
  NPC: 'npc.json',
  Location: 'location.json',
  Start_Scenarios: 'start-scenarios.json',
  System_Rules: 'system-rules.json',
  World_Timeline: 'world-timeline.json',
  NPC_Schedule: 'npc-schedule.json',
  Day10_Strategies: 'day10-strategies.json',
};

export const RANKS = ['F', 'B', 'A', 'S', 'SS'] as const;
export const TRIGGER_TYPES = ['Active', 'Passive', 'Passive + Active'] as const;
export const ALIGNMENTS = ['Good', 'Evil', 'Neutral'] as const;
export const PERIODS = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;
export const WEATHERS = ['Clear', 'Clear Morning', 'Clear Night', 'Rain', 'Storm', 'Fog', 'Dark Night', 'Disaster'] as const;
/** What a numeric effect changes (Q-090 `Stat`). */
export const STATS = ['HP', 'Stamina', 'd20', 'Karma', 'Coins'] as const;
/** What the chronic illness of a start scenario may lower (Q-208). */
export const ILLNESS_STATS = ['d20', 'Stamina'] as const;
/** Numeric effects the server computes itself (Q-090 `Effect_Type`); anything qualitative goes to the AI as text. */
export const EFFECT_TYPES = [
  'restore',
  'damage_mult',
  'damage_reduce_pct',
  'damage_block',
  'flat_damage',
  'dot',
  'drain',
  'dice_bonus',
  'affinity',
  'stamina_cost',
  'env_stamina_reduce_pct',
  'secret_quota',
  'karma_lock',
  /** Cancels effects for the duration (Q-116: Day10_Strategies S4, Absolute Zero Law). */
  'nullify',
] as const;

/** Highest d20 `dice_bonus` per Rank (Q-114, F from Q-122); above it the import warns. */
export const DICE_BONUS_CAP: Readonly<Record<Rank, number>> = { F: 1, B: 2, A: 3, S: 5, SS: 5 };
/** Allowed exceptions to DICE_BONUS_CAP (Q-119), by Ability name / Item English name. */
export const DICE_BONUS_EXCEPTIONS: Readonly<Record<string, number>> = { 'Prism of Truth': 3 };

export type Rank = (typeof RANKS)[number];
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export type Alignment = (typeof ALIGNMENTS)[number];
export type Period = (typeof PERIODS)[number];
export type Weather = (typeof WEATHERS)[number];
export type Stat = (typeof STATS)[number];
export type EffectType = (typeof EFFECT_TYPES)[number];

const Tags = z.array(z.string().regex(/^[A-Z0-9_]+$/, 'tag ต้องเป็นตัวพิมพ์ใหญ่ ตัวเลข หรือ _'));
const Text = z.string();
const Name = z.string().min(1, 'ต้องไม่ว่าง');
/** Columns the sheet has that this schema does not know yet, kept as text so nothing is lost. */
const Extra = z.record(z.string(), z.string()).optional();

export const Duration = z.union([
  z.object({ unit: z.enum(['instant', 'passive', 'end_of_period']) }).strict(),
  z.object({ unit: z.enum(['hit', 'period', 'day']), count: z.number().int().positive() }).strict(),
]);
export type Duration = z.infer<typeof Duration>;

export const Effect = z
  .object({
    type: z.enum(EFFECT_TYPES),
    stats: z.array(z.enum(STATS)),
    value: z.number(),
    duration: Duration,
  })
  .strict();
export type Effect = z.infer<typeof Effect>;

export const AbilityRecord = z
  .object({
    rank: z.enum(RANKS),
    alignment: z.enum(ALIGNMENTS),
    name: Name,
    category: Text,
    description: Text,
    condition: Text,
    quote: Text,
    triggerType: z.enum(TRIGGER_TYPES),
    /** Uses per day; 0 = no limit. */
    dailyLimit: z.number().int().nonnegative(),
    matchVerbTags: Tags,
    matchTargetTags: Tags,
    effects: z.array(Effect),
    note: Text,
    extra: Extra,
  })
  .strict();
export type AbilityRecord = z.infer<typeof AbilityRecord>;

export const ItemRecord = z
  .object({
    rank: z.enum(RANKS),
    alignment: z.enum(ALIGNMENTS),
    category: Text,
    /** The cell as written, e.g. "Chalice of the First Dawn (จอกศักดิ์สิทธิ์รุ่งอรุณแรก)". */
    name: Name,
    /** The English name before " (": what other tabs use to refer to the item. */
    nameEn: Name,
    buffType: Text,
    effect: Text,
    synergy: Text,
    description: Text,
    triggerType: z.enum(TRIGGER_TYPES),
    dailyLimit: z.number().int().nonnegative(),
    matchVerbTags: Tags,
    matchTargetTags: Tags,
    effects: z.array(Effect),
    note: Text,
    extra: Extra,
  })
  .strict();
export type ItemRecord = z.infer<typeof ItemRecord>;

/** Location `Safety` (Q-161). */
export const LOCATION_SAFETIES = ['SAFE', 'NORMAL', 'DANGER', 'RESTRICTED'] as const;
/** Location `Rest_Quality` (Q-161). */
export const REST_QUALITIES = ['poor', 'normal', 'good', 'excellent'] as const;
export type LocationSafety = (typeof LOCATION_SAFETIES)[number];
export type RestQualityValue = (typeof REST_QUALITIES)[number];

export const NpcRecord = z
  .object({
    grade: z.enum(RANKS),
    alignments: z.array(z.enum(ALIGNMENTS)),
    /** "Name / Initial Status" as written. */
    name: Name,
    /** Short names other tabs may use (the name before " (" or " —", from both name columns). */
    aliases: z.array(Name),
    trueName: Text,
    lore: Text,
    unlockCondition: Text,
    rewards: Text,
    matchVerbTags: Tags,
    matchTargetTags: Tags,
    /** Q-161: what players see before they learn the truth (no spoilers); empty = the sheet gives none. */
    publicAlias: Text.default(''),
    /** GEN-150: the NPC's own goodbye line for server-written farewells; empty = a generic one from server-lines.json. */
    farewell: Text.default(''),
    note: Text.default(''),
    extra: Extra,
  })
  .strict();
export type NpcRecord = z.infer<typeof NpcRecord>;

export const LocationRecord = z
  .object({
    zone: Text,
    name: Name,
    characteristics: Text,
    timeAndWeather: Text,
    npcsAndBehavior: Text,
    specialMechanics: Text,
    tags: Tags,
    /** e.g. "Clear: [PERSUADE, SHARE] / Rain: [OBSERVE]" (the weather rules are GEN-068). */
    weatherVerbBoost: Text,
    /**
     * Q-161: places reachable as a same-zone move, by Location name, plus the special links
     * (โบสถ์ ↔ โบสถ์ (ชั้นใต้ดิน), หอสมุดหลวง ↔ มิติพิศวง). Cross-zone travel follows System_Rules, not this list.
     */
    connectsTo: z.array(Name).default([]),
    /** Q-161; null on a row that is not a place (the weather-rules row). */
    safety: z.enum(LOCATION_SAFETIES).nullable().default(null),
    restQuality: z.enum(REST_QUALITIES).nullable().default(null),
    note: Text.default(''),
    extra: Extra,
  })
  .strict();
export type LocationRecord = z.infer<typeof LocationRecord>;

export const StartScenarioRecord = z
  .object({
    tier: Text,
    /** Percent chance, e.g. 7.25; all rows add up to 100. */
    rate: z.number().nonnegative(),
    zone: Text,
    location: Text,
    name: Name,
    tags: Tags,
    startHp: z.number().int(),
    maxHp: z.number().int(),
    startStamina: z.number().int(),
    startCoins: z.number().int(),
    startKarma: z.number().int(),
    initialTitle: Text,
    passiveText: Text,
    passive: z
      .object({
        verbTags: Tags,
        stat: z.union([z.enum(STATS), z.enum(EFFECT_TYPES)]).nullable(),
        value: z.number().nullable(),
        condition: Text,
      })
      .strict(),
    /**
     * Q-208: the chronic illness penalty (Illness_Stat / Illness_Value) while the start's illness lasts:
     * `d20` = on every roll, `Stamina` = on every action that costs Stamina. Both null = none (the default).
     */
    illness: z
      .object({ stat: z.enum(ILLNESS_STATS).nullable(), value: z.number().int().max(0).nullable() })
      .strict()
      .default({ stat: null, value: null }),
    note: Text,
    extra: Extra,
  })
  .strict();
export type StartScenarioRecord = z.infer<typeof StartScenarioRecord>;

export const SystemRuleRecord = z
  .object({ category: Text, name: Name, parameters: Text, mechanics: Text, extra: Extra })
  .strict();
export type SystemRuleRecord = z.infer<typeof SystemRuleRecord>;

export const WorldEventRecord = z
  .object({
    /** "Day_&_Period" as written, e.g. "วันที่ 12 — ช่วง HESPERION ถึง NOCTHERION". */
    when: Text,
    day: z.number().int().min(1).max(12),
    periods: z.array(z.enum(PERIODS)),
    name: Name,
    location: Text,
    interventionEffects: Text,
    driftIfIgnored: Text,
    foreshadowing: Text,
    extra: Extra,
  })
  .strict();
export type WorldEventRecord = z.infer<typeof WorldEventRecord>;

export const NpcScheduleRecord = z
  .object({
    npc: Name,
    location: Name,
    /** Empty = any period. */
    periods: z.array(z.enum(PERIODS)),
    /** Empty = any weather. */
    weathers: z.array(z.enum(WEATHERS)),
    condition: Text,
    note: Text,
    extra: Extra,
  })
  .strict();
export type NpcScheduleRecord = z.infer<typeof NpcScheduleRecord>;

/** Draft tab from GEN-072: only Strategy_ID and Name must exist; the rest is text the AI reads. */
export const Day10StrategyRecord = z
  .object({
    status: Text,
    id: Name,
    name: Name,
    karmaAlignments: z.array(z.enum(ALIGNMENTS)),
    karmaCondition: Text,
    requiredSkills: Text,
    requiredItems: Text,
    requiredNpcs: Text,
    day1Modifier: Text,
    day5Modifier: Text,
    day7Condition: Text,
    location: Text,
    night10Actions: Text,
    dc: Text,
    bonus: Text,
    matchVerbTags: Tags,
    matchTargetTags: Tags,
    effects: z.array(Effect),
    successEffect: Text,
    failureEffect: Text,
    endingLink: Text,
    note: Text,
    extra: Extra,
  })
  .strict();
export type Day10StrategyRecord = z.infer<typeof Day10StrategyRecord>;

/** Does NPC alias `alias` name the same NPC as `ref` ("เลดี้เซเรน่า" matches "เลดี้เซเรน่า แห่งหอจดหมายเหตุ")? */
export function aliasMatches(alias: string, ref: string): boolean {
  return alias === ref || alias.startsWith(`${ref} `);
}

/** The stored schema of each tab's JSON file (an array of records). */
export const TAB_SCHEMAS = {
  Ability: z.array(AbilityRecord),
  Item: z.array(ItemRecord),
  NPC: z.array(NpcRecord),
  Location: z.array(LocationRecord),
  Start_Scenarios: z.array(StartScenarioRecord),
  System_Rules: z.array(SystemRuleRecord),
  World_Timeline: z.array(WorldEventRecord),
  NPC_Schedule: z.array(NpcScheduleRecord),
  Day10_Strategies: z.array(Day10StrategyRecord),
} as const satisfies Record<TabName, z.ZodType>;

export type TabRecords = { [T in TabName]: z.infer<(typeof TAB_SCHEMAS)[T]> };
