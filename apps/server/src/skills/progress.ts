import { TURNS_PER_PERIOD, type PhaseActionsLog, type PhaseState, type PlayerResult } from '@isekai/rules';
import { and, eq } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { LocationRecord } from '../assets/model.ts';
import { heldItemsOf, skillsInGame } from '../crossplayer/items.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, periodKarma } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { locationSnapshot } from '../visibility/store.ts';
import { checkSkillUnlocks, recordSkillActivity, revealAtLibrary, type SkillTime } from './store.ts';

/**
 * Unlock progress the server counts by itself (GEN-055), from what each turn did:
 * - `recordTurnProgress` (the AI GM loop's apply): every resolved action counts `act`, `verb:<TAG>` for its verb
 *   tags, `good` / `evil` (+ `good_public` / `evil_secret`) from its karma change; an INVESTIGATE that succeeds
 *   at a LIBRARY place reveals the conditions whose tags hold the action's topic tags.
 * - `withPeriodEndEffects` (the room, on the period's last turn): `end_of_period` restores (Silver Rosary of
 *   Hearth in a SAFE_ZONE, Clear Horizon / Lead-Core Pocket Watch when the karma did not change), capped at max.
 * - `settleTurnProgress` (the room, after the turn is saved): the period's start karma, `karma_steady` at the
 *   period's end, then the unlock checks (karma changed this turn).
 */

/** When each `end_of_period` restore of the data applies (its Note column): in a SAFE_ZONE, or with karma unchanged. */
export const END_OF_PERIOD_WHEN: Readonly<Record<string, 'safe_zone' | 'karma_steady'>> = {
  // "เมื่อจบช่วงใน SAFE_ZONE"
  'Silver Rosary of Hearth': 'safe_zone',
  // "เมื่อ karma ไม่เปลี่ยนในช่วงนั้น"
  'Clear Horizon': 'karma_steady',
  // "restore เมื่อ karma ไม่เปลี่ยน"
  'Lead-Core Pocket Watch': 'karma_steady',
};

const LIBRARY_TAG = 'LIBRARY';
const SAFE_ZONE_TAG = 'SAFE_ZONE';

/** The Location row of a presence id: the id as a Location name, else the scenario place's name. */
function locationRecord(db: DbOrTx, assets: GameAssets, gameId: string, locationId: string): { record: LocationRecord | undefined; safe: boolean } {
  const place = getGameScenario(db, gameId)?.locations.find((l) => l.id === locationId);
  const record = assets.location(locationId) ?? (place ? assets.location(place.name) : undefined);
  // A scenario place the sheet has no row for: its own safety says whether it is safe.
  return { record, safe: record ? record.tags.includes(SAFE_ZONE_TAG) : place?.safety === 'safe' };
}

/** Whether the scenario place `locationId` is a SAFE_ZONE (its Location row's tag, else its own safety). */
export function isSafeZone(db: DbOrTx, assets: GameAssets, gameId: string, locationId: string): boolean {
  return locationRecord(db, assets, gameId, locationId).safe;
}

export function recordTurnProgress(db: DbOrTx, assets: GameAssets, gameId: string, log: PhaseActionsLog, at: SkillTime, investigating: ReadonlySet<string>): void {
  for (const o of log.outcomes) {
    if (o.status !== 'resolved') continue;
    const karma = o.log.karma.delta;
    const activities = [
      'act',
      ...(o.log.tagging?.verbTags ?? []).map((t) => `verb:${t}`),
      ...(karma > 0 ? ['good', ...(o.visibility === 'public' ? ['good_public'] : [])] : []),
      ...(karma < 0 ? ['evil', ...(o.visibility === 'secret' ? ['evil_secret'] : [])] : []),
    ];
    for (const activity of activities) recordSkillActivity(db, assets, o.actorId, activity, at);
    const succeeded = o.log.degree === 'success' || o.log.degree === 'crit';
    if (succeeded && investigating.has(o.actionId) && locationRecord(db, assets, gameId, o.locationId).record?.tags.includes(LIBRARY_TAG)) {
      revealAtLibrary(db, assets, o.actorId, [...(o.log.tagging?.verbTags ?? []), ...(o.log.tagging?.targetTags ?? [])], at);
    }
  }
}

const isPeriodEnd = (state: PhaseState) => state.turn === TURNS_PER_PERIOD;

/** The karma a player started the closing period with (stored at the period's first turn; else the state's). */
function periodStart(db: DbOrTx, state: PhaseState, memberId: string): number {
  const row = db
    .select({ start: periodKarma.start })
    .from(periodKarma)
    .where(and(eq(periodKarma.memberId, memberId), eq(periodKarma.day, state.day), eq(periodKarma.period, state.phase)))
    .get();
  return row?.start ?? state.players[memberId]!.karma;
}

export function withPeriodEndEffects(
  db: DbOrTx,
  assets: GameAssets,
  gameId: string,
  state: PhaseState,
  results: Readonly<Record<string, PlayerResult>>,
): Record<string, PlayerResult> {
  const out: Record<string, PlayerResult> = { ...results };
  if (!isPeriodEnd(state)) return out;
  const skills = skillsInGame(db, gameId);
  for (const [memberId, locationId] of locationSnapshot(db, gameId)) {
    const player = state.players[memberId];
    if (!player || player.condition === 'unconscious') continue;
    const sources = [
      ...(skills.get(memberId) ?? []).flatMap((s) => (assets.ability(s.name) ? [{ name: s.name, effects: assets.ability(s.name)!.effects }] : [])),
      ...heldItemsOf(db, gameId, memberId).flatMap((i) => (assets.item(i.name) ? [{ name: i.name, effects: assets.item(i.name)!.effects }] : [])),
    ];
    const safe = locationRecord(db, assets, gameId, locationId).safe;
    const karmaNow = out[memberId]?.karma ?? player.karma;
    const steady = karmaNow === periodStart(db, state, memberId);
    let hp = 0;
    let stamina = 0;
    for (const source of sources) {
      const when = END_OF_PERIOD_WHEN[source.name];
      if (!when || (when === 'safe_zone' && !safe) || (when === 'karma_steady' && !steady)) continue;
      for (const e of source.effects) {
        if (e.type !== 'restore' || e.duration.unit !== 'end_of_period') continue;
        if (e.stats.includes('HP')) hp += e.value;
        if (e.stats.includes('Stamina')) stamina += e.value;
      }
    }
    if (hp === 0 && stamina === 0) continue;
    const r = out[memberId] ?? {};
    out[memberId] = {
      ...r,
      ...(hp > 0 ? { hp: Math.min(state.hpMax, Math.max(r.hp ?? player.hp, 0) + hp) } : {}),
      ...(stamina > 0 ? { stamina: Math.min(state.staminaMax, (r.stamina ?? player.stamina) + stamina) } : {}),
    };
  }
  return out;
}

/** After the turn is saved: the period's start karma (first turn), `karma_steady` (last turn), then the unlock checks. */
export function settleTurnProgress(db: DbOrTx, assets: GameAssets, gameId: string, closed: PhaseState, now: number): void {
  const at: SkillTime = { day: closed.day, period: closed.phase, now };
  for (const memberId of closed.order) {
    if (!closed.players[memberId]) continue;
    const karma = db.select({ karma: character.karma }).from(character).where(eq(character.memberId, memberId)).get()?.karma;
    if (karma === undefined) continue;
    // The karma before this turn is the state's (kept up to date from each turn's results).
    db.insert(periodKarma).values({ memberId, day: closed.day, period: closed.phase, start: closed.players[memberId]!.karma }).onConflictDoNothing().run();
    if (isPeriodEnd(closed) && karma === periodStart(db, closed, memberId)) recordSkillActivity(db, assets, memberId, 'karma_steady', at);
    else checkSkillUnlocks(db, assets, memberId, at);
  }
}
