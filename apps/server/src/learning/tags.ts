import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { characterPresence, gmTurn, phaseAction } from '../db/schema.ts';

export interface ActionTags {
  memberId: string;
  /** Lower-case Match_Verb_Tags the AI GM matched (GEN-064), e.g. `steal`. */
  verbs: string[];
  /** Lower-case target tags, e.g. `npc`. */
  targets: string[];
}

interface StoredAction {
  actor?: unknown;
  tagging?: { verbTags?: unknown; targetTags?: unknown };
}

const lower = (list: unknown) => (Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase()) : []);

/**
 * GEN-081 / GEN-082: each action's verb and target tags, keyed by its ruling `sourceRef`
 * (`${day}-${phase}-${turn}-${seq}`). Reads only `actions[].actor` and `actions[].tagging` of the stored turn
 * proposals: labels of the player's own action, never the gmNote, DC, modifiers or deltas (GM-only, ADR §3).
 */
export function actionTags(db: DbOrTx, gameId: string): Map<string, ActionTags> {
  const memberOfRef = new Map(db.select({ ref: characterPresence.ref, memberId: characterPresence.memberId }).from(characterPresence).where(eq(characterPresence.gameId, gameId)).all().map((p) => [p.ref, p.memberId]));
  const seqOf = new Map(db.select().from(phaseAction).where(eq(phaseAction.gameId, gameId)).all().map((a) => [`${a.day}-${a.phase}-${a.turn}-${a.memberId}`, a.seq]));
  const out = new Map<string, ActionTags>();
  for (const turn of db.select({ day: gmTurn.day, phase: gmTurn.phase, turn: gmTurn.turn, proposal: gmTurn.proposal }).from(gmTurn).where(eq(gmTurn.gameId, gameId)).all()) {
    let actions: StoredAction[] = [];
    try {
      const parsed = (JSON.parse(turn.proposal) as { actions?: unknown }).actions;
      actions = Array.isArray(parsed) ? (parsed as StoredAction[]) : [];
    } catch {
      continue;
    }
    for (const a of actions) {
      const memberId = typeof a.actor === 'string' ? memberOfRef.get(a.actor) : undefined;
      const seq = memberId ? seqOf.get(`${turn.day}-${turn.phase}-${turn.turn}-${memberId}`) : undefined;
      if (!memberId || seq === undefined) continue;
      out.set(`${turn.day}-${turn.phase}-${turn.turn}-${seq}`, { memberId, verbs: lower(a.tagging?.verbTags), targets: lower(a.tagging?.targetTags) });
    }
  }
  return out;
}
