import { defaultScenario, parseScenario, sortTimeline, type GameScenarioResponse, type Scenario, type ScenarioIssue } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { game } from '../db/schema.ts';
import type { GameRow, MemberRow } from '../game/service.ts';
import { copyTemplateForGame, getGameScenario, updateGameScenario } from './store.ts';

/**
 * Scenario editor before the start (GEN-046). Only the game's Human GM reads or edits its copy:
 * players never get scenario content, and a game without a Human GM keeps the default template
 * with nobody editing it (Q-028). Saving and resetting stop once the game has started; inserting
 * events during play is the GM console's job (GEN-058).
 */
export type ScenarioEditOutcome =
  | ({ kind: 'ok' } & GameScenarioResponse)
  | { kind: 'forbidden' }
  | { kind: 'game_started' }
  | { kind: 'invalid'; errors: ScenarioIssue[] };

export const canEditScenario = (row: GameRow, viewer: MemberRow) =>
  row.humanGm && viewer.role === 'gm' && row.startedAt === null;

function asGm(
  db: Db,
  actor: MemberRow,
  write: ((tx: DbOrTx, row: GameRow) => ScenarioEditOutcome | undefined) | undefined,
): ScenarioEditOutcome {
  return db.transaction((tx) => {
    const row = tx.select().from(game).where(eq(game.id, actor.gameId)).get();
    if (!row || !row.humanGm || actor.role !== 'gm') return { kind: 'forbidden' };
    if (write) {
      if (row.startedAt !== null) return { kind: 'game_started' };
      const refused = write(tx, row);
      if (refused) return refused;
    }
    const scenario = getGameScenario(tx, row.id) ?? defaultScenario();
    return { kind: 'ok', scenario, locked: row.startedAt !== null };
  });
}

export const readScenario = (db: Db, actor: MemberRow): ScenarioEditOutcome => asGm(db, actor, undefined);

/** Writes an already valid scenario; a game made before Q-070 that has no copy gets one. */
function store(tx: DbOrTx, gameId: string, scenario: Scenario, now: number) {
  if (!updateGameScenario(tx, gameId, scenario, now).ok) copyTemplateForGame(tx, gameId, scenario, now);
}

/** Replaces the game's copy with `input` (validated as a whole, timeline sorted by day + phase). */
export function saveScenario(db: Db, actor: MemberRow, input: unknown, now: number): ScenarioEditOutcome {
  return asGm(db, actor, (tx, row) => {
    const parsed = parseScenario(input);
    if (!parsed.ok) return { kind: 'invalid', errors: parsed.errors };
    store(tx, row.id, sortTimeline(parsed.scenario), now);
    return undefined;
  });
}

/** "คืนค่า default": the copy goes back to the default template. */
export function resetScenario(db: Db, actor: MemberRow, now: number): ScenarioEditOutcome {
  return asGm(db, actor, (tx, row) => {
    store(tx, row.id, defaultScenario(), now);
    return undefined;
  });
}
