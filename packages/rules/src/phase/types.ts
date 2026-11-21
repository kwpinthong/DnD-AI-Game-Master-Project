/**
 * Day / phase engine types (GDD §3, Rules Spec GEN-042 §4, §10.4, §12.2). Every value is plain JSON so a
 * game can be stored and replayed: the engine is a pure function of (state, event, rng).
 */
import type { RescueOutcome, Safety } from '../resolution/rescue.ts';
import type { Visibility } from '../resolution/types.ts';

/** Same values as `Phase` in `@isekai/protocol`. */
export const PHASES = ['MORNING', 'AFTERNOON', 'NIGHT'] as const;
export type Phase = (typeof PHASES)[number];

/** Same as `SCENARIO_DAYS` in `@isekai/protocol`: the finale starts after Night of this day. */
export const GAME_DAYS = 12;

export interface PhasePoint {
  readonly day: number;
  readonly phase: Phase;
}

/**
 * What a player is in the current phase.
 * - `awake`: must submit one action.
 * - `exhausted`: Stamina hit 0 last phase, so this phase the input is locked and the character sleeps (spec §4.3).
 * - `unconscious`: HP 0 (Q-036 / Q-054 / Q-057, no death); locked until `wakeAt`.
 */
export type PlayerCondition = 'awake' | 'exhausted' | 'unconscious';

export interface KnockedOut {
  /** The phase the character wakes at the start of: next day's Morning, or next day's Afternoon after a Night knock-out. */
  readonly wakeAt: PhasePoint;
  /** Safety of the place they fell (spec §12.2); location rules are GEN-060. */
  readonly safety: Safety;
  readonly primaryAffinity: number;
  /** Another player's general action at DC 8 succeeded (Q-056): wake as `rescued` with no roll. */
  readonly rescued: boolean;
}

export interface PlayerPhaseState {
  readonly id: string;
  readonly hp: number;
  readonly stamina: number;
  readonly condition: PlayerCondition;
  /** Derived from `condition`: only `awake` players have to submit, so the phase never waits for the others. */
  readonly mustSubmit: boolean;
  /** Day the player last used their one Secret phase (spec §10.4); null = not yet. */
  readonly secretDay: number | null;
  /** Σ on_sleep item/skill bonus added to sleep recovery (spec §4.1, §4.3). */
  readonly sleepBonus: number;
  readonly knockedOut: KnockedOut | null;
}

/** One action as the player sends it. The AI GM turns it into a ResolutionProposal later (GEN-051). */
export interface PlayerAction {
  readonly text: string;
  readonly visibility: Visibility;
  /** The player rests this phase instead of acting (spec §4.1 / §4.2). */
  readonly rest?: boolean;
  /** Night rest at the inn: Stamina +rollRange(15, 25) + sleepBonus, capped at max. Needs `rest` and Night. */
  readonly restAtInn?: boolean;
}

export type PhaseStatus = 'collecting' | 'resolving' | 'finale' | 'game_over';

export interface PhaseState {
  readonly day: number;
  readonly phase: Phase;
  readonly status: PhaseStatus;
  /** Seat order (join order). */
  readonly order: readonly string[];
  readonly players: Readonly<Record<string, PlayerPhaseState>>;
  /** This phase's actions; a resubmit before the phase closes replaces the player's entry. */
  readonly submissions: Readonly<Record<string, PlayerAction>>;
  readonly staminaMax: number;
  readonly hpMax: number;
}

/**
 * The resolved outcome for one player, from the resolution engine (GEN-051) after the phase's actions.
 * Missing fields keep the player's current value.
 */
export interface PlayerResult {
  readonly hp?: number;
  readonly stamina?: number;
  /** Where the player sleeps tonight is the inn (forced sleep at Night; a Night `rest` action uses `restAtInn`). */
  readonly atInn?: boolean;
  /** Needed only when HP reaches 0. Default `normal` / 0. */
  readonly safety?: Safety;
  readonly primaryAffinity?: number;
  /** An unconscious player was rescued this phase by another player's general action at DC 8 (Q-056). */
  readonly rescued?: boolean;
}

export type PhaseEvent =
  | { readonly type: 'submit'; readonly playerId: string; readonly action: PlayerAction }
  | { readonly type: 'resolved'; readonly results: Readonly<Record<string, PlayerResult>> };

/** Why a player sleeps through a phase. Q-046: the feed labels these phases "ระหว่างคุณหลับ". */
export type SleepReason = 'exhausted' | 'night_rest';

export type RecoveryKind = 'night_inn' | 'night_rough' | 'day_rest' | 'exhausted_day' | 'exhausted_night_inn' | 'exhausted_night_rough';

export type PhaseLogEntry =
  | { readonly type: 'submitted'; readonly at: PhasePoint; readonly playerId: string; readonly action: PlayerAction; readonly replaced: boolean }
  | {
      readonly type: 'phase_closed';
      readonly at: PhasePoint;
      readonly actions: Readonly<Record<string, PlayerAction>>;
      /** Players who sleep through this phase (Q-046). */
      readonly asleep: readonly { readonly playerId: string; readonly reason: SleepReason }[];
      readonly unconscious: readonly string[];
    }
  | {
      readonly type: 'recovered';
      readonly at: PhasePoint;
      readonly playerId: string;
      readonly kind: RecoveryKind;
      /** The rollRange(15, 25) face for an inn rest; null when the gain is fixed. */
      readonly roll: number | null;
      readonly stamina: { readonly before: number; readonly gain: number; readonly after: number };
      readonly hp: { readonly before: number; readonly gain: number; readonly after: number };
    }
  | { readonly type: 'exhausted'; readonly at: PhasePoint; readonly playerId: string; readonly sleepsAt: PhasePoint }
  | { readonly type: 'knocked_out'; readonly at: PhasePoint; readonly playerId: string; readonly wakeAt: PhasePoint }
  | { readonly type: 'rescued_by_player'; readonly at: PhasePoint; readonly playerId: string }
  | {
      readonly type: 'woke';
      readonly at: PhasePoint;
      readonly playerId: string;
      readonly outcome: RescueOutcome;
      /** null when a player rescued them (no roll). */
      readonly rescueRoll: { readonly d20: number; readonly score: number } | null;
      readonly hp: number;
      readonly stamina: number;
    }
  | { readonly type: 'phase_started'; readonly at: PhasePoint }
  | { readonly type: 'finale'; readonly at: PhasePoint }
  | { readonly type: 'game_over'; readonly at: PhasePoint; readonly reason: 'all_unconscious' };

export type PhaseErrorCode =
  | 'not_collecting'
  | 'not_resolving'
  | 'game_ended'
  | 'unknown_player'
  | 'cannot_act'
  | 'secret_quota_used'
  | 'invalid_action'
  | 'invalid_result';

export interface PhaseError {
  readonly code: PhaseErrorCode;
  readonly message: string;
}

export type PhaseStepResult =
  | { readonly ok: true; readonly state: PhaseState; readonly log: readonly PhaseLogEntry[] }
  | { readonly ok: false; readonly error: PhaseError };

export interface NewPlayer {
  readonly id: string;
  readonly hp?: number;
  readonly stamina?: number;
  readonly sleepBonus?: number;
}
