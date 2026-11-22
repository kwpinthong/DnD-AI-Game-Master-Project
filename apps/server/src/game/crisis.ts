import { OMEN_MAX_LENGTH, type AstralView, type RoomOmenCode } from '@isekai/protocol';
import { NIGHT_PERIOD, coinsAfterClinic, type PhaseLogEntry, type PhaseState } from '@isekai/rules';
import { and, eq, inArray } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, roomEntry, travelPending } from '../db/schema.ts';
import { activeMembers } from './service.ts';
import { getGameScenario } from '../scenario/store.ts';
import { ASTRAL_PLANE, moveCharacter, presencesInGame, type PresenceRow } from '../visibility/store.ts';
import { LOCATION_TAG, placeTags } from './location-actions.ts';

/**
 * GEN-070 Crisis & death on the server (System_Rules "Stamina 0 / HP 0 / Permadeath"; the numbers live in the
 * phase engine, @isekai/rules `CRISIS`):
 * - carried to the clinic: the character goes to the central clinic (the scenario place tagged CLINIC) and
 *   keeps half their coins, rounded down;
 * - dead for good: the Astral Spirit's presence goes to `ASTRAL_PLANE` (nobody meets, targets or witnesses
 *   it there), and it gets the public feed of every place (`astralMembers` in the room's recipients, Q-192);
 * - the omen (Q-193): one sentence (≤ 200) a night in NOCTHERION to one living player, chosen by appearance.
 */

/** The central clinic: the first scenario place whose Location row is tagged CLINIC; null = the scenario has none. */
export function clinicLocationId(db: DbOrTx, assets: GameAssets, gameId: string): string | null {
  const scenario = getGameScenario(db, gameId);
  return scenario?.locations.find((l) => placeTags(scenario, assets, l.id).includes(LOCATION_TAG.clinic))?.id ?? null;
}

/** What the engine's crisis log of the turn writes (after the feed's witnesses were taken). */
export function applyCrisisLog(db: DbOrTx, assets: GameAssets, gameId: string, log: readonly PhaseLogEntry[], now: number): void {
  for (const e of log) {
    if (e.type !== 'carried_to_clinic' && e.type !== 'died') continue;
    // A trip under way ends with them (a carried player is not walking anywhere either).
    db.delete(travelPending).where(eq(travelPending.memberId, e.playerId)).run();
    if (e.type === 'died') {
      moveCharacter(db, e.playerId, ASTRAL_PLANE, now);
      continue;
    }
    const clinic = clinicLocationId(db, assets, gameId);
    if (clinic !== null) moveCharacter(db, e.playerId, clinic, now);
    const coins = db.select({ coins: character.coins }).from(character).where(eq(character.memberId, e.playerId)).get()?.coins ?? 0;
    db.update(character).set({ coins: coinsAfterClinic(coins), updatedAt: now }).where(eq(character.memberId, e.playerId)).run();
  }
}

/** The game's Astral Spirits (seat order). */
export function astralMembers(state: PhaseState): string[] {
  return state.order.filter((id) => state.players[id]!.condition === 'astral_spirit');
}

const playing = (state: PhaseState) => state.status === 'collecting' || state.status === 'resolving';

function omenSentTonight(db: DbOrTx, gameId: string, memberId: string, day: number): boolean {
  return (
    db
      .select({ id: roomEntry.id })
      .from(roomEntry)
      .where(and(eq(roomEntry.gameId, gameId), eq(roomEntry.kind, 'omen'), eq(roomEntry.fromMemberId, memberId), eq(roomEntry.day, day)))
      .get() !== undefined
  );
}

/** Placed characters of active players who are not Astral Spirits. */
function livingPresences(db: DbOrTx, gameId: string): PresenceRow[] {
  const active = new Set(activeMembers(db, gameId).filter((m) => m.role === 'player').map((m) => m.id));
  return presencesInGame(db, gameId).filter((p) => active.has(p.memberId) && p.locationId !== ASTRAL_PLANE);
}

/** Living players a spirit may send the omen to: their presence ref and appearance (never the real name, Q-193). */
function omenTargets(db: DbOrTx, gameId: string): { ref: string; label: string }[] {
  const live = livingPresences(db, gameId);
  if (live.length === 0) return [];
  const looks = new Map(
    db
      .select({ memberId: character.memberId, appearance: character.appearance })
      .from(character)
      .where(inArray(character.memberId, live.map((p) => p.memberId)))
      .all()
      .map((c) => [c.memberId, c.appearance]),
  );
  return live.map((p) => ({ ref: p.ref, label: looks.get(p.memberId) ?? '' }));
}

/** `RoomState.you.astral` of `memberId`; null = not an Astral Spirit. */
export function astralViewOf(db: DbOrTx, gameId: string, state: PhaseState, memberId: string): AstralView | null {
  const p = state.players[memberId];
  if (p?.condition !== 'astral_spirit') return null;
  const since = p.diedAt ?? { day: state.day, phase: state.phase, turn: state.turn };
  const canSend = playing(state) && state.phase === NIGHT_PERIOD && !omenSentTonight(db, gameId, memberId, state.day);
  return { since, omen: { canSend, targets: omenTargets(db, gameId) } };
}

/** Why `memberId` may not send this omen now; otherwise the target's member id. */
export function omenCheck(
  db: DbOrTx,
  gameId: string,
  state: PhaseState,
  memberId: string,
  input: { to: string; text: string },
): { ok: false; code: RoomOmenCode } | { ok: true; to: string } {
  if (!playing(state)) return { ok: false, code: 'game_ended' };
  if (state.players[memberId]?.condition !== 'astral_spirit') return { ok: false, code: 'not_astral' };
  if (input.text.length === 0) return { ok: false, code: 'empty' };
  if ([...input.text].length > OMEN_MAX_LENGTH) return { ok: false, code: 'too_long' };
  if (state.phase !== NIGHT_PERIOD) return { ok: false, code: 'not_noctherion' };
  if (omenSentTonight(db, gameId, memberId, state.day)) return { ok: false, code: 'already_sent' };
  const target = livingPresences(db, gameId).find((p) => p.ref === input.to);
  if (!target) return { ok: false, code: 'unknown_target' };
  return { ok: true, to: target.memberId };
}
