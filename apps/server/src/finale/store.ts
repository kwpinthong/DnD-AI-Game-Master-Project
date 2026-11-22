import type { EndingPath, PlayerEndingOutcome } from '@isekai/protocol';
import type { PhaseState } from '@isekai/rules';
import { and, eq } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import { heldItemsOf, skillsInGame } from '../crossplayer/items.ts';
import type { DbOrTx } from '../db/client.ts';
import { gameEnding, gameEventState } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { isSafeZone } from '../skills/progress.ts';
import { locationSnapshot } from '../visibility/store.ts';
import { decideEnding, type EndingPlayerFacts } from './ending.ts';

/**
 * The game's ending (GEN-059): the path the AI GM declares during the finale event, the facts the ending
 * rule reads at the end, and the decision stored once in `game_ending`.
 */

export type DeclaredPath = Exclude<EndingPath, 'none'>;

const RANKS_THAT_PROTECT: ReadonlySet<string> = new Set(['S', 'SS']);
/** A skill / item protects when it is S / SS and defends (Match_Verb_Tags). */
const PROTECTING_VERBS: ReadonlySet<string> = new Set(['DEFEND', 'PROTECT', 'BARRIER']);

const protects = (record: { rank: string; matchVerbTags: readonly string[] } | undefined) =>
  record !== undefined && RANKS_THAT_PROTECT.has(record.rank) && record.matchVerbTags.some((t) => PROTECTING_VERBS.has(t));

/** The finale event of the game's scenario, when there is one. */
function finaleEventId(db: DbOrTx, gameId: string): string | undefined {
  return getGameScenario(db, gameId)?.timeline.find((e) => e.kind === 'finale')?.id;
}

/** The AI GM's `endingPath` while the finale event is active; false when it is not active (nothing written). */
export function setEndingPath(db: DbOrTx, gameId: string, path: DeclaredPath, now: number): boolean {
  const eventId = finaleEventId(db, gameId);
  if (!eventId) return false;
  const result = db
    .update(gameEventState)
    .set({ endingPath: path, updatedAt: now })
    .where(and(eq(gameEventState.gameId, gameId), eq(gameEventState.eventId, eventId), eq(gameEventState.status, 'active')))
    .run();
  return result.changes > 0;
}

export function declaredEndingPath(db: DbOrTx, gameId: string): DeclaredPath | null {
  const eventId = finaleEventId(db, gameId);
  if (!eventId) return null;
  const row = db
    .select({ path: gameEventState.endingPath })
    .from(gameEventState)
    .where(and(eq(gameEventState.gameId, gameId), eq(gameEventState.eventId, eventId)))
    .get();
  return row?.path ?? null;
}

/** S / SS protection each player holds now (skill names, then item English names). */
export function protectionsOf(db: DbOrTx, assets: GameAssets, gameId: string, memberId: string, skills = skillsInGame(db, gameId)): string[] {
  return [
    ...(skills.get(memberId) ?? []).filter((s) => protects(assets.ability(s.name))).map((s) => s.name),
    ...heldItemsOf(db, gameId, memberId).flatMap((i) => {
      const record = assets.item(i.name);
      return protects(record) ? [record!.nameEn] : [];
    }),
  ];
}

/** What the ending rule reads for each player of the engine state. */
export function endingFacts(db: DbOrTx, assets: GameAssets, gameId: string, state: PhaseState): EndingPlayerFacts[] {
  const places = locationSnapshot(db, gameId);
  const skills = skillsInGame(db, gameId);
  return state.order.map((memberId) => {
    const place = places.get(memberId);
    return {
      memberId,
      protectedBy: protectionsOf(db, assets, gameId, memberId, skills),
      inSafeZone: place !== undefined && isSafeZone(db, assets, gameId, place),
    };
  });
}

export interface GameEnding {
  reason: 'finale' | 'game_over';
  path: EndingPath;
  outcomes: Record<string, PlayerEndingOutcome>;
  narrated: boolean;
}

export function getEnding(db: DbOrTx, gameId: string): GameEnding | null {
  const row = db.select().from(gameEnding).where(eq(gameEnding.gameId, gameId)).get();
  return row ? { reason: row.reason, path: row.path, outcomes: row.outcomes, narrated: row.narratedAt !== null } : null;
}

/**
 * Decides and stores the ending of a game whose state just ended (status `finale` / `game_over`), in the
 * caller's transaction. Once stored it never changes (a second call keeps the first decision).
 */
export function settleEnding(db: DbOrTx, assets: GameAssets, gameId: string, ended: PhaseState, now: number): GameEnding {
  const existing = getEnding(db, gameId);
  if (existing) return existing;
  const reason = ended.status === 'game_over' ? 'game_over' : 'finale';
  const decision = decideEnding({ reason, declaredPath: declaredEndingPath(db, gameId), players: endingFacts(db, assets, gameId, ended) });
  db.insert(gameEnding).values({ gameId, reason, path: decision.path, outcomes: decision.outcomes, narratedAt: null, createdAt: now }).run();
  return { reason, ...decision, narrated: false };
}

export function markNarrated(db: DbOrTx, gameId: string, now: number): void {
  db.update(gameEnding).set({ narratedAt: now }).where(eq(gameEnding.gameId, gameId)).run();
}
