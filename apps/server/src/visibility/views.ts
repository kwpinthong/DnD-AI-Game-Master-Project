import type {
  GmCharacterView,
  NpcView,
  OtherCharacterView,
  PlaceView,
  Scenario,
  SurroundingsResponse,
} from '@isekai/protocol';
import { injuryText, karmaTitle, socialTitle, type KarmaTier } from '@isekai/rules';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { character, member } from '../db/schema.ts';
import { getCharacter } from '../game/character.ts';
import type { MemberRow } from '../game/service.ts';
import { getGameScenario } from '../scenario/store.ts';
import {
  hiddenEvidenceInGame,
  namesVisibleTo,
  npcBondsOf,
  playerBondsOf,
  presenceOf,
  presencesInGame,
  type NpcBondRow,
  type PresenceRow,
} from './store.ts';

/**
 * The visibility layer (GEN-050, GDD §1-§2; Fog of War GEN-067). Every payload for one viewer is built
 * here, so the HTTP routes and the socket events (GEN-056) share one set of rules:
 * - yourself: everything except the Karma and Reputation numbers; your own Karma word (`conduct`, Q-091)
 * - others at your place: appearance, injury word, Social Title (Title Mask); the real name only while you
 *   are allies with relationship > +9; never their Karma word
 * - Hidden Evidence: never listed to players (INVESTIGATE finds it, `discoverHiddenEvidence`)
 * - others elsewhere: nothing, not even that they exist or where they are
 * - NPCs at your place: alias until `nameRevealed` for you
 * - the Human GM: everything
 */

type CharacterRow = typeof character.$inferSelect;

/** Another character as `viewer` sees it. The caller has already checked they share a place. */
export function otherCharacterView(subject: CharacterRow, presence: PresenceRow, knowsName: boolean): OtherCharacterView {
  return {
    ref: presence.ref,
    appearance: subject.appearance,
    injury: injuryText(subject.hp),
    socialTitle: socialTitle(subject.reputation),
    name: knowsName ? subject.name : null,
  };
}

export function npcView(npc: { readonly name: string; readonly alias: string }, bond: Pick<NpcBondRow, 'nameRevealed'> | undefined): NpcView {
  const nameRevealed = bond?.nameRevealed ?? false;
  return { name: nameRevealed ? npc.name : npc.alias, nameRevealed };
}

// --- Events at a place (actions, arrivals, scene events) ---

/** Something that happens at one place. `actorMemberId` null = no player did it (scene / NPC). */
export interface PlaceEvent {
  readonly locationId: string;
  readonly actorMemberId: string | null;
  readonly visibility: 'public' | 'secret';
}

/**
 * Who sees `event`: everyone at its place in `locations` (memberId → locationId, the snapshot taken when
 * the event resolves), plus its actor. A Secret action is seen by its actor only; being noticed is GEN-060.
 * Store the result with the event: someone who arrives later must not see it.
 */
export function witnessesOf(event: PlaceEvent, locations: ReadonlyMap<string, string>): string[] {
  const witnesses = new Set<string>();
  if (event.actorMemberId !== null) witnesses.add(event.actorMemberId);
  if (event.visibility === 'public') {
    for (const [memberId, locationId] of locations) if (locationId === event.locationId) witnesses.add(memberId);
  }
  return [...witnesses];
}

export function seesEvent(viewerMemberId: string, witnesses: readonly string[]): boolean {
  return witnesses.includes(viewerMemberId);
}

/**
 * Whether a viewer at `viewerLocationId` sees something that happens at `eventLocationId`; null event
 * place = the whole town. The filter for GET /api/game/timeline if Q-080 says players see only their place.
 */
export function seesPlace(viewerLocationId: string | null, eventLocationId: string | null): boolean {
  return eventLocationId === null || eventLocationId === viewerLocationId;
}

// --- Whole payloads ---

function placeOf(scenario: Scenario | null, locationId: string): PlaceView {
  const location = scenario?.locations.find((l) => l.id === locationId);
  return { id: locationId, name: location?.name ?? locationId };
}

/** Characters of the game's active members, oldest member first. */
function charactersInGame(db: DbOrTx, gameId: string) {
  return db
    .select({ character, playerName: member.name })
    .from(character)
    .innerJoin(member, eq(member.id, character.memberId))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt)))
    .orderBy(asc(member.createdAt), sql`member.rowid`)
    .all();
}

function playerSurroundings(db: Db, me: MemberRow, karmaTiers: readonly KarmaTier[]): SurroundingsResponse {
  const you = getCharacter(db, me, karmaTiers);
  const here = presenceOf(db, me.id);
  if (!you || !here) return { view: 'player', you, place: null, people: [], npcs: [] };

  const scenario = getGameScenario(db, me.gameId);
  const presences = new Map(presencesInGame(db, me.gameId).map((p) => [p.memberId, p]));
  const others = charactersInGame(db, me.gameId).filter(
    ({ character: c }) => c.memberId !== me.id && presences.get(c.memberId)?.locationId === here.locationId,
  );
  const known = namesVisibleTo(db, me.id);
  const bonds = new Map(npcBondsOf(db, me.id).map((b) => [b.npcId, b]));

  return {
    view: 'player',
    you,
    place: placeOf(scenario, here.locationId),
    people: others.map(({ character: c }) => otherCharacterView(c, presences.get(c.memberId)!, known.has(c.memberId))),
    npcs: (scenario?.npcs ?? []).filter((n) => n.locationId === here.locationId).map((n) => npcView(n, bonds.get(n.id))),
  };
}

function gmSurroundings(db: DbOrTx, gameId: string, karmaTiers: readonly KarmaTier[]): SurroundingsResponse {
  const presences = new Map(presencesInGame(db, gameId).map((p) => [p.memberId, p]));
  const characters: GmCharacterView[] = charactersInGame(db, gameId).map(({ character: c, playerName }) => ({
    memberId: c.memberId,
    ref: presences.get(c.memberId)?.ref ?? null,
    playerName,
    name: c.name,
    appearance: c.appearance,
    personality: c.personality,
    hp: { current: c.hp, max: c.hpMax },
    stamina: { current: c.stamina, max: c.staminaMax },
    injury: injuryText(c.hp),
    socialTitle: socialTitle(c.reputation),
    reputationScore: c.reputation,
    karma: c.karma,
    conduct: karmaTitle(c.karma, karmaTiers),
    locationId: presences.get(c.memberId)?.locationId ?? null,
    knowsNamesOf: [...namesVisibleTo(db, c.memberId)],
    npcBonds: npcBondsOf(db, c.memberId).map(({ npcId, affinity, nameRevealed }) => ({ npcId, affinity, nameRevealed })),
    playerBonds: [...playerBondsOf(db, c.memberId)].map(([memberId, bond]) => ({ memberId, ...bond })),
  }));
  const evidence = hiddenEvidenceInGame(db, gameId).map(({ id, locationId, day, actorMemberId }) => ({ id, locationId, day, actorMemberId }));
  return { view: 'gm', characters, evidence };
}

/** GET /api/game/surroundings for `me`: the GM view for the Human GM, the player view for everyone else. */
export function surroundingsFor(db: Db, me: MemberRow, karmaTiers: readonly KarmaTier[]): SurroundingsResponse {
  return me.role === 'gm' ? gmSurroundings(db, me.gameId, karmaTiers) : playerSurroundings(db, me, karmaTiers);
}
