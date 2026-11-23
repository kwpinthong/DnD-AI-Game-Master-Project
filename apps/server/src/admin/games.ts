import type { AdminGameRow } from '@isekai/protocol';
import type { Db, DbOrTx } from '../db/client.ts';

/** ISK-001: the stored close of a game; null = not closed. */
export function closureOf(db: DbOrTx, gameId: string): { reason: string | null; hasSummary: boolean } | null {
  void db;
  void gameId;
  return null;
}

export function listGames(db: Db): AdminGameRow[] {
  void db;
  return [];
}

export type CloseOutcome =
  | { kind: 'not_found' }
  | { kind: 'confirm_required' }
  | { kind: 'reason_too_long' }
  | { kind: 'already_ended' }
  | { kind: 'closed'; reason: string | null; hasSummary: boolean };

export function closeGame(db: Db, gameId: string, input: { confirmName: string; reason?: string | undefined }, now: number): CloseOutcome {
  void db;
  void gameId;
  void input;
  void now;
  return { kind: 'not_found' };
}
