import type { GameAssets } from '../assets/load.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { grantItem, grantSkill, recordSkillFlag, type SkillTime } from '../skills/store.ts';
import type { GmError } from './check.ts';
import type { GmTurnProposal } from './schema.ts';

/**
 * Q-180: the AI GM's `skillFlags` and `grants` of a turn proposal. They go through the GEN-055 functions
 * (`recordSkillFlag`, `grantSkill`, `grantItem` → `grantNpcReward`), so the AI can give only what the sheet
 * and the rules allow. The check runs them all on the state before the turn inside a transaction that is
 * rolled back (all-or-nothing, Q-049); the turn's apply runs them for the actions that succeeded.
 */

type Grant = GmTurnProposal['actions'][number]['grants'][number];

export interface EarnedSkillChange {
  readonly actionId: string;
  /** The actor's player ref. */
  readonly actor: string;
  readonly flags: readonly string[];
  readonly grants: readonly Grant[];
}

export const SUCCEEDED: ReadonlySet<string> = new Set(['success', 'crit']);

/** What each action earns: its flags and grants when it succeeded (success / crit), nothing otherwise. */
export function earnedSkillChanges(proposal: GmTurnProposal, resultOf: (actionId: string) => string | undefined): EarnedSkillChange[] {
  return proposal.actions.flatMap((a) => {
    // A proposal stored before Q-180 has neither field.
    const flags = a.skillFlags ?? [];
    const grants = a.grants ?? [];
    if (flags.length === 0 && grants.length === 0) return [];
    return SUCCEEDED.has(resultOf(a.actionId) ?? '') ? [{ actionId: a.actionId, actor: a.actor, flags, grants }] : [];
  });
}

/** One change for one member; the first refusal as a GmError (path in the proposal), or null when it went through. */
function runChange(db: DbOrTx, assets: GameAssets, memberId: string, change: EarnedSkillChange & { index: number }, at: SkillTime): GmError[] {
  const errors: GmError[] = [];
  const path = `actions[${change.index}]`;
  change.flags.forEach((flag, i) => {
    const r = recordSkillFlag(db, assets, memberId, flag, at);
    if (!r.ok) errors.push({ code: r.error.code, path: `${path}.skillFlags[${i}]`, message: r.error.message });
  });
  change.grants.forEach((g, i) => {
    const r =
      g.kind === 'skill'
        ? grantSkill(db, assets, memberId, g.name, at, g.npcId === null ? undefined : { npcId: g.npcId })
        : g.npcId === null
          ? { ok: false as const, error: { code: 'grant_needs_npc', message: 'an item is only given by an NPC as one of its open rewards; set npcId' } }
          : grantItem(db, assets, memberId, g.name, g.npcId, at);
    if (!r.ok) errors.push({ code: r.error.code, path: `${path}.grants[${i}]`, message: `${g.kind} "${g.name}": ${r.error.message}` });
  });
  return errors;
}

class Rollback extends Error {}

/**
 * Every flag and grant of the proposal, as if every action succeeds, against the state before the turn;
 * nothing is kept. Returns every refusal (for the one repair).
 */
export function checkSkillChanges(db: Db, assets: GameAssets, memberOfRef: (ref: string) => string | undefined, proposal: GmTurnProposal, at: SkillTime): GmError[] {
  const all = earnedSkillChanges(proposal, () => 'success').map((c) => ({ ...c, index: proposal.actions.findIndex((a) => a.actionId === c.actionId) }));
  if (all.length === 0) return [];
  const errors: GmError[] = [];
  try {
    db.transaction((tx) => {
      for (const change of all) {
        const memberId = memberOfRef(change.actor);
        if (memberId !== undefined) errors.push(...runChange(tx, assets, memberId, change, at));
      }
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return errors;
}

/** The turn's apply: the changes the succeeded actions earned. A refusal now (the state moved) is skipped and returned. */
export function applySkillChanges(tx: DbOrTx, assets: GameAssets, memberOfRef: (ref: string) => string | undefined, changes: readonly EarnedSkillChange[], proposal: GmTurnProposal, at: SkillTime): GmError[] {
  const skipped: GmError[] = [];
  for (const change of changes) {
    const memberId = memberOfRef(change.actor);
    if (memberId === undefined) continue;
    skipped.push(...runChange(tx, assets, memberId, { ...change, index: proposal.actions.findIndex((a) => a.actionId === change.actionId) }, at));
  }
  return skipped;
}
