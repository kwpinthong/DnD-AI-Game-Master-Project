import type { GameAssets } from '../assets/load.ts';
import type { DbOrTx } from '../db/client.ts';
import type { RoomEntryRow } from '../room/store.ts';

/**
 * ISK-014: the morning news of a day, the same for everyone in the game. Day 1 and a summary that gave none use the
 * server's template; otherwise the `news` of the day summary before it.
 */

export const NEWS_MAX = 3;
export const NEWS_CODE_POINTS = 160;
export const QUIET_NEWS = 'เช้าวันใหม่ในเมืองยังเงียบสงบ';

export interface NewsSource {
  title: string;
  description: string;
}

/** C3: the events of the news day and the day before, by their public part only (name + description). */
export interface NewsSources {
  day: number;
  starting: NewsSource[];
  yesterday: NewsSource[];
}

export function newsSources(db: DbOrTx, gameId: string, day: number): NewsSources {
  void db;
  void gameId;
  return { day, starting: [], yesterday: [] };
}

export function clipNews(text: string): string {
  return text;
}

export function publicNews(db: DbOrTx, assets: GameAssets, gameId: string, raw: unknown): string[] | null {
  void db;
  void assets;
  void gameId;
  void raw;
  return null;
}

export function templateNews(db: DbOrTx, assets: GameAssets, gameId: string, day: number): string[] {
  void db;
  void assets;
  void gameId;
  void day;
  return [];
}

export function saveNews(db: DbOrTx, gameId: string, day: number, items: readonly string[], now: number): void {
  void db;
  void gameId;
  void day;
  void items;
  void now;
}

export function storedNews(db: DbOrTx, gameId: string, day: number): string[] | null {
  void db;
  void gameId;
  void day;
  return null;
}

export function insertNews(db: DbOrTx, gameId: string, day: number, items: readonly string[], now: number): { row: RoomEntryRow; recipients: ReadonlySet<string> } | null {
  void db;
  void gameId;
  void day;
  void items;
  void now;
  return null;
}
