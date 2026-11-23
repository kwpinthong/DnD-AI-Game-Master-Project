import { and, eq } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { DbOrTx } from '../db/client.ts';
import { gmMemory, roomEntry } from '../db/schema.ts';
import { activeMembers } from '../game/service.ts';
import { insertEntry, type RoomEntryRow } from '../room/store.ts';
import { getGameScenario } from '../scenario/store.ts';
import { maskNames } from './check.ts';
import { loadWorld, npcToken } from './context.ts';
import { renderTokens } from './loop.ts';

/**
 * ISK-014: the morning news of a day, the same for everyone in the game. Day 1 and a summary that gave none use the
 * server's template; otherwise the `news` of the summary of the day before (no extra AI call).
 */

export const NEWS_MAX = 3;
export const NEWS_CODE_POINTS = 160;
export const QUIET_NEWS = 'เช้าวันใหม่ในเมืองยังเงียบสงบ';

export interface NewsSource {
  title: string;
  description: string;
}

/** C3: the events of the news day and the day before, by their public part only (name + description, NPCs as tokens). */
export interface NewsSources {
  day: number;
  starting: NewsSource[];
  yesterday: NewsSource[];
}

/** Real NPC names (other names too) → their token, longest first, as the timeline context does it. */
function tokeniseNpcs(db: DbOrTx, gameId: string): (text: string) => string {
  const names = (getGameScenario(db, gameId)?.npcs ?? [])
    .flatMap((n) => [n.name, ...n.otherNames].map((name) => ({ name, token: npcToken(n.id) })))
    .filter((n) => n.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  return (text) => names.reduce((out, n) => out.split(n.name).join(n.token), text);
}

export function newsSources(db: DbOrTx, gameId: string, day: number): NewsSources {
  const clean = tokeniseNpcs(db, gameId);
  const timeline = getGameScenario(db, gameId)?.timeline ?? [];
  const on = (d: number) => timeline.filter((e) => e.day === d).map((e) => ({ title: clean(e.title), description: clean(e.description) }));
  return { day, starting: on(day), yesterday: on(day - 1) };
}

/** C6: at most 160 code points; a longer item is cut and ends in "…". */
export function clipNews(text: string): string {
  const points = [...text];
  return points.length <= NEWS_CODE_POINTS ? text : `${points.slice(0, NEWS_CODE_POINTS - 1).join('')}…`;
}

/** C12: a text as everyone reads it: player / NPC tokens and real names (other names too) → the alias. */
function forEveryone(db: DbOrTx, assets: GameAssets, gameId: string): (text: string) => string {
  const world = loadWorld(db, gameId, assets);
  // Whole words only (GEN-117 C6), so "คลินิก" stays whole for a player called "ลิน".
  const aliases = new Map([
    ...[...world.players.values()].map((p) => [p.name, p.socialTitle] as const),
    ...world.npcs.flatMap((n) => n.names.filter((name) => name !== n.alias).map((name) => [name, n.alias] as const)),
  ]);
  // One line per item: the entry's text joins the items with "\n".
  return (text) => maskNames(renderTokens(db, world, text, null, true), aliases).replace(/\s*\n\s*/g, ' ').trim();
}

/** The summary's `news` (any shape) as the items to publish; null when there is nothing usable (C9: the template then). */
export function publicNews(db: DbOrTx, assets: GameAssets, gameId: string, raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const render = forEveryone(db, assets, gameId);
  const items = raw.flatMap((t) => (typeof t === 'string' ? [clipNews(render(t))] : [])).filter((t) => t.length > 0);
  return items.length === 0 ? null : items.slice(0, NEWS_MAX);
}

/** C4 / C5: the names of the events starting that day (at most 3), or the quiet morning. */
export function templateNews(db: DbOrTx, assets: GameAssets, gameId: string, day: number): string[] {
  const render = forEveryone(db, assets, gameId);
  const titles = newsSources(db, gameId, day).starting.map((e) => clipNews(render(e.title))).filter((t) => t.length > 0);
  return titles.length === 0 ? [QUIET_NEWS] : titles.slice(0, NEWS_MAX);
}

/** The news of `day` from that day's summary (kept with it, so a restart before the publish still has it). */
export function saveNews(db: DbOrTx, gameId: string, day: number, items: readonly string[], now: number): void {
  const text = JSON.stringify(items);
  db.insert(gmMemory)
    .values({ gameId, kind: 'news', day, text, createdAt: now })
    .onConflictDoUpdate({ target: [gmMemory.gameId, gmMemory.kind, gmMemory.day], set: { text, createdAt: now } })
    .run();
}

export function storedNews(db: DbOrTx, gameId: string, day: number): string[] | null {
  const row = db.select({ text: gmMemory.text }).from(gmMemory).where(and(eq(gmMemory.gameId, gameId), eq(gmMemory.kind, 'news'), eq(gmMemory.day, day))).get();
  return row ? (JSON.parse(row.text) as string[]) : null;
}

export function hasNews(db: DbOrTx, gameId: string, day: number): boolean {
  return db.select({ id: roomEntry.id }).from(roomEntry).where(and(eq(roomEntry.gameId, gameId), eq(roomEntry.kind, 'news'), eq(roomEntry.day, day))).get() !== undefined;
}

/**
 * C1 / C10: the one `news` entry of `day` (its EOSORIA turn 1), to everyone in the game; null when the day has it
 * already. One line per item.
 */
export function insertNews(db: DbOrTx, gameId: string, day: number, items: readonly string[], now: number): { row: RoomEntryRow; recipients: ReadonlySet<string> } | null {
  if (hasNews(db, gameId, day)) return null;
  const recipients = new Set(activeMembers(db, gameId).map((m) => m.id));
  const row = insertEntry(db, gameId, { kind: 'news', at: { day, phase: 'EOSORIA', turn: 1 }, locationId: null, text: items.join('\n') }, [...recipients], now);
  return { row, recipients };
}
