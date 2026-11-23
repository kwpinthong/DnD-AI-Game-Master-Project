import type { GmRefusal } from '@isekai/protocol';
import type { DbOrTx } from '../db/client.ts';
import type { GmError } from './check.ts';

export const REFUSAL_KEEP = 200;
export const REFUSAL_TEXT = 100;
export const REFUSAL_PROPOSAL_CHARS = 4_000;

export function recordRefusal(_db: DbOrTx, _row: { gameId: string; purpose: string; stage: 'first' | 'repair'; value: unknown; errors: readonly GmError[]; at: number }): void {}

export function gameRefusals(_db: DbOrTx, _gameId: string): GmRefusal[] {
  return [];
}
