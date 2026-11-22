import type { EndingPath, PlayerEndingOutcome } from '@isekai/protocol';
import type { PhaseState } from '@isekai/rules';
import { and, eq } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import { heldItemsOf, skillsInGame } from '../crossplayer/items.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, gameEnding, gameEventState } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { isSafeZone } from '../skills/progress.ts';
import { strategyOutcomes, strategyParticipants } from '../strategy/store.ts';
import { getEventOutcomes } from '../timeline/store.ts';
import { locationSnapshot } from '../visibility/store.ts';
import { decideEnding, evilSideMax, goodSideMin, type EndingPlayerFacts } from './ending.ts';

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

/** What the Day-10 plans (Day10_Strategies) give for surviving day 12. */
export interface StrategyRefuges {
  /** memberId → S-level buffs a plan gave them (e.g. D10-S1 'แสงรุ่งอรุณคืนเมือง', D10-S3 'พันธสัญญาจันทราโลหิต'). */
  buffs: ReadonlyMap<string, readonly string[]>;
  /** Scenario place ids a plan made a refuge (e.g. D10-S1 the church, D10-S2 the clinic when day 5 went Good). */
  places: ReadonlySet<string>;
}

/**
 * What a plan that succeeded gives (Day10_Strategies Success_Effect / Ending_Link, Q-203): an S-level buff to its
 * participants (`side`: only those on that side of the karma tiers at the end), and a refuge place (by its
 * scenario place name; `needsDay5Good`: only when day 5 went Good).
 */
const PLAN_REWARDS: Readonly<Record<string, { buff?: string; side?: 'evil'; refuge?: string; needsDay5Good?: boolean }>> = {
  'D10-S1': { buff: 'แสงรุ่งอรุณคืนเมือง', refuge: 'โบสถ์' },
  'D10-S2': { refuge: 'สถานพยาบาลกลาง', needsDay5Good: true },
  'D10-S3': { buff: 'พันธสัญญาจันทราโลหิต', side: 'evil' },
};

/**
 * Whether day 5 went Good: the AI GM set the day 5 event's outcome (players stepped in) and the outcome names
 * the Good (or Good/Neutral) side of its interventionEffects first. The default (drift) and Evil are not Good.
 */
export function day5WentGood(db: DbOrTx, gameId: string): boolean {
  const day5 = getEventOutcomes(db, gameId).find((e) => e.day === 5);
  return day5 !== undefined && day5.intervened && /^\s*(good|neutral)\b/i.test(day5.outcome);
}

/**
 * The buffs and refuges of the Day-10 plans that succeeded (GEN-093): read from the plan outcomes written when
 * the night of day 10 ended and from who took part. A failed plan (or the drift) gives nothing.
 */
export function strategyRefuges(db: DbOrTx, assets: GameAssets, gameId: string): StrategyRefuges {
  const succeeded = new Set(strategyOutcomes(db, gameId).filter((o) => o.outcome === 'success').map((o) => o.strategyId));
  const buffs = new Map<string, string[]>();
  const places = new Set<string>();
  if (succeeded.size === 0) return { buffs, places };
  const evilFrom = evilSideMax(assets.karmaTiers);
  const karmaOf = (memberId: string) => db.select({ karma: character.karma }).from(character).where(eq(character.memberId, memberId)).get()?.karma ?? 0;
  for (const p of strategyParticipants(db, gameId)) {
    const buff = succeeded.has(p.strategyId) ? PLAN_REWARDS[p.strategyId]?.buff : undefined;
    if (buff === undefined) continue;
    if (PLAN_REWARDS[p.strategyId]!.side === 'evil' && karmaOf(p.memberId) > evilFrom) continue;
    const own = buffs.get(p.memberId) ?? [];
    if (!own.includes(buff)) buffs.set(p.memberId, [...own, buff]);
  }
  const locations = getGameScenario(db, gameId)?.locations ?? [];
  for (const id of succeeded) {
    const reward = PLAN_REWARDS[id];
    if (reward?.refuge === undefined || (reward.needsDay5Good && !day5WentGood(db, gameId))) continue;
    for (const l of locations) if (l.name === reward.refuge) places.add(l.id);
  }
  return { buffs, places };
}

/** What the ending rule reads for each player of the engine state. */
export function endingFacts(db: DbOrTx, assets: GameAssets, gameId: string, state: PhaseState): EndingPlayerFacts[] {
  const places = locationSnapshot(db, gameId);
  const skills = skillsInGame(db, gameId);
  const refuges = strategyRefuges(db, assets, gameId);
  const goodFrom = goodSideMin(assets.karmaTiers);
  return state.order.map((memberId) => {
    const place = places.get(memberId);
    const karma = db.select({ karma: character.karma }).from(character).where(eq(character.memberId, memberId)).get()?.karma ?? state.players[memberId]?.karma ?? 0;
    return {
      memberId,
      protectedBy: [...protectionsOf(db, assets, gameId, memberId, skills), ...(refuges.buffs.get(memberId) ?? [])],
      inSafeZone: place !== undefined && (isSafeZone(db, assets, gameId, place) || refuges.places.has(place)),
      goodAligned: karma >= goodFrom,
      dead: state.players[memberId]?.condition === 'astral_spirit',
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
