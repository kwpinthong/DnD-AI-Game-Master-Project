/** Resolution engine types (Rules Spec GEN-042 §2-7, §12-13). Every value is plain JSON so logs replay. */
import type { ActionWeather, WeatherLog } from '../weather.ts';
import type { TagClaim, TagContext, TaggingLog, TagSourceKind } from './tags.ts';

export const DC_LADDER = [5, 8, 11, 14, 17, 20, 23] as const;
export type Dc = (typeof DC_LADDER)[number];

export const ACTION_KINDS = ['general', 'complex', 'exertion'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_TAGS = ['physical', 'social', 'stealth', 'perception', 'craft', 'faith', 'knowledge'] as const;
export type ActionTag = (typeof ACTION_TAGS)[number];

/** Q-053: no critRange / fumbleRange scope; crit and fumble are the natural die only. */
export const STATUS_SCOPES = [...ACTION_KINDS, ...ACTION_TAGS, 'observe', 'defense', 'priority', 'all'] as const;
export type StatusScope = (typeof STATUS_SCOPES)[number];

/** Uses outside an action roll (observe a Secret, be a PvP target, phase ordering). */
export type StatUse = 'observe' | 'defense' | 'priority';

export type Tier = 'Common' | 'Rare' | 'Legendary';
export type NpcGrade = 'F' | 'B' | 'A' | 'S' | 'SS';
export const SEVERITIES = ['minor', 'light', 'moderate', 'heavy', 'severe', 'lethal'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Visibility = 'public' | 'secret';
export type Degree = 'fumble' | 'fail' | 'success' | 'crit';

export interface StatusMod {
  readonly scope: StatusScope;
  readonly value: number;
}

/** A buff or debuff (ค่าสถานะ, Q-032). Conditions from HP/Stamina are derived each roll and never stored. */
export interface StatusEffect {
  readonly id: string;
  readonly label: string;
  readonly polarity: 'buff' | 'debuff';
  /**
   * `curse`: put on the holder by another's skill for a time (GEN-095, Venom of Despair): its mods apply to every
   * d20 the holder rolls (their own action without a `stat` claim too) and to their defence; the AI cannot remove it.
   */
  readonly origin: 'trait' | 'event' | 'gear' | 'curse';
  readonly visible: boolean;
  readonly mods: readonly StatusMod[];
  /** Phases left; null = permanent (trait, gear). Ticking down is phase logic (GEN-052). */
  readonly phasesLeft: number | null;
  /** Item or skill id that grants a gear effect; it cannot also be claimed as an `item` modifier. */
  readonly ref?: string;
}

export interface OwnedRef {
  readonly id: string;
  readonly tier: Tier;
}

export interface ActorState {
  readonly id: string;
  readonly locationId: string;
  readonly hp: number;
  /** The character's own Max HP (its start scenario's, GEN-065 / Q-210); absent = RULES.hpMax (100). */
  readonly hpMax?: number;
  readonly stamina: number;
  readonly rep: number;
  /** Hidden from clients (spec §6). */
  readonly karma: number;
  /** Affinity per NPC id; a missing NPC counts as 0. */
  readonly affinity: Readonly<Record<string, number>>;
  readonly items: readonly OwnedRef[];
  readonly skills: readonly OwnedRef[];
  readonly statuses: readonly StatusEffect[];
  /** Quantitative after_action refund, e.g. Auto Pilot +3 (net cost still >= 1, Q-037). */
  readonly afterActionStamina: number;
  /** Quantitative damage reduction: Common 2, Rare 4, Legendary 8. */
  readonly damageReduction: number;
}

export interface NpcState {
  readonly id: string;
  readonly grade: NpcGrade;
  readonly hp: number;
  readonly locationId: string;
  /** GEN-184: actor id → where this NPC is for that actor when it differs from `locationId` (a karma-only schedule row). */
  readonly placeFor?: Readonly<Record<string, string>>;
  /** -2..+2 from the NPC's personality in the scenario (spec §10.4). */
  readonly obsTrait: number;
  readonly damageReduction: number;
  /** Curses on the NPC (GEN-095): its observe roll, and the DC of an action against it, move by their mods. */
  readonly statuses?: readonly StatusEffect[];
}

/** State snapshot an action resolves against. */
export interface ResolutionState {
  readonly actor: ActorState;
  readonly npcs: Readonly<Record<string, NpcState>>;
}

/** Judged sources: the AI proposes a value within the tier cap. */
export interface JudgedModifier {
  readonly source: 'item' | 'skill';
  readonly ref: string;
  readonly value: number;
}

/** Derived sources: the AI only says they apply; the server computes the number. */
export type DerivedModifier =
  | { readonly source: 'stat' }
  | { readonly source: 'rep'; readonly mode: 'favor' | 'fear' }
  | { readonly source: 'karma'; readonly align: 'light' | 'dark' }
  | { readonly source: 'affinity'; readonly ref: string };

export type Modifier = JudgedModifier | DerivedModifier;

/** An event status the AI asks to add to the actor (Q-052: +/-3, 1..9 phases, at most 4 active). */
export interface StatusRequest {
  readonly label: string;
  readonly polarity: 'buff' | 'debuff';
  readonly mods: readonly StatusMod[];
  readonly phases: number;
  readonly visible: boolean;
}

export interface Effects {
  /** Applied only when Public (Secret uses repDeltaIfCaught when caught). */
  readonly repDelta: number;
  /** Applied on every action. */
  readonly karmaDelta: number;
  readonly affinity: readonly { readonly npcId: string; readonly delta: number }[];
  /** Damage to the NPC target. */
  readonly damage: Severity | null;
  readonly selfDamage: Severity | null;
  /** Heals the NPC target, or the actor when there is no target. */
  readonly heal: Severity | null;
  readonly addStatus: readonly StatusRequest[];
  /** Ids of the actor's event statuses to remove. */
  readonly removeStatus: readonly string[];
}

/** `pvp`: the target is a player and the server computes DC_pvp (spec §10.3); needs `ResolutionInput.pvp`. */
export type Check = { readonly type: 'dc'; readonly dc: Dc } | { readonly type: 'pvp' } | { readonly type: 'none' };

/** Set by the cross-player rules (GEN-060) when the action targets a player. */
export interface PvpContext {
  /** DC_pvp = 11 + clamp(stat(B, 'defense') + defense(B), -10, +10). */
  readonly dc: number;
  /** clamp(stat(B, 'observe') + awareness + perception(B), -10, +10) when B rolls to notice a Secret; null = B does not roll. */
  readonly observeModifier: number | null;
  /** The target's curses already inside `dc` (GEN-095, negative); a target penalty of the same curse (Q-131) does not add to them. */
  readonly targetCurse?: number;
}

/** What the AI GM proposes for one action, before any die is rolled (spec §13, single-action subset). */
export interface ResolutionProposal {
  readonly actionId: string;
  readonly kind: ActionKind;
  readonly tags: readonly ActionTag[];
  readonly opposed: boolean;
  readonly staminaCost: number;
  /** Chosen by the player when submitting the action. */
  readonly visibility: Visibility;
  readonly target: { readonly npc: string } | null;
  readonly check: Check;
  readonly modifiers: readonly Modifier[];
  readonly witnessNpcIds: readonly string[];
  readonly repDeltaIfCaught: number;
  readonly onSuccess: Effects;
  readonly onFail: Effects;
  readonly reason: string;
  /** Verb / target tags and Active sources used (GEN-064); needs `ResolutionInput.tags`. */
  readonly tagging?: TagClaim;
}

export interface ResolutionInput {
  readonly state: ResolutionState;
  readonly proposal: ResolutionProposal;
  /** Only for an action that targets a player (GEN-060). */
  readonly pvp?: PvpContext;
  /** The actor's tag sources and today's uses (GEN-064). */
  readonly tags?: TagContext;
  /** The period's weather where the actor is (GEN-068): the server applies its d20 and Stamina rules. */
  readonly weather?: ActionWeather;
  /**
   * GEN-069: the place scales a Public action's Reputation change (the fountain ×1.5, Location
   * Special_Mechanics), rounded toward zero like damage ×1.5 (GEN-042). Absent = 1.
   */
  readonly publicRepScale?: number;
}

export type ProposalErrorCode =
  | 'actor_unconscious'
  | 'not_integer'
  | 'out_of_range'
  | 'unknown_kind'
  | 'unknown_tag'
  | 'unknown_scope'
  | 'unknown_severity'
  | 'dc_not_on_ladder'
  | 'unknown_check'
  | 'stamina_cost_mismatch'
  | 'missing_source'
  | 'unknown_source'
  | 'missing_ref'
  | 'ref_not_owned'
  | 'gear_claimed_twice'
  | 'derived_value_given'
  | 'value_over_cap'
  | 'too_many'
  | 'duplicate'
  | 'unknown_npc'
  | 'npc_not_present'
  | 'unknown_status'
  | 'invalid_field'
  | 'not_active'
  | 'tags_not_matched'
  | 'daily_limit_reached'
  | 'tag_source_judged'
  | 'not_activated';

export interface ProposalError {
  readonly code: ProposalErrorCode;
  /** Where in the proposal, e.g. "modifiers[1].value". */
  readonly path: string;
  readonly message: string;
}

export interface LoggedModifier {
  /** A proposal modifier's source, or where a tag-matched bonus came from (GEN-064). */
  readonly source: Modifier['source'] | TagSourceKind | 'status';
  readonly ref?: string;
  readonly mode?: 'favor' | 'fear';
  readonly align?: 'light' | 'dark';
  readonly value: number;
  /** Q-130: the AI judged this number for a qualitative tag source (no numeric bonus in the data). */
  readonly judged?: true;
}

export interface CheckLog {
  /** A ladder DC, or DC_pvp for a player target. */
  readonly dc: number;
  /** Curses of the NPC target already inside `dc` (GEN-095, negative); absent = none. */
  readonly targetCurse?: number;
  readonly d20: number;
  readonly modifiers: readonly LoggedModifier[];
  readonly modifierSum: number;
  /** clamp(modifierSum, -10, +10) */
  readonly modifierTotal: number;
  readonly total: number;
  readonly margin: number;
}

export interface ChangeLog {
  readonly before: number;
  readonly delta: number;
  readonly after: number;
}

export interface HpLog {
  readonly before: number;
  readonly damage: number;
  readonly heal: number;
  readonly after: number;
}

export interface ResolutionLog {
  /** Deep copy of everything the result depends on, except the dice. */
  readonly input: ResolutionInput;
  /** Every die face in the order rolled: the action d20, then the witness d20 if any. */
  readonly rolls: readonly number[];
  /** null when the proposal has no roll (check: none). */
  readonly check: CheckLog | null;
  readonly degree: Degree;
  readonly caught: boolean;
  readonly observation: { readonly npcId: string; readonly d20: number; readonly total: number } | null;
  /** The target player's roll to notice a Secret (GEN-060): rolled after the action d20, before any NPC witness. */
  readonly targetObservation: { readonly d20: number; readonly modifier: number; readonly total: number; readonly noticed: boolean } | null;
  /** The target player noticed, so a success / crit became a fail (spec §10.4). */
  readonly interrupted: boolean;
  /** `after` also takes off `tagging.skillStamina` and `weather.stamina`. */
  readonly stamina: { readonly before: number; readonly cost: number; readonly net: number; readonly after: number };
  /** Present when the proposal had a tag claim (GEN-064). */
  readonly tagging?: TaggingLog;
  /** Present when the input had a weather (GEN-068). */
  readonly weather?: WeatherLog;
  readonly rep: ChangeLog;
  readonly karma: ChangeLog;
  readonly affinity: readonly ({ readonly npcId: string } & ChangeLog)[];
  readonly hp: { readonly actor: HpLog; readonly target: ({ readonly npcId: string } & HpLog) | null };
  readonly statusesAdded: readonly StatusEffect[];
  readonly statusesRemoved: readonly string[];
  /** HP 0 is unconscious (out cold one turn); death comes only from an EXECUTE then (GEN-070, phase engine). */
  readonly actorCondition: 'ok' | 'unconscious';
}

export type ResolveResult =
  | { readonly ok: true; readonly state: ResolutionState; readonly log: ResolutionLog }
  | { readonly ok: false; readonly errors: readonly ProposalError[] };
