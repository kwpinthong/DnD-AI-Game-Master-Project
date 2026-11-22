import type { CompanionView, Phase } from '@isekai/protocol';
import type { NpcForm, NpcGrade, NpcRuleError, Tier } from '@isekai/rules';
import type { DbOrTx } from '../db/client.ts';
import type { MemberRow } from '../game/service.ts';

export type CompanionOutcome =
  | { kind: 'ok'; companions: CompanionView[] }
  | { kind: 'gm_has_no_character' }
  | { kind: 'not_placed' }
  | { kind: 'npc_not_found'; message: string }
  | { kind: 'already_companion' }
  | { kind: 'companion_limit' };

export function npcRefs(_db: DbOrTx, _gameId: string, _npcIds: readonly string[]): Map<string, string> {
  return new Map();
}

export function companionsOf(_db: DbOrTx, _me: MemberRow): CompanionOutcome {
  return { kind: 'ok', companions: [] };
}

export function saveCompanion(_db: DbOrTx, _me: MemberRow, _ref: string, _now: number): CompanionOutcome {
  return { kind: 'ok', companions: [] };
}

export function releaseCompanion(_db: DbOrTx, _me: MemberRow, _ref: string, _now: number): CompanionOutcome {
  return { kind: 'ok', companions: [] };
}

export type AffinityResult =
  | { ok: true; before: number; delta: number; after: number; nameRevealed: boolean }
  | { ok: false; error: NpcRuleError | { code: 'unknown_npc'; message: string } };

export function changeNpcAffinity(_db: DbOrTx, _memberId: string, _npcId: string, delta: number, _now: number): AffinityResult {
  return { ok: true, before: 0, delta, after: 0, nameRevealed: false };
}

export function markCrisisAid(_db: DbOrTx, _memberId: string, _npcId: string, _now: number): boolean {
  return false;
}

export function evolveNpcsAtPhaseEnd(
  _db: DbOrTx,
  _memberId: string,
  _phase: Phase,
  _now: number,
): { npcId: string; grade: NpcGrade; form: NpcForm | null }[] {
  return [];
}

export function npcGradeFor(_db: DbOrTx, _memberId: string, _npcId: string): NpcGrade | undefined {
  return undefined;
}

export function checkNpcRewardFor(_db: DbOrTx, _memberId: string, _npcId: string, _tier: Tier): NpcRuleError | { code: 'unknown_npc'; message: string } | null {
  return null;
}
