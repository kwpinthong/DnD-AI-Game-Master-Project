import { defaultScenario, type GameScenarioResponse } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { game } from '../db/schema.ts';
import type { GameRow, MemberRow } from '../game/service.ts';
import { getGameScenario } from './store.ts';

/**
 * The game's scenario as its Human GM reads it (GEN-046): players never get scenario content, and a game without a
 * Human GM has nobody reading it (Q-028). ISK-017: it is set once at creation (POST /api/games); nobody edits it after.
 * Inserting events during play is the GM console's job (GEN-058).
 */
export type ScenarioEditOutcome = ({ kind: 'ok' } & GameScenarioResponse) | { kind: 'forbidden' };

export const canEditScenario = (row: GameRow, viewer: MemberRow) =>
  row.humanGm && viewer.role === 'gm' && row.startedAt === null;

export function readScenario(db: Db, actor: MemberRow): ScenarioEditOutcome {
  const row = db.select().from(game).where(eq(game.id, actor.gameId)).get();
  if (!row || !row.humanGm || actor.role !== 'gm') return { kind: 'forbidden' };
  const scenario = getGameScenario(db, row.id) ?? defaultScenario();
  return { kind: 'ok', scenario, locked: row.startedAt !== null };
}
