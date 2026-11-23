import type { GmRefusal } from '@isekai/protocol';
import { desc, eq, lte } from 'drizzle-orm';
import { memberNames } from '../admin/vote-review.ts';
import type { DbOrTx } from '../db/client.ts';
import { gmRefusal } from '../db/schema-ai.ts';
import { getGameScenario } from '../scenario/store.ts';
import type { GmError } from './check.ts';
import { exampleTokens } from './npc-examples.ts';

/**
 * GEN-199: the AI GM answers the server refused, kept so the server owner can see what the AI got wrong (the
 * value at each error's path + the message naming the expected value). Scrubbed before storing: every real name
 * and lobby name of the game → a token (the learning scrub), every string cut to REFUSAL_TEXT, the whole answer
 * to REFUSAL_PROPOSAL_CHARS; only the newest REFUSAL_KEEP rows stay. A player code never reaches the AI, so it
 * is not in its answer.
 */
export const REFUSAL_KEEP = 200;
export const REFUSAL_TEXT = 100;
export const REFUSAL_PROPOSAL_CHARS = 4_000;
/** Errors kept per refusal, and refusals shown per game. */
const ERRORS_KEPT = 20;
const SHOWN = 50;

const cut = (s: string) => (s.length > REFUSAL_TEXT ? `${s.slice(0, REFUSAL_TEXT)}…` : s);

/** The value at `actions[0].staminaCost`-style paths (undefined when it is not there). */
function at(value: unknown, path: string): unknown {
  return (path.match(/[^.[\]]+/g) ?? []).reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined), value);
}

export function recordRefusal(
  db: DbOrTx,
  row: { gameId: string; purpose: string; stage: 'first' | 'repair'; value: unknown; errors: readonly GmError[]; at: number },
): void {
  const npcs = (getGameScenario(db, row.gameId)?.npcs ?? []).map((n) => ({ id: n.id, names: [n.name, ...(n.otherNames ?? [])] }));
  const players = memberNames(db, row.gameId).flat();
  const scrub = (text: string) => cut(exampleTokens(text, npcs, players));
  const clean: unknown = JSON.parse(JSON.stringify(row.value ?? null), (_k, v: unknown) => (typeof v === 'string' ? scrub(v) : v));
  const errors = row.errors.slice(0, ERRORS_KEPT).map((e) => ({
    code: cut(e.code),
    path: cut(e.path),
    message: scrub(e.message),
    got: cut(JSON.stringify(at(clean, e.path)) ?? ''),
  }));
  db.insert(gmRefusal)
    .values({ gameId: row.gameId, purpose: row.purpose, stage: row.stage, errors: JSON.stringify(errors), proposal: JSON.stringify(clean).slice(0, REFUSAL_PROPOSAL_CHARS), createdAt: row.at })
    .run();
  const oldest = db.select({ id: gmRefusal.id }).from(gmRefusal).orderBy(desc(gmRefusal.id)).limit(1).offset(REFUSAL_KEEP).get();
  if (oldest) db.delete(gmRefusal).where(lte(gmRefusal.id, oldest.id)).run();
}

/** The game's newest refusals, newest first. */
export function gameRefusals(db: DbOrTx, gameId: string): GmRefusal[] {
  return db
    .select()
    .from(gmRefusal)
    .where(eq(gmRefusal.gameId, gameId))
    .orderBy(desc(gmRefusal.id))
    .limit(SHOWN)
    .all()
    .map((r) => ({ at: new Date(r.createdAt).toISOString(), purpose: r.purpose, stage: r.stage === 'repair' ? 'repair' : 'first', errors: JSON.parse(r.errors) as GmRefusal['errors'], proposal: r.proposal }));
}
