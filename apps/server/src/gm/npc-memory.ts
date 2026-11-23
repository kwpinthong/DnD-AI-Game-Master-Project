import { PHASES, type Phase } from '@isekai/protocol';
import { AFFINITY_PER_ACTION, NPC_NAME_REVEAL_AFFINITY, type ActionOutcome } from '@isekai/rules';
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { npcMemory } from '../db/schema.ts';
import { npcBondsOf, type NpcBondRow } from '../visibility/store.ts';
import { estimateTokens, playerToken, stripStrayTokens, TOKEN_PATTERN, withinTokens, type GmWorld } from './context.ts';
import { cutLine } from './npc-lines.ts';

/**
 * GEN-146: what an NPC remembers of each player. One line per event that involved the NPC, made from the resolve
 * result when the turn applies (no AI call); the newest few of a pair go to the narration / dialogue (`npcPrompt`).
 */

export const MEMORY_LIMITS = {
  /** Lines of one NPC + player pair in a context. */
  perPair: 5,
  /** Tokens of those lines together. */
  pairTokens: 400,
  /** Characters of one stored line. */
  lineChars: 120,
  /** Characters of a player's look in a line. */
  lookChars: 40,
  /** Tokens of the line older normal lines fold into. */
  summaryTokens: 200,
  /** Normal lines more than this many game days old fold into the summary. */
  foldAfterDays: 2,
} as const;


type MemoryWorld = Pick<GmWorld, 'gameId' | 'players' | 'byRef' | 'tokenise'>;
type Row = typeof npcMemory.$inferInsert;

/** Exchanged names (GEN-170) or saved as a companion: the NPC knows who the player is. */
const acquainted = (b: NpcBondRow | undefined) => b !== undefined && (b.nameRevealed || b.companionSeq !== null);
/** Close enough to hear about the player's important deeds (C3). */
const close = (b: NpcBondRow) => b.companionSeq !== null || b.affinity > NPC_NAME_REVEAL_AFFINITY;

/** The memory lines of one applied turn (C1, C3, C4, C5), then the fold of old normal lines (C6). */
export function recordNpcMemories(
  db: DbOrTx,
  world: MemoryWorld,
  outcomes: readonly ActionOutcome[],
  summaries: ReadonlyMap<string, string>,
  at: { day: number; phase: Phase },
  now: number,
): void {
  const bondCache = new Map<string, NpcBondRow[]>();
  const bondsOf = (memberId: string) => bondCache.get(memberId) ?? bondCache.set(memberId, npcBondsOf(db, memberId)).get(memberId)!;
  const knows = (npcId: string, memberId: string) => acquainted(bondsOf(memberId).find((b) => b.npcId === npcId));
  const rows: Row[] = [];

  for (const o of outcomes) {
    if (o.status !== 'resolved') continue;
    const { log } = o;
    // C4: a Secret with a roll is seen only when caught (by the observer, and the target then knows too).
    if (o.visibility === 'secret' && log.check !== null && !log.caught) continue;
    const involved = new Set(
      [log.input.proposal.target?.npc, ...log.affinity.filter((a) => a.delta !== 0).map((a) => a.npcId), log.hp.target?.npcId, log.caught ? log.observation?.npcId : undefined].filter(
        (id): id is string => id !== undefined,
      ),
    );
    if (involved.size === 0) continue;
    const weight = log.caught || (log.hp.target?.damage ?? 0) > 0 || log.affinity.some((a) => Math.abs(a.delta) >= AFFINITY_PER_ACTION) ? 'important' : 'normal';
    const witnesses = o.visibility === 'public' ? Object.entries(o.locations).flatMap(([m, loc]) => (m !== o.actorId && loc === o.locationId ? [m] : [])) : [];
    const result = log.caught ? 'ถูกจับได้' : log.check === null ? null : log.degree === 'success' || log.degree === 'crit' ? 'สำเร็จ' : 'ไม่สำเร็จ';
    const summary = world.tokenise(summaries.get(o.actionId) ?? '');
    const line = (npcId: string, prefix = '') => {
      const who = (memberId: string) => {
        const p = world.players.get(memberId);
        if (!p) return 'ใครบางคน';
        // C5: until acquainted, the NPC knows the player by how they look, never by name.
        return knows(npcId, memberId) ? playerToken(p.ref) : cutLine(stripStrayTokens(world.tokenise(p.appearance)), MEMORY_LIMITS.lookChars) || p.socialTitle;
      };
      const actor = world.players.get(o.actorId);
      const named = actor !== undefined && summary.includes(playerToken(actor.ref));
      const body = summary.replace(TOKEN_PATTERN, (token, kind: string, id: string) => {
        if (kind !== 'p') return token;
        const memberId = world.byRef.get(id)?.memberId;
        return memberId === undefined ? '' : who(memberId);
      });
      return cutLine(`${prefix}${named ? '' : `${who(o.actorId)} `}${body}${result ? ` (${result})` : ''}`, MEMORY_LIMITS.lineChars);
    };
    const base = { gameId: world.gameId, memberId: o.actorId, day: at.day, phase: at.phase, weight, witnesses: JSON.stringify(witnesses), createdAt: now } as const;
    for (const npcId of involved) rows.push({ ...base, npcId, text: line(npcId) });
    // C3: an important deed reaches the NPCs close to the player.
    if (weight === 'important') {
      for (const b of bondsOf(o.actorId)) if (close(b) && !involved.has(b.npcId)) rows.push({ ...base, npcId: b.npcId, text: line(b.npcId, 'ได้ยินมาว่า ') });
    }
  }
  if (rows.length > 0) db.insert(npcMemory).values(rows).run();
  foldOldMemories(db, world.gameId, at.day, now);
}

/** C6: normal lines more than `foldAfterDays` old become one summary line per pair (newest first, token-limited). */
function foldOldMemories(db: DbOrTx, gameId: string, day: number, now: number): void {
  const old = db
    .select()
    .from(npcMemory)
    .where(and(eq(npcMemory.gameId, gameId), eq(npcMemory.weight, 'normal'), lt(npcMemory.day, day - MEMORY_LIMITS.foldAfterDays)))
    .all();
  const pairs = new Map<string, typeof old>();
  for (const r of old) pairs.set(`${r.memberId}\n${r.npcId}`, [...(pairs.get(`${r.memberId}\n${r.npcId}`) ?? []), r]);
  for (const lines of pairs.values()) {
    const { memberId, npcId } = lines[0]!;
    const previous = db
      .select()
      .from(npcMemory)
      .where(and(eq(npcMemory.gameId, gameId), eq(npcMemory.memberId, memberId), eq(npcMemory.npcId, npcId), eq(npcMemory.weight, 'summary')))
      .all();
    const newest = [...lines].sort(newestFirst);
    const text = withinTokens([...newest, ...previous].map((r) => r.text).join(' / '), MEMORY_LIMITS.summaryTokens);
    db.delete(npcMemory).where(inArray(npcMemory.id, [...lines, ...previous].map((r) => r.id))).run();
    db.insert(npcMemory).values({ gameId, memberId, npcId, day: newest[0]!.day, phase: newest[0]!.phase, text, weight: 'summary', createdAt: now }).run();
  }
}

const newestFirst = (a: { day: number; phase: Phase; id: number }, b: { day: number; phase: Phase; id: number }) =>
  b.day - a.day || PHASES.indexOf(b.phase) - PHASES.indexOf(a.phase) || b.id - a.id;

const MARK = { normal: '', important: '(สำคัญ) ', summary: '(สรุปเรื่องเก่า) ' } as const;

/** C2: what `npcId` remembers of `memberId`, newest first: at most `perPair` lines within `pairTokens`. Tokens only. */
export function npcMemoriesOf(db: DbOrTx, gameId: string, memberId: string, npcId: string): string[] {
  const rows = db
    .select()
    .from(npcMemory)
    .where(and(eq(npcMemory.gameId, gameId), eq(npcMemory.memberId, memberId), eq(npcMemory.npcId, npcId)))
    .all()
    .sort(newestFirst);
  const out: string[] = [];
  let used = 0;
  for (const r of rows.slice(0, MEMORY_LIMITS.perPair)) {
    const line = `[วัน ${r.day} ${r.phase}] ${MARK[r.weight]}${r.text}`;
    used += estimateTokens(line);
    if (used > MEMORY_LIMITS.pairTokens) break;
    out.push(line);
  }
  return out;
}
