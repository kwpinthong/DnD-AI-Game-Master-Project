import { randomUUID } from 'node:crypto';
import { clampReply, type AdminPlayerMemory } from '@isekai/protocol';
import { and, asc, desc, eq, gt, isNotNull, or } from 'drizzle-orm';
import type { GameAssets, PlayerMemorySettings } from '../assets/load.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { character, game, gmJournal, member, npcChat, phaseAction, playerMemory, roomEntry } from '../db/schema.ts';
import { containsName } from './check.ts';
import {
  estimateTokens,
  JOURNAL_BUDGET,
  loadWorld,
  MEMORY_DAYS_TOKENS,
  npcToken,
  playerToken,
  TOKEN_PATTERN,
  withinTokens,
  type GmWorld,
  type JournalContext,
  type MemoryDay,
  type NarrationContext,
  type PromptTopic,
} from './context.ts';
import { npcRealNames } from './npc-lines.ts';
import type { GmJournalTopic } from './schema.ts';
import { journalYesterday, seenOnDay } from './store.ts';

/**
 * ISK-098 (Nok 2026-11-28): what the AI remembers of each player in one game, by subject (one NPC, a quest, a bond,
 * a place...), from what reached that player only. The day's `summarize_journal` (no new call) gets the topics and
 * the day, answers the topics it changes, and the server holds the limits: at most `maxTopics` (the oldest fold into
 * "เรื่องอื่นๆ") and `maxChars` code points (the oldest are cut first with clampReply). Fed only to what that player
 * reads alone: their narration, their NPC chat and NPC lines to them only. Never sent to a player.
 */

export interface MemoryTopic extends PromptTopic {
  topicId: string;
}

export const OTHER_TITLE = 'เรื่องอื่นๆ';
export const TITLE_MAX = 40;
/** A summary cut shorter than this goes with its topic. */
const MIN_SUMMARY = 20;
type Limits = Pick<PlayerMemorySettings, 'maxChars' | 'maxTopics'>;

const cps = (s: string) => [...s].length;
/** What `maxChars` counts: title + summary in code points. */
const topicChars = (t: { title: string; summary: string }) => cps(t.title) + cps(t.summary);
const charsOf = (topics: readonly MemoryTopic[]) => topics.reduce((n, t) => n + topicChars(t), 0);

/** Newest `lastDay` first. */
export function topicsOf(db: DbOrTx, memberId: string): MemoryTopic[] {
  return db
    .select({ topicId: playerMemory.topicId, title: playerMemory.title, summary: playerMemory.summary, firstDay: playerMemory.firstDay, lastDay: playerMemory.lastDay })
    .from(playerMemory)
    .where(eq(playerMemory.memberId, memberId))
    .orderBy(desc(playerMemory.lastDay), desc(playerMemory.firstDay), asc(playerMemory.topicId))
    .all();
}

function saveTopics(db: Db, gameId: string, memberId: string, topics: readonly MemoryTopic[], now: number): void {
  db.transaction((tx) => {
    tx.delete(playerMemory).where(eq(playerMemory.memberId, memberId)).run();
    for (const t of topics) tx.insert(playerMemory).values({ gameId, memberId, ...t, updatedAt: now }).run();
  });
}

/** Oldest first: `lastDay`, then `firstDay`; a full tie takes the one listed later first (the AI lists what matters first). */
const oldestFirst = (topics: readonly MemoryTopic[]) =>
  topics
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.lastDay - b.t.lastDay || a.t.firstDay - b.t.firstDay || b.i - a.i)
    .map((x) => x.t);

/** The server's limits (4): too many topics → the oldest into เรื่องอื่นๆ; too many code points → the oldest cut first. */
export function fitTopics(topics: readonly MemoryTopic[], { maxTopics, maxChars }: Limits): MemoryTopic[] {
  let out = [...topics];
  while (out.length > maxTopics) {
    const other = out.find((t) => t.title === OTHER_TITLE);
    const oldest = oldestFirst(out).find((t) => t !== other);
    if (!oldest) break;
    if (!other) {
      out = out.map((t) => (t === oldest ? { ...t, title: OTHER_TITLE, summary: `${t.title}: ${t.summary}` } : t));
      continue;
    }
    const merged = {
      ...other,
      summary: `${other.summary}\n${oldest.title}: ${oldest.summary}`,
      firstDay: Math.min(other.firstDay, oldest.firstDay),
      lastDay: Math.max(other.lastDay, oldest.lastDay),
    };
    out = out.filter((t) => t !== oldest).map((t) => (t === other ? merged : t));
  }
  for (const oldest of oldestFirst(out)) {
    const excess = charsOf(out) - maxChars;
    if (excess <= 0) break;
    const room = cps(oldest.summary) - excess;
    const summary = room >= MIN_SUMMARY ? clampReply(oldest.summary, room) : '';
    out = cps(summary) < MIN_SUMMARY ? out.filter((t) => t !== oldest) : out.map((t) => (t === oldest ? { ...t, summary } : t));
  }
  return out;
}

/** At start-up: every player's topics within the limits (a migrated saga longer than maxChars, C22). */
export function fitStoredTopics(db: Db, limits: Limits, now: number): void {
  const owners = db.selectDistinct({ gameId: playerMemory.gameId, memberId: playerMemory.memberId }).from(playerMemory).all();
  for (const { gameId, memberId } of owners) {
    const topics = topicsOf(db, memberId);
    const fitted = fitTopics(topics, limits);
    if (JSON.stringify(fitted) !== JSON.stringify(topics)) saveTopics(db, gameId, memberId, fitted, now);
  }
}

/** Real names → tokens (players' and NPCs', every name the server knows them by), and whether a real name is still left. */
export interface Names {
  tokenise(text: string): string;
  /** A real name with no token in this game: the character name of a player the owner removed (out of `world`). */
  untokenised(text: string): boolean;
}

export function namesOf(db: DbOrTx, world: GmWorld, assets: GameAssets): Names {
  const npcNames = world.npcs.flatMap((n) => npcRealNames(assets, n).map((name) => [name, npcToken(n.id)] as const)).sort((a, b) => b[0].length - a[0].length);
  // Not the lobby names: a nickname is often a plain word (นก), which would drop good topics.
  const others = db
    .select({ name: character.name })
    .from(character)
    .innerJoin(member, eq(member.id, character.memberId))
    .where(and(eq(member.gameId, world.gameId), isNotNull(member.kickedAt)))
    .all()
    .map((r) => r.name.trim())
    .filter((n) => n.length > 0);
  return {
    tokenise: (text) => npcNames.reduce((out, [name, token]) => out.split(name).join(token), world.tokenise(text.normalize('NFC'))),
    untokenised: (text) => others.some((name) => containsName(text, name)),
  };
}

/** What reached `memberId` on each of `days`, newest kept within MEMORY_DAYS_TOKENS. Never another player's Secret, chat or whisper. */
export function memoryDays(db: DbOrTx, world: GmWorld, names: Names, memberId: string, days: readonly number[]): MemoryDay[] {
  const gameId = world.gameId;
  const tokenOf = (id: string | null) => {
    const p = id === null ? undefined : world.players.get(id);
    return p ? playerToken(p.ref) : 'ใครบางคน';
  };
  const out = days.map(
    (day): MemoryDay => ({
      day,
      actions: db
        .select({ text: phaseAction.text })
        .from(phaseAction)
        .where(and(eq(phaseAction.gameId, gameId), eq(phaseAction.memberId, memberId), eq(phaseAction.day, day)))
        .orderBy(asc(phaseAction.seq))
        .all()
        .map((r) => names.tokenise(r.text))
        .filter((t) => t.trim().length > 0),
      seen: seenOnDay(db, gameId, memberId, day).map((t) => names.tokenise(t)),
      npcChats: db
        .select({ npcId: npcChat.npcId, text: npcChat.text, reply: npcChat.reply })
        .from(npcChat)
        .where(and(eq(npcChat.gameId, gameId), eq(npcChat.memberId, memberId), eq(npcChat.day, day)))
        .orderBy(asc(npcChat.id))
        .all()
        .map((r) => ({ npc: npcToken(r.npcId), said: r.text, reply: r.reply })),
      whispers: db
        .select({ from: roomEntry.fromMemberId, to: roomEntry.toMemberId, text: roomEntry.text })
        .from(roomEntry)
        .where(and(eq(roomEntry.gameId, gameId), eq(roomEntry.kind, 'whisper'), eq(roomEntry.day, day), or(eq(roomEntry.fromMemberId, memberId), eq(roomEntry.toMemberId, memberId))))
        .orderBy(asc(roomEntry.id))
        .all()
        .map((r) => ({ from: tokenOf(r.from), to: tokenOf(r.to), text: names.tokenise(r.text) })),
    }),
  );
  // Oldest first out: the oldest day's lists, each from its oldest item.
  let used = estimateTokens(JSON.stringify(out));
  for (const d of out) {
    for (const list of [d.seen, d.actions, d.npcChats, d.whispers] as unknown[][]) {
      while (used > MEMORY_DAYS_TOKENS && list.length > 0) used -= estimateTokens(JSON.stringify(list.shift()));
    }
  }
  return out;
}

/**
 * Which days the summary of `day` folds into the topics (7): that day plus at most 2 earlier ones whose summary
 * failed (`memoryPendingFromDay`). `applies` false: the day is in the topics already, or was dropped (more than 2
 * waiting), so only its journal is asked again and the topics of the answer are not used.
 */
export interface MemoryPlan {
  days: number[];
  applies: boolean;
  pending: number | null;
  /** A later day has its journal: a retry of an older day; the later ones still wait when it succeeds. */
  later: boolean;
}

export function memoryPlan(db: DbOrTx, memberId: string, day: number, topics: readonly MemoryTopic[]): MemoryPlan {
  const pending = db.select({ p: member.memoryPendingFromDay }).from(member).where(eq(member.id, memberId)).get()?.p ?? null;
  // shortcut: a day whose topics were saved with no change ([]) and whose journal then failed is folded again on the retry; harmless (nothing changed).
  const later = db.select({ day: gmJournal.day }).from(gmJournal).where(and(eq(gmJournal.memberId, memberId), eq(gmJournal.kind, 'day'), gt(gmJournal.day, day))).get() !== undefined;
  const applies = pending !== null ? day >= pending : !later && !topics.some((t) => t.lastDay >= day);
  const from = applies ? Math.max(pending ?? day, day - 2) : day;
  return { days: Array.from({ length: day - from + 1 }, (_, i) => from + i), applies, pending, later };
}

/** The `summarize_journal` context of `day` for one player, and what it folds. */
export function journalContext(db: DbOrTx, world: GmWorld, assets: GameAssets, p: { memberId: string; ref: string }, day: number) {
  const names = namesOf(db, world, assets);
  const topics = topicsOf(db, p.memberId);
  const plan = memoryPlan(db, p.memberId, day, topics);
  const { maxTopics, maxChars } = assets.playerMemory;
  const context: JournalContext = { kind: 'gm_journal', day, player: p.ref, limits: { maxTopics, maxChars }, topics, days: memoryDays(db, world, names, p.memberId, plan.days) };
  return { context, plan, names, topics };
}

/**
 * The topics of an answer, into the player's memory: an existing topicId of this player updates that topic, any other
 * id is a new one (C17); titles ≤ 40 code points; real names become tokens, and a topic with a name that cannot be
 * one is not taken (its old version stays, C20); then the limits (`fitTopics`). null (malformed) or a failed call:
 * the topics stay and the days wait for the next summary (at most 2).
 */
export function storeTopics(
  db: Db,
  input: { gameId: string; memberId: string; plan: MemoryPlan; topics: readonly MemoryTopic[]; names: Names; limits: Limits },
  answer: readonly GmJournalTopic[] | null,
  now: number,
): void {
  const { plan, memberId } = input;
  if (!plan.applies) return;
  const day = plan.days.at(-1)!;
  if (answer === null) {
    db.update(member).set({ memoryPendingFromDay: Math.max(plan.pending ?? day, day - 1) }).where(eq(member.id, memberId)).run();
    return;
  }
  const out = [...input.topics];
  for (const a of answer) {
    const title = clampReply(input.names.tokenise(a.title).trim(), TITLE_MAX);
    const summary = input.names.tokenise(a.summary).trim();
    if (title.length === 0 || summary.length === 0 || input.names.untokenised(`${title}\n${summary}`)) continue;
    const i = out.findIndex((t) => t.topicId === a.topicId);
    if (i >= 0) out[i] = { ...out[i]!, title, summary, lastDay: day };
    else out.push({ topicId: randomUUID().slice(0, 8), title, summary, firstDay: plan.days[0]!, lastDay: day });
  }
  saveTopics(db, input.gameId, memberId, fitTopics(out, input.limits), now);
  // Waiting from an older day with a later journal: that later day's topics failed too, so it still waits.
  db.update(member).set({ memoryPendingFromDay: plan.later ? day + 1 : null }).where(eq(member.id, memberId)).run();
}

/**
 * The topics a prompt read by this player alone gets (6): those naming one of `cite` first, then the newest `lastDay`,
 * each whole, within `maxTokens`.
 */
export function topicsForPrompt(topics: readonly MemoryTopic[], maxTokens: number, cite: readonly string[] = []): PromptTopic[] {
  const names = (t: MemoryTopic) => cite.some((c) => t.title.includes(c) || t.summary.includes(c));
  const ordered = topics.map((t, i) => ({ t, i })).sort((a, b) => Number(names(b.t)) - Number(names(a.t)) || a.i - b.i);
  const out: PromptTopic[] = [];
  let used = 1; // the list's brackets
  for (const { t } of ordered) {
    const shown = { title: t.title, summary: t.summary, firstDay: t.firstDay, lastDay: t.lastDay };
    const cost = estimateTokens(JSON.stringify(shown)) + 1;
    if (used + cost > maxTokens) continue;
    used += cost;
    out.push(shown);
  }
  return out;
}

/** The journal of a player's own narration on `day`: yesterday's journal and their topics (in place of the saga). */
export function memoryJournal(db: DbOrTx, memberId: string, day: number, promptTokens: number): NonNullable<NarrationContext['journal']> {
  const yesterday = journalYesterday(db, memberId, day);
  return { yesterday: yesterday === null ? null : withinTokens(yesterday, JOURNAL_BUDGET.yesterday), topics: topicsForPrompt(topicsOf(db, memberId), promptTokens) };
}

/** GET /api/admin/games/:id/memory (9); null = no such game. */
export function adminMemory(db: Db, assets: GameAssets, gameId: string): AdminPlayerMemory | null {
  if (!db.select({ id: game.id }).from(game).where(eq(game.id, gameId)).get()) return null;
  const world = loadWorld(db, gameId, assets);
  const players = db
    .select({ id: member.id, name: member.name, character: character.name })
    .from(member)
    .leftJoin(character, eq(character.memberId, member.id))
    .where(and(eq(member.gameId, gameId), eq(member.role, 'player')))
    .orderBy(asc(member.createdAt))
    .all()
    .map((m) => {
      const topics = topicsOf(db, m.id);
      return { memberId: m.id, name: m.character ?? m.name, charCount: charsOf(topics), topics };
    });
  const names: Record<string, string> = {};
  for (const t of players.flatMap((p) => p.topics)) {
    for (const [token, kind, id] of `${t.title}\n${t.summary}`.matchAll(TOKEN_PATTERN)) {
      const name = kind === 'p' ? world.byRef.get(id!)?.name : world.npcs.find((n) => n.id === id)?.name;
      if (name !== undefined) names[token] = name;
    }
  }
  const { maxChars, maxTopics } = assets.playerMemory;
  return { maxChars, maxTopics, players, names };
}
