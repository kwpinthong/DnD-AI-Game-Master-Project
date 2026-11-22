import {
  nameKey,
  ONLINE_MAX_PLAYERS,
  ONLINE_MIN_PLAYERS,
  type CreateGameRequest,
  type GameMode,
  type GameView,
  type Member,
  type UpdateGameRequest,
} from '@isekai/protocol';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import { isUniqueViolation, openSession, type Clock } from '../auth/join.ts';
import { hashPin } from '../auth/pin.ts';
import type { Db } from '../db/client.ts';
import { character, game, member, session } from '../db/schema.ts';
import { canEditScenario } from '../scenario/editor.ts';
import { membersWithLootChoice } from './loot.ts';
import { copyTemplateForGame, getGameScenario } from '../scenario/store.ts';
import { advanceTimeline } from '../timeline/store.ts';
import { placeUnplacedCharacters } from '../visibility/store.ts';
import type { Rng } from '@isekai/rules';
import type { GameAssets } from '../assets/load.ts';
import { rollOrigins } from './origin.ts';

export type GameRow = typeof game.$inferSelect;
export type MemberRow = typeof member.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** No 0/O, 1/I/L: codes are read aloud and typed on phones. 30^6 ≈ 7.3e8 codes. */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ2345678';
const INVITE_LENGTH = 6;

function newInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_LENGTH; i++) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return code;
}

/** Runs `write(code)` with fresh codes until one is not taken (a clash is ~1 in 7e8 per game). */
function withFreshInviteCode<T>(write: (code: string) => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return write(newInviteCode());
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 5) throw error;
    }
  }
}

export const playerLimits = (mode: GameMode) =>
  mode === 'single' ? { min: 1, max: 1 } : { min: ONLINE_MIN_PLAYERS, max: ONLINE_MAX_PLAYERS };

/** Members still in the game (kicked ones are kept only to block their name), oldest first. */
export function activeMembers(db: Db | Tx, gameId: string): MemberRow[] {
  return db
    .select()
    .from(member)
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt)))
    // rowid breaks ties in insert order (members created in the same millisecond).
    .orderBy(asc(member.createdAt), sql`rowid`)
    .all();
}

/** Active players (not the Human GM) in the game; the GM never takes a player slot. */
export function playerCount(db: Db | Tx, gameId: string): number {
  return activeMembers(db, gameId).filter((m) => m.role === 'player').length;
}

/**
 * Why the game cannot start yet: missing players first, then players without a character, then players
 * with a character who have not chosen their loot from the sheet (Q-144; an old Common choice counts as
 * not chosen). Empty when it can start.
 */
function startBlockers(db: Db | Tx, row: GameRow, members: MemberRow[], withCharacter: Set<string>): string[] {
  const players = members.filter((m) => m.role === 'player');
  const { min } = playerLimits(row.mode);
  const reasons: string[] = [];
  if (players.length < min) {
    reasons.push(`ขาดผู้เล่นอีก ${min - players.length} คน (Online ต้องมีผู้เล่นอย่างน้อย ${min} คน)`);
  }
  const without = players.filter((m) => !withCharacter.has(m.id)).map((m) => m.name);
  if (without.length > 0) reasons.push(`ยังไม่สร้างตัวละคร: ${without.join(', ')}`);
  const withCharacterIds = players.filter((m) => withCharacter.has(m.id)).map((m) => m.id);
  const chosen = membersWithLootChoice(db, withCharacterIds);
  const noLoot = players.filter((m) => withCharacter.has(m.id) && !chosen.has(m.id)).map((m) => m.name);
  if (noLoot.length > 0) reasons.push(`ยังไม่ได้เลือกของติดตัว: ${noLoot.join(', ')}`);
  return reasons;
}

function characterOwners(db: Db | Tx, members: MemberRow[]): Set<string> {
  if (members.length === 0) return new Set();
  const ids = members.map((m) => m.id);
  const rows = db.select({ memberId: character.memberId }).from(character).where(inArray(character.memberId, ids)).all();
  return new Set(rows.map((r) => r.memberId));
}

export function gameView(db: Db | Tx, gameId: string, viewer: MemberRow): GameView {
  const row = db.select().from(game).where(eq(game.id, gameId)).get();
  if (!row) throw new Error(`game ${gameId} is gone`);
  const members = activeMembers(db, gameId);
  const withCharacter = characterOwners(db, members);
  const limits = playerLimits(row.mode);
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    humanGm: row.humanGm,
    npcDialogue: row.npcDialogue,
    inviteCode: row.inviteCode,
    status: row.startedAt === null ? 'lobby' : 'started',
    startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
    you: { memberId: viewer.id, role: viewer.role, isOwner: row.ownerMemberId === viewer.id },
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      isOwner: row.ownerMemberId === m.id,
      hasCharacter: withCharacter.has(m.id),
    })),
    players: { count: members.filter((m) => m.role === 'player').length, ...limits },
    canEditScenario: canEditScenario(row, viewer),
    startBlockers: row.startedAt === null ? startBlockers(db, row, members, withCharacter) : [],
  };
}

export interface CreatedGame {
  member: Member;
  token: string;
  expiresAt: number;
  view: GameView;
}

/**
 * Creates the game, its owner and its own copy of the default scenario (Q-070) in one transaction.
 * The create code is checked by the caller.
 * Human GM on: the owner is the GM (no character, no player slot). Off: the owner is a player.
 */
export async function createGame(db: Db, input: CreateGameRequest, now: Clock): Promise<CreatedGame> {
  const pinHash = await hashPin(input.pin);
  return db.transaction((tx) => {
    const t = now();
    const gameId = randomUUID();
    const owner: MemberRow = {
      id: randomUUID(),
      gameId,
      name: input.name,
      nameKey: nameKey(input.name),
      pinHash,
      lockedUntil: null,
      role: input.humanGm ? 'gm' : 'player',
      kickedAt: null,
      createdAt: t,
    };
    withFreshInviteCode((inviteCode) =>
      tx
        .insert(game)
        .values({
          id: gameId,
          inviteCode,
          name: input.gameName,
          mode: input.mode,
          humanGm: input.humanGm,
          npcDialogue: input.npcDialogue ?? 'normal',
          ownerMemberId: owner.id,
          startedAt: null,
          createdAt: t,
        })
        .run(),
    );
    tx.insert(member).values(owner).run();
    copyTemplateForGame(tx, gameId, undefined, t);
    const opened = openSession(tx, owner.id, t);
    return {
      member: { id: owner.id, gameId, name: owner.name },
      ...opened,
      view: gameView(tx, gameId, owner),
    };
  });
}

export type OwnerActionOutcome =
  | { kind: 'ok'; view: GameView }
  | { kind: 'forbidden' }
  | { kind: 'game_started' }
  | { kind: 'member_not_found' }
  | { kind: 'not_allowed'; message: string }
  | { kind: 'cannot_start'; reasons: string[] };

/** Runs an owner-only change in one transaction, re-reading the game so checks see fresh state. */
function asOwner(db: Db, actor: MemberRow, change: (tx: Tx, row: GameRow) => OwnerActionOutcome | undefined): OwnerActionOutcome {
  return db.transaction((tx) => {
    const row = tx.select().from(game).where(eq(game.id, actor.gameId)).get();
    if (!row || row.ownerMemberId !== actor.id) return { kind: 'forbidden' };
    return change(tx, row) ?? { kind: 'ok', view: gameView(tx, row.id, actor) };
  });
}

export function renewInviteCode(db: Db, actor: MemberRow): OwnerActionOutcome {
  return asOwner(db, actor, (tx, row) => {
    withFreshInviteCode((inviteCode) => tx.update(game).set({ inviteCode }).where(eq(game.id, row.id)).run());
    return undefined;
  });
}

/** Kicked = blocked: sessions are deleted and the row stays so the name + PIN cannot rejoin. */
export function kickMember(db: Db, actor: MemberRow, targetId: string, now: Clock): OwnerActionOutcome {
  return asOwner(db, actor, (tx, row) => {
    if (row.startedAt !== null) return { kind: 'game_started' };
    if (targetId === actor.id) return { kind: 'not_allowed', message: 'เจ้าของเกมเตะตัวเองไม่ได้' };
    const target = tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.id, targetId), eq(member.gameId, row.id), isNull(member.kickedAt)))
      .get();
    if (!target) return { kind: 'member_not_found' };
    tx.update(member).set({ kickedAt: now() }).where(eq(member.id, target.id)).run();
    tx.delete(session).where(eq(session.memberId, target.id)).run();
    return undefined;
  });
}

/** GEN-112: the only way a game is removed. Owner only, and the caller must type the game's name; every table cascades. */
export function deleteGame(db: Db, actor: MemberRow, confirmName: unknown): 'ok' | 'forbidden' | 'confirm_required' {
  return db.transaction((tx) => {
    const row = tx.select().from(game).where(eq(game.id, actor.gameId)).get();
    if (!row || row.ownerMemberId !== actor.id) return 'forbidden';
    if (confirmName !== row.name) return 'confirm_required';
    tx.delete(game).where(eq(game.id, row.id)).run();
    return 'ok';
  });
}

export function updateGame(db: Db, actor: MemberRow, change: UpdateGameRequest): OwnerActionOutcome {
  return asOwner(db, actor, (tx, row) => {
    if (row.startedAt !== null) return { kind: 'game_started' };
    if (change.mode === 'single' && row.mode !== 'single') {
      if (row.humanGm) return { kind: 'not_allowed', message: 'เกมที่มี GM คนเปลี่ยนเป็นเล่นคนเดียวไม่ได้' };
      if (playerCount(tx, row.id) > 1) {
        return { kind: 'not_allowed', message: 'มีผู้เล่นมากกว่า 1 คน เปลี่ยนเป็นเล่นคนเดียวไม่ได้' };
      }
    }
    const set: Partial<GameRow> = {};
    if (change.gameName !== undefined) set.name = change.gameName;
    if (change.mode !== undefined) set.mode = change.mode;
    if (change.npcDialogue !== undefined) set.npcDialogue = change.npcDialogue;
    if (Object.keys(set).length > 0) tx.update(game).set(set).where(eq(game.id, row.id)).run();
    return undefined;
  });
}

export function startGame(db: Db, actor: MemberRow, now: Clock, assets: GameAssets, rng: Rng | null): OwnerActionOutcome {
  return asOwner(db, actor, (tx, row) => {
    if (row.startedAt !== null) return { kind: 'game_started' };
    const members = activeMembers(tx, row.id);
    const reasons = startBlockers(tx, row, members, characterOwners(tx, members));
    if (reasons.length > 0) return { kind: 'cannot_start', reasons };
    const t = now();
    tx.update(game).set({ startedAt: t }).where(eq(game.id, row.id)).run();
    // Each player's start scenario is rolled once here and stored (a restart never rolls again): it sets the
    // starting stats and places the character at its spawn place (GEN-065).
    if (rng !== null) rollOrigins(tx, row.id, assets, rng, t);
    // Anyone the roll did not place (no spawn table) starts at the scenario's first place (GEN-050).
    const start = getGameScenario(tx, row.id)?.locations[0];
    if (start) placeUnplacedCharacters(tx, row.id, start.id, t);
    // The game starts at day 1 Morning: its events become active (GEN-053), after placing, so each
    // event's witness snapshot sees where everyone starts (Q-104).
    advanceTimeline(tx, row.id, { day: 1, phase: 'EOSORIA' }, t);
    return undefined;
  });
}
