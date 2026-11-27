import {
  nameKey,
  ONLINE_MAX_PLAYERS,
  ONLINE_MIN_PLAYERS,
  type CreateGameRequest,
  type GameMode,
  type GameTone,
  type GameView,
  type Member,
  type Scenario,
} from '@isekai/protocol';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import { isUniqueViolation, openSession, type Clock } from '../auth/join.ts';
import { hashPin } from '../auth/pin.ts';
import { snapshotVotes } from '../admin/vote-review.ts';
import type { Db } from '../db/client.ts';
import { character, game, learningEntry, member, memberStyle, session } from '../db/schema.ts';
import { closureOf } from '../admin/games.ts';
import { gameEnded } from '../rating/store.ts';
import { canEditScenario } from '../scenario/editor.ts';
import { membersWithLootChoice } from './loot.ts';
import { copyTemplateForGame, getGameScenario } from '../scenario/store.ts';
import { advanceTimeline } from '../timeline/store.ts';
import { placeUnplacedCharacters } from '../visibility/store.ts';
import type { Rng } from '@isekai/rules';
import type { GameAssets } from '../assets/load.ts';
import { rollOrigins } from './origin.ts';
import { insertNews, templateNews } from '../gm/news.ts';

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

/** ISK-023: the room's latest round, from any of its rounds (a round has at most one next round). */
export function latestRound(db: Db | Tx, row: GameRow): GameRow {
  for (;;) {
    const next = db.select().from(game).where(eq(game.previousGameId, row.id)).get();
    if (!next) return row;
    row = next;
  }
}

/** ISK-023: the same person in another round: name + PIN (the PIN hash is copied as is to the next round). */
function sameMemberIn(db: Db | Tx, me: MemberRow, gameId: string): MemberRow | undefined {
  return db.select().from(member).where(and(eq(member.gameId, gameId), eq(member.nameKey, me.nameKey), eq(member.pinHash, me.pinHash))).get();
}

/** ISK-023: `me` as a (not kicked) member of another round `gameId` of the same room; undefined = not theirs. */
export function memberInRound(db: Db | Tx, me: MemberRow, gameId: string): MemberRow | undefined {
  const target = db.select().from(game).where(eq(game.id, gameId)).get();
  const mine = db.select().from(game).where(eq(game.id, me.gameId)).get();
  if (!target || !mine || latestRound(db, target).id !== latestRound(db, mine).id) return undefined;
  const found = sameMemberIn(db, me, gameId);
  return found?.kickedAt === null ? found : undefined;
}

export function gameView(db: Db | Tx, gameId: string, viewer: MemberRow): GameView {
  const row = db.select().from(game).where(eq(game.id, gameId)).get();
  if (!row) throw new Error(`game ${gameId} is gone`);
  const members = activeMembers(db, gameId);
  const withCharacter = characterOwners(db, members);
  const limits = playerLimits(row.mode);
  const latest = latestRound(db, row);
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    humanGm: row.humanGm,
    npcDialogue: row.npcDialogue,
    tone: row.tone,
    // ISK-023: an old round shows the room's code (it moved to the latest round).
    inviteCode: latest.inviteCode,
    status: row.startedAt === null ? 'lobby' : 'started',
    startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
    you: { memberId: viewer.id, role: viewer.role },
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      ready: m.readyAt !== null,
      hasCharacter: withCharacter.has(m.id),
      rematchReady: m.rematchReadyAt !== null,
    })),
    players: { count: members.filter((m) => m.role === 'player').length, ...limits },
    canEditScenario: canEditScenario(row, viewer),
    startBlockers: row.startedAt === null ? startBlockers(db, row, members, withCharacter) : [],
    memory: memoryView(db, row.learningSources),
    round: { roundNo: row.roundNo, previousGameId: row.previousGameId, latestGameId: latest.id === row.id ? null : latest.id },
  };
}

/** GEN-083: the lobby's "ความทรงจำจากเกมก่อน" (a source game deleted since keeps the name its learning kept). */
function memoryView(db: Db | Tx, ids: string[] | null): NonNullable<GameView['memory']> {
  if (!ids || ids.length === 0) return { enabled: false, sources: [] };
  const names = new Map([
    ...db.select({ id: learningEntry.sourceGameId, name: learningEntry.sourceGameName }).from(learningEntry).where(inArray(learningEntry.sourceGameId, ids)).all().map((r) => [r.id, r.name] as const),
    ...db.select({ id: game.id, name: game.name }).from(game).where(inArray(game.id, ids)).all().map((r) => [r.id, r.name] as const),
  ]);
  return { enabled: true, sources: ids.map((id) => ({ id, name: names.get(id) ?? id })) };
}

export interface CreatedGame {
  member: Member;
  token: string;
  expiresAt: number;
  view: GameView;
}

/**
 * Creates the game, its creator and its own copy of the scenario (`scenario`, already checked; none = the default,
 * Q-070) in one transaction. The create code is checked by the caller. ISK-017: every setting is final here.
 * Human GM on: the creator is the GM (no character, no player slot). Off: the creator is a player.
 */
export async function createGame(db: Db, input: CreateGameRequest, now: Clock, defaultTone: GameTone = 'A', learningSources: string[] | null = null, scenario?: Scenario): Promise<CreatedGame> {
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
      readyAt: null,
      rematchReadyAt: null,
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
          tone: input.tone ?? defaultTone,
          learningSources,
          ownerMemberId: owner.id,
          startedAt: null,
          createdAt: t,
        })
        .run(),
    );
    tx.insert(member).values(owner).run();
    copyTemplateForGame(tx, gameId, scenario, t);
    const opened = openSession(tx, owner.id, t);
    return {
      member: { id: owner.id, gameId, name: owner.name },
      ...opened,
      view: gameView(tx, gameId, owner),
    };
  });
}

/**
 * GEN-112: removes a game; every table cascades. GEN-189: its 👍/👎 are kept first as vote snapshots.
 * ISK-017: no player route calls it any more (players cannot delete a game); kept for the server owner (ISK-018).
 */
export function deleteGame(db: Db, gameId: string, now: number): void {
  db.transaction((tx) => {
    snapshotVotes(tx, gameId, now);
    tx.delete(game).where(eq(game.id, gameId)).run();
  });
}

export type AiReadiness = { ok: true } | { ok: false; message: string };

export type ReadyOutcome =
  | { kind: 'ok'; view: GameView; started: boolean }
  | { kind: 'not_in_lobby' }
  | { kind: 'ai_not_ready'; message: string };

/**
 * ISK-017: a player's ready in the lobby, then the start check in the same transaction (so two last readies at
 * once start the game once). An AI GM that is not ready keeps the ready and only refuses the start.
 */
export function setReady(db: Db, me: MemberRow, ready: boolean, now: Clock, assets: GameAssets, rng: Rng | null, aiReady: () => AiReadiness): ReadyOutcome {
  return db.transaction((tx): ReadyOutcome => {
    const row = tx.select().from(game).where(eq(game.id, me.gameId)).get();
    if (!row || row.startedAt !== null || me.role !== 'player') return { kind: 'not_in_lobby' };
    tx.update(member).set({ readyAt: ready ? now() : null }).where(eq(member.id, me.id)).run();
    const start = tryStart(tx, row, now, assets, rng, aiReady);
    if (start.kind === 'ai_not_ready') return start;
    return { kind: 'ok', view: gameView(tx, row.id, me), started: start.kind === 'started' };
  });
}

export type RematchOutcome =
  | { kind: 'ok'; view: GameView; newGameId: string | null }
  | { kind: 'not_ended' }
  | { kind: 'not_latest_round' }
  | { kind: 'not_player' }
  | { kind: 'ai_not_ready'; message: string };

/**
 * ISK-023: a player's "เล่นรอบใหม่" in the room's latest round once it ended (finale, game over or closed), then the
 * check in the same transaction (two last readies at once make one round). Every player not kicked ready (Online ≥ 2,
 * Single 1) makes the next round; an AI GM that is not ready keeps the ready and makes none.
 */
export function setRematchReady(db: Db, me: MemberRow, ready: boolean, now: Clock, aiReady: () => AiReadiness): RematchOutcome {
  return db.transaction((tx): RematchOutcome => {
    const row = tx.select().from(game).where(eq(game.id, me.gameId)).get()!;
    if (latestRound(tx, row).id !== row.id) return { kind: 'not_latest_round' };
    if (!gameEnded(tx, row.id) && closureOf(tx, row.id) === null) return { kind: 'not_ended' };
    if (me.role !== 'player') return { kind: 'not_player' };
    tx.update(member).set({ rematchReadyAt: ready ? now() : null }).where(eq(member.id, me.id)).run();
    const players = activeMembers(tx, row.id).filter((m) => m.role === 'player');
    let newGameId: string | null = null;
    if (players.length >= playerLimits(row.mode).min && players.every((m) => m.rematchReadyAt !== null)) {
      const ai = aiReady();
      if (!ai.ok) return { kind: 'ai_not_ready', message: ai.message };
      newGameId = createNextRound(tx, row, now());
    }
    return { kind: 'ok', view: gameView(tx, row.id, me), newGameId };
  });
}

/**
 * ISK-023: the next round of the room: the same settings and scenario, the room code, and every member not kicked
 * (name + PIN hash + role, player code link) with nothing of the old round (no character, loot, Karma). It waits at
 * the lobby like a new game: characters first, then everyone's ready starts it at day 1 (`tryStart`).
 */
function createNextRound(tx: Tx, old: GameRow, t: number): string {
  const id = randomUUID();
  const ids = new Map<string, string>();
  const members: MemberRow[] = activeMembers(tx, old.id).map((m) => {
    ids.set(m.id, randomUUID());
    return { ...m, id: ids.get(m.id)!, gameId: id, lockedUntil: null, readyAt: null, rematchReadyAt: null, createdAt: t };
  });
  // The old round keeps its id as its code: a typed code is normalised (no '-', upper case), so it never matches.
  tx.update(game).set({ inviteCode: old.id }).where(eq(game.id, old.id)).run();
  tx.insert(game)
    .values({ ...old, id, ownerMemberId: ids.get(old.ownerMemberId ?? '') ?? null, startedAt: null, createdAt: t, previousGameId: old.id, roundNo: old.roundNo + 1 })
    .run();
  tx.insert(member).values(members).run();
  copyTemplateForGame(tx, id, getGameScenario(tx, old.id) ?? undefined, t);
  const styles = tx.select().from(memberStyle).where(inArray(memberStyle.memberId, [...ids.keys()])).all();
  for (const s of styles) tx.insert(memberStyle).values({ ...s, memberId: ids.get(s.memberId)!, gameId: id, updatedAt: t }).run();
  return id;
}

export type RematchSessionOutcome = { kind: 'ok'; member: Member; token: string; expiresAt: number } | { kind: 'kicked' } | { kind: 'member_not_found' };

/** ISK-023: a session of `me`'s own member in the room's latest round (any round's token; again = another token, no new member). */
export function rematchSession(db: Db, me: MemberRow, now: Clock): RematchSessionOutcome {
  return db.transaction((tx): RematchSessionOutcome => {
    const latest = latestRound(tx, tx.select().from(game).where(eq(game.id, me.gameId)).get()!);
    const mine = sameMemberIn(tx, me, latest.id);
    if (!mine) return { kind: 'member_not_found' };
    if (mine.kickedAt !== null) return { kind: 'kicked' };
    return { kind: 'ok', member: { id: mine.id, gameId: mine.gameId, name: mine.name }, ...openSession(tx, mine.id, now()) };
  });
}

/** ISK-018: a new invite code for the game (the old one stops working at once); returns it. */
export function renewGameInviteCode(tx: Db | Tx, gameId: string): string {
  return withFreshInviteCode((inviteCode) => {
    tx.update(game).set({ inviteCode }).where(eq(game.id, gameId)).run();
    return inviteCode;
  });
}

/** ISK-018: kicked = blocked: sessions are deleted and the row stays so the name + PIN cannot rejoin. */
export function blockMember(tx: Db | Tx, memberId: string, at: number): void {
  tx.update(member).set({ kickedAt: at }).where(eq(member.id, memberId)).run();
  tx.delete(session).where(eq(session.memberId, memberId)).run();
}

/**
 * ISK-017: starts a lobby game whose players are all ready (Online ≥ 2 by the start blockers, Single its one).
 * Call it inside the transaction of every change that can complete the ready set (ready today; ISK-018 kick).
 */
export function tryStart(tx: Tx, row: GameRow, now: Clock, assets: GameAssets, rng: Rng | null, aiReady: () => AiReadiness): { kind: 'waiting' | 'started' } | { kind: 'ai_not_ready'; message: string } {
  if (row.startedAt !== null) return { kind: 'waiting' };
  const members = activeMembers(tx, row.id);
  if (members.some((m) => m.role === 'player' && m.readyAt === null)) return { kind: 'waiting' };
  if (startBlockers(tx, row, members, characterOwners(tx, members)).length > 0) return { kind: 'waiting' };
  const ai = aiReady();
  if (!ai.ok) return { kind: 'ai_not_ready', message: ai.message };
  startGame(tx, row, now, assets, rng);
  return { kind: 'started' };
}

function startGame(tx: Tx, row: GameRow, now: Clock, assets: GameAssets, rng: Rng | null): void {
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
  // ISK-014 (C5): day 1 opens with the template news (no AI call); everyone reads it when they enter the room.
  insertNews(tx, row.id, 1, templateNews(tx, assets, row.id, 1), t);
}
