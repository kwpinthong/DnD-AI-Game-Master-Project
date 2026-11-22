import type { ActionVisibility, GmCheckView, GmFallbackCause, HitView, RollView, RoomGmStatusCode } from '@isekai/protocol';
import type { PeriodWeather, PhaseState, PlayerResult, TurnPoint } from '@isekai/rules';
import type { DbOrTx } from '../db/client.ts';

/**
 * The hand-off to the AI GM turn loop (GEN-057, `../gm/loop.ts` is the real one; tests may plug in their own).
 * Human GM approval (Q-030, GEN-058) sits between `resolve` and the room's publish transaction: in a game with
 * a Human GM the room holds the returned resolution (`RoomService.heldTurn`) and publishes it with the GM's
 * edits on approval (`../gm-console/`); the resolver does not change. When a turn closes, the room calls `resolve` once with the
 * actions that stood; whatever it returns is published through the visibility layer and fed to the day /
 * period / turn engine as its `resolved` event. Turn order and cross-player effects (GEN-060) live behind it too.
 *
 * GEN-063 time rules for the resolver: a Drowsy actor (`isDrowsy(state.players[id], state.day)`) rolls with
 * `DROWSY_STATUS` in `ActorState.statuses` (d20 -2); the +1 Stamina per action is added by the engine, so the
 * resolver's `stamina` must not include it. Karma the room does not get back is read from the character.
 */
export interface PhaseResolver {
  resolve(input: ClosedPhase): Promise<PhaseResolution>;
  /**
   * GEN-059: tells the ending of a game that just ended (its `game_ending` row is stored). Without it the
   * room uses the server's template ending.
   */
  finale?(input: { readonly gameId: string; readonly signal?: AbortSignal }): Promise<FinaleResolution>;
}

/** The ending as entries (whole-town feed + one narration per player), or why it could not be told (retry). */
export type FinaleResolution = { readonly entries: readonly ResolutionEntry[]; readonly stuck?: undefined } | { readonly stuck: ResolverStuck };

export interface ClosedAction {
  readonly memberId: string;
  readonly text: string;
  readonly visibility: ActionVisibility;
  /** REST / SLEEP this turn instead of acting. */
  readonly rest: boolean;
  /** Where the actor was when the turn closed; null = not placed. */
  readonly locationId: string | null;
  /**
   * GEN-066: this action is a trip to another zone (place id it arrives at when the turn closes). The trip's
   * Stamina is already paid; the resolver should not charge it again. null = not travelling.
   */
  readonly travelingTo: string | null;
}

export interface ClosedPhase {
  readonly gameId: string;
  readonly at: TurnPoint;
  /** Seat order. Players who could not act (exhausted, unconscious) have no entry. */
  readonly actions: readonly ClosedAction[];
  /** The engine state at the close (status `resolving`). */
  readonly state: PhaseState;
  /** Aborted when the server shuts down: stop calling the AI and return (nothing is applied). */
  readonly signal?: AbortSignal;
  /**
   * The period's weather (GEN-068), the same for the whole town; null when the room has no weather service.
   * Apply it with `weatherTagging` (crossplayer/tags.ts): Weather_Verb_Boost and the d20 / Stamina rules.
   */
  readonly weather: PeriodWeather | null;
}

/**
 * - `feed`: happened at `locationId` (null = the whole town); seen by the actor and by everyone there at
 *   publish time (`witnessesOf`). A Secret action's outcome belongs in the actor's narration instead.
 * - `narration`: private text for one player only.
 */
export type ResolutionEntry = (
  | { readonly kind: 'feed'; readonly locationId: string | null; readonly actorMemberId: string | null; readonly text: string }
  | {
      readonly kind: 'narration';
      readonly memberId: string;
      readonly text: string;
      /** Q-229 (F5): the roll of this player's own action, shown on this narration only. */
      readonly roll?: RollView;
    }
  | {
      /**
       * GEN-110: one line an NPC says. `memberId` set = said to that player alone (like a `narration`); null = said at
       * `locationId` to everyone there (like a `feed`). `text` has the names filled in; the viewer's NPC name comes at read time.
       */
      readonly kind: 'npc';
      readonly npcId: string;
      readonly npcKind: 'dialogue' | 'reaction';
      readonly locationId: string | null;
      readonly memberId: string | null;
      readonly text: string;
    }
) & {
  /** Q-177: set when the text is the server template, with why. */
  readonly fallback?: GmFallbackCause;
};

/** Why the resolver could not finish the turn (GEN-057). The turn stays closed with every action kept. */
export interface ResolverStuck {
  readonly code: RoomGmStatusCode;
  /** For players ("AI GM ติดขัด ..."). */
  readonly message: string;
  /** For the game owner and the Human GM: the reason (e.g. the monthly ceiling). */
  readonly ownerMessage: string;
}

/** Q-229: another player's act that cost `memberId` something; published as one `hit` entry for them (and the Human GM). */
export interface ResolutionHit {
  readonly memberId: string;
  readonly text: string;
  readonly hit: HitView;
}

export interface PhaseResolution {
  /** Per member; missing members keep their HP / Stamina (see `PlayerResult`). */
  readonly results?: Readonly<Record<string, PlayerResult>>;
  readonly entries?: readonly ResolutionEntry[];
  readonly hits?: readonly ResolutionHit[];
  /** Q-229: every number of each roll, for the Human GM's console (never sent to players). */
  readonly checks?: readonly GmCheckView[];
  /**
   * Writes the turn's own changes (stats, places, items, constraints, ...) inside the room's publish
   * transaction, after the entries are stored and before the engine step, so they commit together or not
   * at all (GEN-057 C6: a restart never applies a turn twice).
   */
  readonly apply?: (tx: DbOrTx) => void;
  /**
   * GEN-116: the second stage. The room starts it after the turn is published and does NOT wait for it: the next turn
   * is open meanwhile. It calls `publish` with the NPC line entries of one audience whenever they are ready (each call
   * stores and sends them, to the same recipients as the narration they follow, under this turn's day / phase / turn).
   * A failure inside is the resolver's to swallow (the turn stays complete); if it throws, the room logs it and goes on.
   */
  readonly dialogue?: (publish: (entries: readonly ResolutionEntry[]) => void) => Promise<void>;
  /** Runs after the turn is published (e.g. the day summary); a failure is logged and never blocks the game. */
  readonly after?: () => Promise<void>;
  /** Set instead of everything else when the turn could not be resolved: nothing is published or applied. */
  readonly stuck?: ResolverStuck;
}

/**
 * Stand-in until GEN-057: no stat changes. A Public action shows the people there that someone did something
 * (no names: the visibility layer decides those, and this resolver does not know them); every actor gets their
 * own action back as narration, so the feed / narration / replay path is live end to end.
 */
export const placeholderResolver: PhaseResolver = {
  async resolve({ actions }) {
    const entries: ResolutionEntry[] = [];
    for (const a of actions) {
      if (a.visibility === 'public') {
        entries.push({ kind: 'feed', locationId: a.locationId, actorMemberId: a.memberId, text: 'มีคนที่นี่ลงมือทำบางอย่าง' });
      }
      entries.push({ kind: 'narration', memberId: a.memberId, text: `คุณ${a.visibility === 'secret' ? ' (Secret)' : ''}: ${a.text}` });
    }
    return { entries };
  },
};
