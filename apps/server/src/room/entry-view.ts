import { appearanceLabels, appearanceParts, isVotableEntry, type AppearanceTraits, type NpcLineView, type PlaceView, type RoomEntry } from '@isekai/protocol';
import { and, eq } from 'drizzle-orm';
import { npcSpeaker } from '../companions/store.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, member, roomEntryRecipient } from '../db/schema.ts';
import { titleOf } from '../game/character.ts';
import { nameAsYou, youInText } from '../game/tokens.ts';
import { maskNames } from '../gm/check.ts';
import { getGameScenario } from '../scenario/store.ts';
import { ASTRAL_PLANE, namesVisibleTo, npcBondsOf } from '../visibility/store.ts';
import type { GameAssets } from '../assets/load.ts';
import { placeMap, placeOfPresence, zoneView } from '../travel/rules.ts';
import type { EntryMeta, RoomEntryRow } from './store.ts';
import { myVoteFields } from './vote.ts';

/** A scenario place as players see it (id + name + its zone when it is a Location row); null for no place (an Astral Spirit has none, GEN-070). */
export function placeViewOf(db: DbOrTx, gameId: string, locationId: string | null, assets: GameAssets): PlaceView | null {
  if (locationId === null || locationId === ASTRAL_PLANE) return null;
  const scenario = getGameScenario(db, gameId);
  const zone = placeOfPresence(placeMap(assets), scenario, locationId);
  return { id: locationId, name: scenario?.locations.find((l) => l.id === locationId)?.name ?? locationId, ...(zone ? { zone: zoneView(zone) } : {}) };
}

export function characterNameOf(db: DbOrTx, memberId: string | null): string {
  if (memberId === null) return '';
  return db.select({ name: character.name }).from(character).where(eq(character.memberId, memberId)).get()?.name ?? '';
}

function npcOf(db: DbOrTx, npc: NonNullable<EntryMeta['npc']>, viewerId: string, assets: GameAssets): { npc: NpcLineView } | Record<string, never> {
  const speaker = npcSpeaker(db, assets, viewerId, npc.id);
  return speaker ? { npc: { ...speaker, kind: npc.kind, ...(npc.private ? { private: true as const } : {}) } } : {};
}

/** GEN-129: the actor of a `player` entry as `viewer` may know them: the real name for the Human GM and for a person they know (GEN-117), else the Social Title. */
function actorOf(db: DbOrTx, memberId: string, viewer: { id: string; role: string }): { actor: { name: string; avatarId: string | null } } {
  const c = db.select().from(character).where(eq(character.memberId, memberId)).get();
  if (!c) return { actor: { name: '', avatarId: null } };
  // ISK-007: the avatar is public (like OtherCharacterView.avatarId), the name is not.
  return { actor: { name: viewer.role === 'gm' || namesVisibleTo(db, viewer.id).has(memberId) ? c.name : titleOf(c), avatarId: c.avatarId } };
}

/**
 * GEN-154: the action as typed, with each real name `viewer` does not know (another player's, an NPC's) swapped for
 * the alias they would see. Not for the Human GM nor the actor; the actor's own name stays (an introduction, GEN-117).
 */
function playerTextOf(db: DbOrTx, row: RoomEntryRow, actorId: string, viewer: { id: string; role: string }): string {
  if (viewer.role === 'gm' || viewer.id === actorId) return row.text;
  const known = namesVisibleTo(db, viewer.id);
  const aliases = new Map<string, string>();
  const people = db.select({ c: character }).from(character).innerJoin(member, eq(member.id, character.memberId)).where(eq(member.gameId, row.gameId)).all();
  for (const { c } of people) {
    if (c.memberId !== actorId && c.memberId !== viewer.id && !known.has(c.memberId) && c.name.trim().length > 0) aliases.set(c.name, titleOf(c));
  }
  const revealed = new Set(npcBondsOf(db, viewer.id).filter((b) => b.nameRevealed).map((b) => b.npcId));
  for (const n of getGameScenario(db, row.gameId)?.npcs ?? []) {
    if (!revealed.has(n.id) && n.name.trim().length > 0 && n.name !== n.alias) aliases.set(n.name, n.alias);
  }
  return aliases.size === 0 ? row.text : maskNames(row.text, aliases);
}

/**
 * ISK-008: the text as this player reads it, their own look / title written by the AI as "คุณ" (the row keeps the raw text).
 * shortcut: one character query per entry read, fine for a game's log; batch per request if replay gets slow.
 */
export function readerText(db: DbOrTx, gameId: string, text: string, viewer: { id: string; role: string }, assets: GameAssets): string {
  if (viewer.role !== 'player') return text;
  const people = db.select({ c: character }).from(character).innerJoin(member, eq(member.id, character.memberId)).where(eq(member.gameId, gameId)).all();
  const me = people.find(({ c }) => c.memberId === viewer.id)?.c;
  if (!me) return text;
  // A chip part the label no longer spells (admin edit, ISK-006 C8) is not in the stored sentence: left out.
  const parts = me.appearanceTraits === null ? [] : appearanceParts(JSON.parse(me.appearanceTraits) as AppearanceTraits, appearanceLabels(assets.appearanceOptions, true)).filter((p) => me.appearance.includes(p));
  const others = people.filter(({ c }) => c.memberId !== viewer.id).map(({ c }) => ({ appearance: c.appearance, title: titleOf(c) }));
  return youInText(text, { appearance: me.appearance, title: titleOf(me), parts }, others);
}

/** ISK-031: an ending (stored with real names) as its owner reads it: their own name is "คุณ", then their looks (readerText). */
export function ownEndingText(db: DbOrTx, gameId: string, text: string, viewer: { id: string; role: string }, assets: GameAssets): string {
  if (viewer.role !== 'player') return text;
  const people = db.select({ memberId: character.memberId, name: character.name }).from(character).innerJoin(member, eq(member.id, character.memberId)).where(eq(member.gameId, gameId)).all();
  const me = people.find((p) => p.memberId === viewer.id);
  if (!me) return text;
  const others = [...people.filter((p) => p !== me).map((p) => p.name), ...(getGameScenario(db, gameId)?.npcs ?? []).map((n) => n.name)];
  return readerText(db, gameId, nameAsYou(text, me.name, others), viewer, assets);
}

/** ISK-031: a finale narration read by the one it was told to (its recipient). */
const isOwnEnding = (db: DbOrTx, row: RoomEntryRow, meta: EntryMeta, viewer: { id: string; role: string }) =>
  row.kind === 'narration' &&
  meta.finale === true &&
  viewer.role === 'player' &&
  db.select({ id: roomEntryRecipient.entryId }).from(roomEntryRecipient).where(and(eq(roomEntryRecipient.entryId, row.id), eq(roomEntryRecipient.memberId, viewer.id))).get() !== undefined;

/** ISK-008: what someone says or types (an action, a whisper, an NPC's spoken line) is never rewritten for the reader. */
const ownWords = (row: RoomEntryRow, meta: EntryMeta) => row.kind === 'player' || row.kind === 'whisper' || (row.kind === 'npc' && meta.npc?.kind === 'dialogue');

/** A stored feed / narration / whisper / hit entry as `viewer` receives it, live, on replay and in the game log (GEN-037). */
export function entryViewOf(db: DbOrTx, row: RoomEntryRow, viewer: { id: string; role: string }, assets: GameAssets): RoomEntry {
  const meta = row.meta === null ? {} : (JSON.parse(row.meta) as EntryMeta);
  return {
    seq: row.id,
    kind: row.kind,
    day: row.day,
    phase: row.phase,
    turn: row.turn === 2 ? 2 : 1,
    place: placeViewOf(db, row.gameId, row.locationId, assets),
    text:
      row.kind === 'player' && meta.actor
        ? playerTextOf(db, row, meta.actor, viewer)
        : ownWords(row, meta)
          ? row.text
          : isOwnEnding(db, row, meta, viewer)
            ? ownEndingText(db, row.gameId, row.text, viewer, assets)
            : readerText(db, row.gameId, row.text, viewer, assets),
    // Q-229: the viewer's own roll / hit card; only the entries made for one reader carry them.
    ...(meta.roll ? { roll: meta.roll } : {}),
    ...(meta.hit ? { hit: meta.hit } : {}),
    ...(meta.changes ? { changes: [...meta.changes] } : {}),
    ...(meta.clue ? { clue: true as const } : {}),
    // GEN-110: who says the line, as this viewer may know them (alias until the name is learned, grade only then).
    ...(row.kind === 'npc' && meta.npc ? npcOf(db, meta.npc, viewer.id, assets) : {}),
    ...(row.kind === 'player' && meta.actor ? actorOf(db, meta.actor, viewer) : {}),
    ...(row.kind === 'whisper'
      ? { whisper: { from: characterNameOf(db, row.fromMemberId), to: characterNameOf(db, row.toMemberId), mine: row.fromMemberId === viewer.id } }
      : {}),
    // Q-177: players learn only that it is the template, never why.
    ...(row.fallback !== null ? { fallback: true as const } : {}),
    // GEN-107: only a player sees the buttons, and only on what the AI GM wrote.
    ...(viewer.role === 'player' && isVotableEntry(row) && !meta.clue ? myVoteFields(db, row.gameId, viewer.id, row.id) : {}),
  };
}
