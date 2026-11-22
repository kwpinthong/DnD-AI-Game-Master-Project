/**
 * Cross-player rules (GEN-060, Rules Spec GEN-042 §10): one phase's actions are put in order
 * (§10.5), then applied one by one against the state the earlier ones left (§10.2), so a move that
 * resolves first takes its player out of reach. Every value is plain JSON so a phase replays.
 */
import type {
  ActorState,
  NpcState,
  ProposalError,
  ProposalErrorCode,
  ResolutionLog,
  ResolutionProposal,
  Severity,
} from '../resolution/types.ts';
import type { TagContext } from '../resolution/tags.ts';
import type { PeriodWeather } from '../weather.ts';

/** A player character in the phase: the resolution actor state plus what cross-player rules need. */
export interface PlayerState extends ActorState {
  /** Seat order (join order): the last tie-break of the phase order. Lower goes first. */
  readonly seat: number;
  /** Ids of owned items / skills tagged `reach: remote` (spec §10.2), e.g. a cursed doll. */
  readonly remoteReach: readonly string[];
  /**
   * GEN-070, from the day / period engine: `exhausted` (forced REST this turn: damage on them ×1.3),
   * `recovering` (at the clinic after HP 0: may be hit or robbed, never executed, Q-257). Absent = neither; HP 0 = out cold.
   */
  readonly crisis?: 'exhausted' | 'recovering';
}

/** GEN-070: damage on an exhausted target ×1.3, rounded toward zero like ×1.5 (GEN-042). */
export const EXHAUSTED_DAMAGE_SCALE = 1.3;

export interface CrossPlayerState {
  readonly players: Readonly<Record<string, PlayerState>>;
  readonly npcs: Readonly<Record<string, NpcState>>;
  /** GEN-069: `ResolutionInput.publicRepScale` by the location id the actor acts at (the fountain 1.5). */
  readonly publicRepScale?: Readonly<Record<string, number>>;
}

/**
 * What A means to do to B. `rescue` and `steal` may target an unconscious player (spec §10.2); `execute`
 * only targets one (GEN-070: a success kills them for good, an Astral Spirit).
 */
export const PLAYER_INTENTS = ['harm', 'steal', 'help', 'give', 'rescue', 'execute'] as const;
export type PlayerIntent = (typeof PLAYER_INTENTS)[number];

/** Effects of A's action on the target player B. Items move between the two only. */
export interface PlayerEffects {
  readonly damage: Severity | null;
  readonly heal: Severity | null;
  /** Item id B owns that moves to A (steal). */
  readonly takeItem: string | null;
  /** Item id A owns that moves to B (give). */
  readonly giveItem: string | null;
}

/** A judged item / skill of the target the AI cites (≤ 1, capped by its tier). */
export interface TargetGearRef {
  readonly ref: string;
  readonly value: number;
}

export interface PlayerTargeting {
  readonly player: string;
  readonly intent: PlayerIntent;
  /** Owned item / skill with `reach: remote` A uses when B may be elsewhere; null = same place only. */
  readonly reachRef: string | null;
  /** B's item / skill that makes B harder to hit (`defense(B)`, spec §10.3). */
  readonly defenseRef: TargetGearRef | null;
  /** B's item / skill that helps B notice a Secret (spec §10.4). */
  readonly perceptionRef: TargetGearRef | null;
  readonly onSuccess: PlayerEffects;
  readonly onFail: PlayerEffects;
}

/**
 * What the actor is doing this phase, for B's awareness when observing (spec §10.4):
 * `watch` +3, `asleep` -5 (rest at night or exhausted), `normal` 0.
 */
export type Awareness = 'watch' | 'asleep' | 'normal';

/** One player's action in the phase, as the AI GM proposed it (GEN-057 builds these). */
export interface PhaseAction {
  readonly actorId: string;
  /** Actor side: cost, check, modifiers, Karma / Reputation, NPC effects. `target` stays null when a player is targeted. */
  readonly proposal: ResolutionProposal;
  /** A player target, or null. A `pvp` check needs one. */
  readonly targetPlayer: PlayerTargeting | null;
  /** Scenario location id the actor moves to when the action succeeds; null = stays. */
  readonly moveTo: string | null;
  readonly awareness: Awareness;
}

export interface PhaseActionsInput {
  readonly state: CrossPlayerState;
  readonly actions: readonly PhaseAction[];
  /** Each player's tag sources and today's uses (GEN-064), by player id. */
  readonly tags?: Readonly<Record<string, TagContext>>;
  /** The period's weather (GEN-068); an actor is outdoor when their place is one of `outdoorLocationIds` as they act. */
  readonly weather?: { readonly current: PeriodWeather; readonly outdoorLocationIds: readonly string[] };
}

// --- Order (spec §10.5) ---

export interface PriorityRoll {
  readonly playerId: string;
  readonly d20: number;
  /** floor(Stamina / 5) from the phase-start snapshot. */
  readonly staminaBonus: number;
  /** stat(actor, 'priority'). */
  readonly stat: number;
  readonly priority: number;
}

export interface RollOff {
  readonly round: number;
  readonly rolls: readonly { readonly playerId: string; readonly d20: number }[];
}

export interface OrderLog {
  /** Player ids, first to act first. */
  readonly order: readonly string[];
  readonly priorities: readonly PriorityRoll[];
  readonly rollOffs: readonly RollOff[];
}

// --- Outcomes ---

/** `target_dead`: executed by an earlier action of the same phase (GEN-070). */
export type NoTargetReason = 'not_same_place' | 'target_unconscious' | 'target_dead';

export interface TargetResult {
  readonly playerId: string;
  readonly hp: { readonly before: number; readonly damage: number; readonly heal: number; readonly after: number };
  /** Items that left B (to A) and reached B (from A). */
  readonly itemsLost: readonly string[];
  readonly itemsGained: readonly string[];
  /** B rolled to notice a Secret action: d20 + modifier vs A's total (tie = unseen). */
  readonly observation: { readonly d20: number; readonly modifier: number; readonly total: number; readonly noticed: boolean } | null;
  /** B knows who did it: the action was Public, or B noticed the Secret (spec §10.1, §10.4). */
  readonly knowsActor: boolean;
  /** GEN-070: a successful EXECUTE on B out cold; present only then. */
  readonly executed?: true;
}

export type ActionOutcome =
  | {
      readonly status: 'resolved';
      readonly actionId: string;
      readonly actorId: string;
      readonly visibility: ResolutionProposal['visibility'];
      /** Where the actor was when the action resolved. */
      readonly locationId: string;
      /** memberId → locationId of every player when the action resolved, for witness lists. */
      readonly locations: Readonly<Record<string, string>>;
      readonly log: ResolutionLog;
      readonly target: TargetResult | null;
      readonly moved: { readonly from: string; readonly to: string } | null;
    }
  | {
      /** The target was out of reach at the actor's turn: no roll, the actor pays general 3 (spec §10.2). */
      readonly status: 'no_target';
      readonly actionId: string;
      readonly actorId: string;
      readonly visibility: ResolutionProposal['visibility'];
      readonly locationId: string;
      readonly locations: Readonly<Record<string, string>>;
      readonly targetId: string;
      readonly reason: NoTargetReason;
      readonly stamina: { readonly before: number; readonly net: number; readonly after: number };
    }
  | {
      /** The actor was knocked out by an earlier action this phase and does not act. */
      readonly status: 'skipped';
      readonly actionId: string;
      readonly actorId: string;
      readonly reason: 'actor_unconscious';
    };

export interface PhaseActionsLog {
  readonly input: PhaseActionsInput;
  /** Every die in the order rolled: priority d20s, roll-offs, then each action's dice. */
  readonly rolls: readonly number[];
  readonly order: OrderLog;
  readonly outcomes: readonly ActionOutcome[];
}

export type CrossPlayerErrorCode =
  | ProposalErrorCode
  | 'unknown_actor'
  | 'duplicate_actor'
  | 'unknown_target'
  | 'target_is_actor'
  | 'target_unconscious'
  /** GEN-070 / Q-257: EXECUTE on a player recovering at the clinic. */
  | 'target_recovering'
  /** GEN-070: EXECUTE only on a player out cold (HP 0). */
  | 'execute_needs_unconscious'
  | 'unknown_intent'
  | 'reach_not_remote'
  | 'pvp_without_target'
  | 'player_target_with_npc_target';

export interface CrossPlayerError extends Omit<ProposalError, 'code'> {
  readonly code: CrossPlayerErrorCode;
  /** Index of the action in `actions`. */
  readonly action: number;
}

export type PhaseActionsResult =
  | { readonly ok: true; readonly state: CrossPlayerState; readonly log: PhaseActionsLog }
  | { readonly ok: false; readonly errors: readonly CrossPlayerError[] };
