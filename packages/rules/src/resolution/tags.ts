/**
 * Tag matching (GEN-064). The AI GM names each action's verb tags ([ATTACK]) and target tags
 * ([MONSTER]) using only tags that exist in the game data (GEN-062). The server then finds the
 * actor's sources whose Match_Verb_Tags and Match_Target_Tags fit (`ANY` fits every tag) and turns
 * them into modifiers the resolution engine applies itself:
 * - Passive sources (Daily_Limit 0) work on every matching action, without a quota or a command.
 * - Active sources work only when the proposal activates them, at most Daily_Limit times per game day;
 *   an Active skill also costs 4..6 Stamina, as the proposal states.
 * - The d20 bonus is the source's numeric `dice_bonus` (Q-090), capped by its Rank (Q-114 / Q-122,
 *   exceptions Q-119). Qualitative effects give no number here; the AI reads them as text.
 * Every value is plain JSON so a log replays.
 */
import type { ProposalError } from './types.ts';

/** In Match_Verb_Tags / Match_Target_Tags: fits any tag. Never a tag a proposal may use. */
export const ANY_TAG = 'ANY';

/** Where a bonus comes from, as the log names it. */
export const TAG_SOURCE_KINDS = ['skill', 'item', 'location', 'weather', 'start_passive'] as const;
export type TagSourceKind = (typeof TAG_SOURCE_KINDS)[number];

export type SourceRank = 'F' | 'B' | 'A' | 'S' | 'SS';
/** Highest d20 bonus per Rank: Q-114 (B 2, A 3, S / SS 5), Q-122 (F 1). */
export const RANK_DICE_CAP: Readonly<Record<SourceRank, number>> = { F: 1, B: 2, A: 3, S: 5, SS: 5 };

/** Stamina an Active skill costs per use (System_Rules "Active Skill เสีย 4-6 หน่วย"). */
export const ACTIVE_SKILL_STAMINA = { min: 4, max: 6 } as const;

export interface TagSource {
  /** Unique per actor: the owned skill / item id, or e.g. "weather:<location>:Rain". */
  readonly id: string;
  readonly kind: TagSourceKind;
  /** null = no Rank (location, weather, start passive): its bonus is not Rank-capped. */
  readonly rank: SourceRank | null;
  /** `both` = "Passive + Active": the passive part works by itself, activating it uses the quota. */
  readonly trigger: 'active' | 'passive' | 'both';
  /** Activations per game day; 0 = no limit. */
  readonly dailyLimit: number;
  readonly verbTags: readonly string[];
  /** Empty = any target. */
  readonly targetTags: readonly string[];
  /** Every one of these must be a tag of the actor's location (e.g. a start passive "location tag PUBLIC"). */
  readonly requireLocationTags: readonly string[];
  /** Numeric d20 bonus from the data (Q-090), before the Rank cap. */
  readonly diceBonus: number;
  /** Allowed exception to the Rank cap (Q-119), null = the Rank cap. */
  readonly diceBonusCap: number | null;
}

/** What the server knows about the actor for tag matching; plain JSON, kept in the log. */
export interface TagContext {
  /** Every tag the game data uses (GEN-062), without ANY. */
  readonly vocabulary: readonly string[];
  readonly sources: readonly TagSource[];
  /** Activations so far on the current game day, by source id. */
  readonly usesToday: Readonly<Record<string, number>>;
  readonly locationTags: readonly string[];
}

export interface Activation {
  readonly ref: string;
  /** Stamina for an Active skill (4..6); null for an item. */
  readonly stamina: number | null;
}

/** The tag part of a proposal. */
export interface TagClaim {
  readonly verbTags: readonly string[];
  readonly targetTags: readonly string[];
  /** Active sources the actor uses on this action. */
  readonly activate: readonly Activation[];
}

export interface TagBonusLog {
  readonly kind: TagSourceKind;
  readonly ref: string;
  readonly trigger: 'passive' | 'active';
  readonly value: number;
}

export interface TaggingLog {
  readonly verbTags: readonly string[];
  readonly targetTags: readonly string[];
  /** Every source that worked on this action, with the number it added to the d20. */
  readonly bonuses: readonly TagBonusLog[];
  /** Activations with the source's use count for the day after this one. */
  readonly activated: readonly { readonly ref: string; readonly stamina: number; readonly usesToday: number }[];
  /** Stamina the activated skills cost, on top of the action's own cost. */
  readonly skillStamina: number;
}

const fits = (wanted: readonly string[], given: readonly string[]) => wanted.includes(ANY_TAG) || wanted.some((t) => given.includes(t));

/** Does `source` fit an action with these tags at a place with `locationTags`? */
export function sourceMatches(
  source: TagSource,
  verbTags: readonly string[],
  targetTags: readonly string[],
  locationTags: readonly string[],
): boolean {
  return (
    fits(source.verbTags, verbTags) &&
    (source.targetTags.length === 0 || fits(source.targetTags, targetTags)) &&
    source.requireLocationTags.every((t) => locationTags.includes(t))
  );
}

/** The actor's sources that fit the action, in the context's order. */
export function matchingSources(ctx: TagContext, verbTags: readonly string[], targetTags: readonly string[]): TagSource[] {
  return ctx.sources.filter((s) => sourceMatches(s, verbTags, targetTags, ctx.locationTags));
}

/** The d20 bonus a source adds: its numeric bonus, capped by its Rank (or its exception). */
export function tagBonus(source: TagSource): number {
  const cap = source.diceBonusCap ?? (source.rank === null ? Number.POSITIVE_INFINITY : RANK_DICE_CAP[source.rank]);
  return Math.min(source.diceBonus, cap);
}

const canActivate = (s: TagSource) => s.trigger !== 'passive';
const worksByItself = (s: TagSource) => s.trigger !== 'active';

/** Problems with the tag part of a proposal; judged item / skill refs are checked so a data source is not also judged. */
export function validateTagging(
  ctx: TagContext | undefined,
  claim: TagClaim | undefined,
  judgedRefs: readonly { readonly ref: string; readonly path: string }[],
): ProposalError[] {
  const errors: ProposalError[] = [];
  const fail = (code: ProposalError['code'], path: string, message: string) => errors.push({ code, path, message });

  if (ctx !== undefined) {
    for (const { ref, path } of judgedRefs) {
      if (ctx.sources.some((s) => s.id === ref)) fail('tag_source_judged', path, `${ref} gives its bonus from the game data through tagging; it may not be judged too`);
    }
  }
  if (claim === undefined) return errors;
  if (ctx === undefined) return [...errors, { code: 'invalid_field', path: 'tagging', message: 'tags can only be checked with the server tag context' }];

  const c = claim as unknown as Record<string, unknown>;
  const tagList = (key: 'verbTags' | 'targetTags', min: number): string[] => {
    const list = c[key];
    if (!Array.isArray(list) || list.length < min || list.length > MAX_TAGS) {
      fail('invalid_field', `tagging.${key}`, `${key} must list ${min}..${MAX_TAGS} tags`);
      return [];
    }
    list.forEach((tag, i) => {
      if (typeof tag !== 'string' || tag === ANY_TAG || !ctx.vocabulary.includes(tag)) {
        fail('unknown_tag', `tagging.${key}[${i}]`, `${JSON.stringify(tag)} is not a tag in the game data`);
      }
    });
    return list as string[];
  };
  const verbTags = tagList('verbTags', 1);
  const targetTags = tagList('targetTags', 0);

  if (!Array.isArray(c.activate)) return [...errors, { code: 'invalid_field', path: 'tagging.activate', message: 'activate must be a list' }];
  const seen = new Set<string>();
  (c.activate as readonly Activation[]).forEach((a, i) => {
    const path = `tagging.activate[${i}]`;
    const source = ctx.sources.find((s) => s.id === a?.ref);
    if (source === undefined) return void fail('ref_not_owned', `${path}.ref`, `the actor has no skill or item ${JSON.stringify(a?.ref)}`);
    if (seen.has(source.id)) return void fail('duplicate', `${path}.ref`, `${source.id} is activated twice`);
    seen.add(source.id);
    if (!canActivate(source)) return void fail('not_active', `${path}.ref`, `${source.id} is Passive: it works by itself and is never activated`);
    if (!sourceMatches(source, verbTags, targetTags, ctx.locationTags)) fail('tags_not_matched', `${path}.ref`, `${source.id} does not fit these verb / target tags`);
    const used = ctx.usesToday[source.id] ?? 0;
    if (source.dailyLimit > 0 && used >= source.dailyLimit) fail('daily_limit_reached', `${path}.ref`, `${source.id} was used ${used} of ${source.dailyLimit} times today`);
    if (source.kind === 'skill') {
      const { min, max } = ACTIVE_SKILL_STAMINA;
      if (typeof a.stamina !== 'number' || !Number.isInteger(a.stamina) || a.stamina < min || a.stamina > max) {
        fail('out_of_range', `${path}.stamina`, `an Active skill costs ${min}..${max} Stamina, got ${JSON.stringify(a.stamina)}`);
      }
    } else if (a.stamina !== null) fail('invalid_field', `${path}.stamina`, `only an Active skill costs Stamina; ${source.kind} stamina must be null`);
  });
  return errors;
}

const MAX_TAGS = 4;

/** The bonuses and activations of a valid claim. */
export function applyTagging(ctx: TagContext, claim: TagClaim): TaggingLog {
  const active = new Map(claim.activate.map((a) => [a.ref, a]));
  const bonuses: TagBonusLog[] = [];
  for (const source of matchingSources(ctx, claim.verbTags, claim.targetTags)) {
    const activated = active.has(source.id);
    if (!activated && !worksByItself(source)) continue;
    bonuses.push({ kind: source.kind, ref: source.id, trigger: activated ? 'active' : 'passive', value: tagBonus(source) });
  }
  const activated = claim.activate.map((a) => ({ ref: a.ref, stamina: a.stamina ?? 0, usesToday: (ctx.usesToday[a.ref] ?? 0) + 1 }));
  return {
    verbTags: [...claim.verbTags],
    targetTags: [...claim.targetTags],
    bonuses,
    activated,
    skillStamina: activated.reduce((sum, a) => sum + a.stamina, 0),
  };
}
