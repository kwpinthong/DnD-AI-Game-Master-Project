import type { ActionVisibility } from '@isekai/protocol';
import type { PhasePoint, PhaseState, PlayerResult } from '@isekai/rules';

/**
 * The hand-off to the AI GM phase loop (GEN-057). When a phase closes, the room calls `resolve` once with the
 * actions that stood; whatever it returns is published through the visibility layer and fed to the day /
 * phase engine as its `resolved` event. Turn order and cross-player effects (GEN-060) live behind it too.
 */
export interface PhaseResolver {
  resolve(input: ClosedPhase): Promise<PhaseResolution>;
}

export interface ClosedAction {
  readonly memberId: string;
  readonly text: string;
  readonly visibility: ActionVisibility;
  /** Where the actor was when the phase closed; null = not placed. */
  readonly locationId: string | null;
}

export interface ClosedPhase {
  readonly gameId: string;
  readonly at: PhasePoint;
  /** Seat order. Players who could not act (exhausted, unconscious) have no entry. */
  readonly actions: readonly ClosedAction[];
  /** The engine state at the close (status `resolving`). */
  readonly state: PhaseState;
}

/**
 * - `feed`: happened at `locationId` (null = the whole town); seen by the actor and by everyone there at
 *   publish time (`witnessesOf`). A Secret action's outcome belongs in the actor's narration instead.
 * - `narration`: private text for one player only.
 */
export type ResolutionEntry =
  | { readonly kind: 'feed'; readonly locationId: string | null; readonly actorMemberId: string | null; readonly text: string }
  | { readonly kind: 'narration'; readonly memberId: string; readonly text: string };

export interface PhaseResolution {
  /** Per member; missing members keep their HP / Stamina (see `PlayerResult`). */
  readonly results?: Readonly<Record<string, PlayerResult>>;
  readonly entries?: readonly ResolutionEntry[];
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
