import { defaultScenario, parseScenario, type Scenario, type ScenarioIssue } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { gameScenario } from '../db/schema.ts';

/** A stored copy that no longer parses: the row was edited outside this module. */
export class StoredScenarioError extends Error {
  constructor(gameId: string, errors: ScenarioIssue[]) {
    super(`Scenario of game "${gameId}" is invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'StoredScenarioError';
  }
}

export type UpdateScenarioResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'invalid'; errors: ScenarioIssue[] };

/**
 * Gives `gameId` its own copy of `template` (the default one unless a GM picked another).
 * Idempotent: a game that already has a copy keeps it, edits included. Throws when the game does
 * not exist (foreign key).
 */
export function copyTemplateForGame(
  db: DbOrTx,
  gameId: string,
  template: Scenario = defaultScenario(),
  now: number = Date.now(),
): Scenario {
  const parsed = parseScenario(template);
  if (!parsed.ok) throw new StoredScenarioError(gameId, parsed.errors);
  db.insert(gameScenario)
    .values({ gameId, schemaVersion: parsed.scenario.schemaVersion, data: JSON.stringify(parsed.scenario), updatedAt: now })
    .onConflictDoNothing()
    .run();
  return getGameScenario(db, gameId)!;
}

/** The game's scenario copy, upgraded to the current schema; null when the game has none. */
export function getGameScenario(db: DbOrTx, gameId: string): Scenario | null {
  const row = db.select().from(gameScenario).where(eq(gameScenario.gameId, gameId)).get();
  if (!row) return null;
  const parsed = parseScenario(JSON.parse(row.data));
  if (!parsed.ok) throw new StoredScenarioError(gameId, parsed.errors);
  return parsed.scenario;
}

/** Replaces the game's copy after validating it. Other games and the template are untouched. */
export function updateGameScenario(db: Db, gameId: string, input: unknown, now: number = Date.now()): UpdateScenarioResult {
  const parsed = parseScenario(input);
  if (!parsed.ok) {
    const exists = db.select({ gameId: gameScenario.gameId }).from(gameScenario).where(eq(gameScenario.gameId, gameId)).get();
    return exists ? { ok: false, code: 'invalid', errors: parsed.errors } : { ok: false, code: 'not_found' };
  }
  const updated = db
    .update(gameScenario)
    .set({ schemaVersion: parsed.scenario.schemaVersion, data: JSON.stringify(parsed.scenario), updatedAt: now })
    .where(eq(gameScenario.gameId, gameId))
    .run();
  if (updated.changes === 0) return { ok: false, code: 'not_found' };
  return { ok: true, scenario: parsed.scenario };
}
