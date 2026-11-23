/**
 * Day / period / turn engine types (System_Rules "Time System", GEN-063; Rules Spec GEN-042 §4, §10.4, §12.2).
 * Every value is plain JSON so a game can be stored and replayed: the engine is a pure function of
 * (state, event, rng).
 *
 * One day = 4 periods (ช่วงเวลา) of 2 turns each; 12 days = 96 turns. A turn closes once every player who
 * can act has sent (GEN-052). The period is kept under the key `phase` (stored games, the scenario timeline
 * and the room protocol all use that key); its values are the periods.
 */
import type { StatusEffect, Visibility } from '../resolution/types.ts';

/**
 * The one list of periods: `PHASES` of `@isekai/protocol` is this array (GEN-191). EOSORIA 06-12, SOLARION 12-18, HESPERION 18-24,
 * NOCTHERION 24-06 (still the same game day: the day changes after NOCTHERION).
 */
export const PERIODS = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;
export type Period = (typeof PERIODS)[number];

/** The sleeping period: free Secret turn, night rest, Drowsy check. */
export const NIGHT_PERIOD: Period = 'NOCTHERION';

export const TURNS_PER_PERIOD = 2;
export type Turn = 1 | 2;

/** Same as `SCENARIO_DAYS` in `@isekai/protocol`: the finale starts after NOCTHERION turn 2 of this day. */
export const GAME_DAYS = 12;
export const TOTAL_TURNS = GAME_DAYS * PERIODS.length * TURNS_PER_PERIOD;

/** The 3-phase model of GEN-052 stored by older games, and the period each maps to (GEN-063 C8). */
export const LEGACY_PHASES = { MORNING: 'EOSORIA', AFTERNOON: 'SOLARION', NIGHT: 'HESPERION' } as const satisfies Record<string, Period>;

export interface TurnPoint {
  readonly day: number;
  readonly phase: Period;
  readonly turn: Turn;
}

/** Karma at or below this is Evil (System_Rules "Karma Tiers": -14..-100). */
export const EVIL_KARMA_MAX = -14;

/** Drowsy (ง่วงซึม): d20 -2 on every roll and +1 Stamina on every action, for the whole next day. */
export const DROWSY = { d20: -2, stamina: 1 } as const;

/** Drowsy as the resolution engine reads it: put it in `ActorState.statuses` while `isDrowsy`. */
export const DROWSY_STATUS: StatusEffect = {
  id: 'drowsy',
  label: 'ง่วงซึม',
  polarity: 'debuff',
  origin: 'event',
  visible: true,
  mods: [{ scope: 'all', value: DROWSY.d20 }],
  phasesLeft: null,
};

export interface Drowsy {
  /** The day the player is Drowsy (the day after the NOCTHERION they stayed awake). */
  readonly day: number;
  /** Q-087: Evil karma, or a Secret in that NOCTHERION: a REST in EOSORIA that day clears it. */
  readonly canCompensate: boolean;
}

/**
 * What a player is in the current turn (GEN-070, System_Rules "Crisis & Death"). Only `awake` submits.
 * - `exhausted`: Stamina hit 0 last turn: this turn is a forced REST (+6) and hits on them count ×1.3.
 * - `unconscious`: HP hit 0 last turn: out cold this one turn; others may STEAL or EXECUTE them.
 * - `recovering`: carried to the central clinic after the turn out cold: `recoveringLeft` turns of rest.
 * - `astral_spirit`: executed while out cold; dead for good, never acts again.
 */
export type PlayerCondition = 'awake' | 'exhausted' | 'unconscious' | 'recovering' | 'astral_spirit';

export interface KnockedOut {
  /** The turn whose end left them at HP 0; they are out cold the turn after. */
  readonly at: TurnPoint;
}

export interface PlayerPhaseState {
  readonly id: string;
  readonly hp: number;
  readonly stamina: number;
  readonly condition: PlayerCondition;
  /** Derived from `condition`: only `awake` players have to submit, so the turn never waits for the others. */
  readonly mustSubmit: boolean;
  /** Day the player last used their one day Secret turn (spec §10.4) outside NOCTHERION; null = not yet. */
  readonly secretDay: number | null;
  /** Day whose NOCTHERION free Secret turn the player used; null = not yet. */
  readonly nightSecretDay: number | null;
  /** Day whose NOCTHERION the player slept (REST / SLEEP, forced sleep or out cold) for at least one turn. */
  readonly sleptDay: number | null;
  readonly drowsy: Drowsy | null;
  /** Hidden from clients; kept up to date from the resolver results (`PlayerResult.karma`). */
  readonly karma: number;
  /** Σ on_sleep item/skill bonus added to sleep recovery (spec §4.1, §4.3). */
  readonly sleepBonus: number;
  readonly knockedOut: KnockedOut | null;
  /** GEN-070: turns of clinic rest left, this one included, while `recovering`. */
  readonly recoveringLeft?: number;
  /** GEN-070: the turn they were executed in (an `astral_spirit`). */
  readonly diedAt?: TurnPoint;
  /** The character's own Max HP (GEN-065 / Q-210); absent (older saved states) = the state's `hpMax`. */
  readonly hpMax?: number;
  /** GEN-069 (Q-088): the day of the last TRAIN at the guild (once a day); absent = never. */
  readonly trainedDay?: number;
  /** GEN-069: the turn of the last REST at the infirmary; turn 1 then turn 2 of one period = HP back to max. */
  readonly clinicRestAt?: TurnPoint;
}

/** One action as the player sends it. The AI GM turns it into a ResolutionProposal later (GEN-051). */
export interface PlayerAction {
  readonly text: string;
  readonly visibility: Visibility;
  /** The player rests (REST / SLEEP) this turn instead of acting (spec §4.1 / §4.2). */
  readonly rest?: boolean;
  /**
   * GEN-069: TRAIN at the guild instead of a plain action (still an action the GM resolves): Max HP +3, once a
   * day, up to 45 (Q-088). The server checks the place; not with `rest`.
   */
  readonly train?: boolean;
}

/** Q-218: the sheet's Location Rest_Quality, as the scenario stores it. */
export type RestQuality = 'poor' | 'normal' | 'good' | 'excellent';

/** GEN-069 Location special mechanics for a REST: the inn (paid by the server) and the infirmary. */
export type RestSite = 'inn' | 'clinic';

export type PhaseStatus = 'collecting' | 'resolving' | 'finale' | 'game_over';

export interface PhaseState {
  readonly day: number;
  /** The period. */
  readonly phase: Period;
  readonly turn: Turn;
  readonly status: PhaseStatus;
  /** Seat order (join order). */
  readonly order: readonly string[];
  readonly players: Readonly<Record<string, PlayerPhaseState>>;
  /** This turn's actions; a resubmit before the turn closes replaces the player's entry. */
  readonly submissions: Readonly<Record<string, PlayerAction>>;
  readonly staminaMax: number;
  readonly hpMax: number;
}

/**
 * The resolved outcome for one player, from the resolution engine (GEN-051) after the turn's actions.
 * Missing fields keep the player's current value. `stamina` is before the Drowsy +1, which the engine adds.
 */
export interface PlayerResult {
  readonly hp?: number;
  readonly stamina?: number;
  /** -100..100; the player's karma after the turn (decides the Q-087 Evil exception). */
  readonly karma?: number;
  /**
   * Q-218: Rest_Quality of where the player is: a NOCTHERION sleep (REST or forced) recovers its
   * `REST_QUALITY_STAMINA`. Absent = poor (the old rough rest).
   */
  readonly restQuality?: RestQuality;
  /** GEN-069: a REST at a place with special mechanics (the inn once the server took its coins, the infirmary). */
  readonly restSite?: RestSite;
  /**
   * Q-209: extra recovery when the player recovers this turn, summed by the server (start scenario REST passives).
   * Whole numbers >= 0, capped at max like the recovery; nothing when the player does not recover.
   */
  readonly restBonus?: { readonly stamina?: number; readonly hp?: number };
  /** GEN-070: a player out cold this turn was executed (a successful EXECUTE): Astral Spirit for good. */
  readonly executed?: boolean;
}

export type PhaseEvent =
  | { readonly type: 'submit'; readonly playerId: string; readonly action: PlayerAction }
  | { readonly type: 'resolved'; readonly results: Readonly<Record<string, PlayerResult>> };

/** Why a player sleeps through a turn. Q-046: the feed labels these turns "ระหว่างคุณหลับ". */
export type SleepReason = 'exhausted' | 'night_rest';

/** `exhausted`: the forced REST after Stamina 0 (+6). `clinic`: a turn recovering at the clinic after HP 0. */
export type RecoveryKind = 'night_rest' | 'day_rest' | 'exhausted' | 'clinic';

export type PhaseLogEntry =
  | { readonly type: 'submitted'; readonly at: TurnPoint; readonly playerId: string; readonly action: PlayerAction; readonly replaced: boolean }
  | {
      readonly type: 'phase_closed';
      readonly at: TurnPoint;
      readonly actions: Readonly<Record<string, PlayerAction>>;
      /** Players who sleep through this turn (Q-046). */
      readonly asleep: readonly { readonly playerId: string; readonly reason: SleepReason }[];
      readonly unconscious: readonly string[];
    }
  /** The Drowsy +1 Stamina on an action (not on a rest). */
  | { readonly type: 'drowsy_cost'; readonly at: TurnPoint; readonly playerId: string; readonly stamina: { readonly before: number; readonly after: number } }
  /** Stayed awake through NOCTHERION: Drowsy for `drowsy.day`. */
  | { readonly type: 'drowsy'; readonly at: TurnPoint; readonly playerId: string; readonly drowsy: Drowsy }
  /** Q-087 make-up sleep in EOSORIA: Drowsy ends from the next turn. */
  | { readonly type: 'drowsy_cleared'; readonly at: TurnPoint; readonly playerId: string }
  | {
      readonly type: 'recovered';
      readonly at: TurnPoint;
      readonly playerId: string;
      readonly kind: RecoveryKind;
      readonly site: RestSite | null;
      readonly stamina: { readonly before: number; readonly gain: number; readonly after: number };
      readonly hp: { readonly before: number; readonly gain: number; readonly after: number };
    }
  /** GEN-069 TRAIN at the guild: Max HP up (HP unchanged). */
  | { readonly type: 'trained'; readonly at: TurnPoint; readonly playerId: string; readonly hpMax: { readonly before: number; readonly after: number } }
  | { readonly type: 'exhausted'; readonly at: TurnPoint; readonly playerId: string; readonly sleepsAt: TurnPoint }
  /** HP 0: out cold through the next turn. */
  | { readonly type: 'knocked_out'; readonly at: TurnPoint; readonly playerId: string }
  /** Not executed while out cold: carried to the central clinic (the server moves them and takes half the coins). */
  | { readonly type: 'carried_to_clinic'; readonly at: TurnPoint; readonly playerId: string; readonly turns: number }
  /** The clinic rest is over: awake again at full Max HP. */
  | { readonly type: 'clinic_released'; readonly at: TurnPoint; readonly playerId: string; readonly hp: number }
  /** Executed while out cold: an Astral Spirit for good. */
  | { readonly type: 'died'; readonly at: TurnPoint; readonly playerId: string }
  | { readonly type: 'phase_started'; readonly at: TurnPoint }
  | { readonly type: 'finale'; readonly at: TurnPoint }
  | { readonly type: 'game_over'; readonly at: TurnPoint; readonly reason: 'all_dead' };

export type PhaseErrorCode =
  | 'not_collecting'
  | 'not_resolving'
  | 'game_ended'
  | 'unknown_player'
  | 'cannot_act'
  | 'secret_quota_used'
  /** GEN-069 (Q-088): already trained today. */
  | 'train_used'
  /** GEN-069 (Q-088): Max HP is at the TRAIN ceiling. */
  | 'train_cap'
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
  /** The character's own Max HP; absent = RULES.hpMax. */
  readonly hpMax?: number;
  readonly stamina?: number;
  readonly karma?: number;
  readonly sleepBonus?: number;
}
