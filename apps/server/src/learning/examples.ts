import { isVotableEntry, type RollOutcome, type RollView, type StyleGoodCandidate } from '@isekai/protocol';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { memberNames } from '../admin/vote-review.ts';
import type { DbOrTx } from '../db/client.ts';
import { game, learningEntry, npcExample, roomEntry, roomEntryRecipient } from '../db/schema.ts';
import { activeMembers } from '../game/service.ts';
import { exampleTokens, PLAYER_TOKEN } from '../gm/npc-examples.ts';
import { gameEnded, rulingRef, rulingsOf, rulingVotes } from '../rating/store.ts';
import { gameVotes } from '../room/vote.ts';
import type { EntryMeta } from '../room/store.ts';
import { getGameScenario } from '../scenario/store.ts';
import { actionTags } from './tags.ts';

/**
 * GEN-081 (Q-286 / Q-287, ADR "Learning Across Games" R2-R5): `good_example` / `avoid` entries of every ended game,
 * from the per-message votes (AI messages, `entry-…`) and the end page's ruling votes (`ruling-…`), by the one
 * `voteVerdict`. A message only some players received counts only when its player recipients are more than half of
 * the players (R4). Kept in step with votes after the end: no longer passing → `suspended`, passing again → `active`;
 * a library delete is a `deleted` tombstone, so a rebuild never brings it back. Caps per game: good 20, avoid 10.
 */

export const GOOD_CAP = 20;
export const AVOID_CAP = 10;
const TYPES = ['good_example', 'avoid'] as const;
type ExampleType = (typeof TYPES)[number];

const RESULT: Record<RollOutcome, { result: string; word: string }> = {
  success: { result: 'success', word: 'สำเร็จ' },
  failure: { result: 'fail', word: 'ไม่สำเร็จ' },
  critical_success: { result: 'crit', word: 'สำเร็จงดงาม' },
  critical_failure: { result: 'fumble', word: 'พลาดหนัก' },
};

interface Candidate {
  type: ExampleType;
  sourceRef: string;
  order: number;
  content: string;
  tags: string[];
  detail: Record<string, unknown> & { up: number; down: number };
}

const metaOf = (meta: string | null): EntryMeta => (meta === null ? {} : (JSON.parse(meta) as EntryMeta));

/** Names of the game (lobby, character, NPC) → "ผู้เล่น" / `{{n:id}}`, every `{{p:..}}` → "ผู้เล่น". */
function scrubberOf(db: DbOrTx, gameId: string) {
  const npcs = (getGameScenario(db, gameId)?.npcs ?? []).map((n) => ({ id: n.id, names: [n.name, ...(n.otherNames ?? [])] }));
  const players = memberNames(db, gameId).flat();
  return (text: string) => exampleTokens(text, npcs, players).split(PLAYER_TOKEN).join('ผู้เล่น');
}

/** The roll the actor saw for an action (their narration of that turn), if any. */
function rollOf(db: DbOrTx, gameId: string, at: { day: number; phase: string; turn: number }, memberId: string): RollView | null {
  const rows = db
    .select({ meta: roomEntry.meta })
    .from(roomEntry)
    .innerJoin(roomEntryRecipient, eq(roomEntryRecipient.entryId, roomEntry.id))
    .where(and(eq(roomEntry.gameId, gameId), eq(roomEntry.kind, 'narration'), eq(roomEntry.day, at.day), eq(roomEntry.phase, at.phase as never), eq(roomEntry.turn, at.turn), eq(roomEntryRecipient.memberId, memberId)))
    .all();
  return rows.map((r) => metaOf(r.meta).roll).filter((r): r is RollView => r !== undefined).at(-1) ?? null;
}

function candidatesOf(db: DbOrTx, gameId: string): Candidate[] {
  const players = new Set(activeMembers(db, gameId).filter((m) => m.role === 'player').map((m) => m.id));
  const scrub = scrubberOf(db, gameId);
  const tags = actionTags(db, gameId);
  const out: Candidate[] = [];
  const typeOf = (v: { good: boolean; avoid: boolean }): ExampleType | null => (v.good ? 'good_example' : v.avoid ? 'avoid' : null);

  // AI messages (narration, NPC lines).
  const voted = gameVotes(db, gameId).entries.filter((e) => e.good || e.avoid);
  const rows = new Map((voted.length === 0 ? [] : db.select().from(roomEntry).where(inArray(roomEntry.id, voted.map((e) => e.seq))).all()).map((r) => [r.id, r]));
  for (const e of voted) {
    const row = rows.get(e.seq);
    if (!row || !isVotableEntry(row)) continue;
    const recipients = db.select({ memberId: roomEntryRecipient.memberId }).from(roomEntryRecipient).where(eq(roomEntryRecipient.entryId, row.id)).all().filter((r) => players.has(r.memberId)).map((r) => r.memberId);
    if (recipients.length * 2 <= players.size) continue; // R4: a private message never becomes an example
    const npcId = row.kind === 'npc' ? (metaOf(row.meta).npc?.id ?? null) : null;
    const prefix = `${row.day}-${row.phase}-${row.turn}-`;
    const turnTags = [...tags].filter(([ref, t]) => ref.startsWith(prefix) && recipients.includes(t.memberId)).flatMap(([, t]) => [...t.verbs, ...t.targets]);
    out.push({
      type: typeOf(e)!,
      sourceRef: `entry-${row.id}`,
      order: row.id,
      content: scrub(row.text),
      tags: [...new Set([...(row.kind === 'npc' ? ['npc'] : []), ...turnTags])],
      detail: { sourceRef: `entry-${row.id}`, kind: row.kind === 'npc' ? 'dialogue' : 'narration', npcId, up: e.up, down: e.down, players: players.size },
    });
  }

  // End-page rulings: the action and what the actor saw (the difficulty word, never the DC number).
  const verdicts = rulingVotes(db, gameId);
  for (const [i, r] of rulingsOf(db, gameId).entries()) {
    const v = verdicts.get(r.sourceRef);
    const type = v ? typeOf(v) : null;
    if (!v || !type) continue;
    const roll = rollOf(db, gameId, r, r.memberId);
    const t = tags.get(r.sourceRef);
    out.push({
      type,
      sourceRef: rulingRef(r.sourceRef),
      order: i,
      content: `${scrub(r.text)} → ${roll ? `${roll.difficulty} ${RESULT[roll.outcome].word}` : 'ไม่ต้องทอย'}`,
      tags: [...new Set([...(t?.verbs ?? []), ...(t?.targets ?? [])])],
      detail: {
        sourceRef: rulingRef(r.sourceRef),
        kind: 'ruling',
        npcId: null,
        up: v.up,
        down: v.down,
        players: players.size,
        check: roll ? 'ladder' : 'none',
        dcLabel: roll?.difficulty ?? null,
        d20: roll?.d20 ?? null,
        result: roll ? RESULT[roll.outcome].result : 'none',
      },
    });
  }
  return out;
}

/** Brings the game's good_example / avoid entries in step with its votes now (idempotent). Nothing before the end. */
export function syncExamples(db: DbOrTx, gameId: string, now: number): void {
  if (!gameEnded(db, gameId)) return;
  const name = db.select({ name: game.name }).from(game).where(eq(game.id, gameId)).get()?.name ?? '';
  const candidates = candidatesOf(db, gameId);
  const kept = TYPES.flatMap((type) =>
    candidates
      .filter((c) => c.type === type)
      .sort((a, b) => (type === 'good_example' ? b.detail.up - a.detail.up : b.detail.down - a.detail.down) || a.order - b.order)
      .slice(0, type === 'good_example' ? GOOD_CAP : AVOID_CAP),
  );
  const existing = db.select().from(learningEntry).where(and(eq(learningEntry.sourceGameId, gameId), inArray(learningEntry.type, [...TYPES]))).all();
  const keyOf = (e: { type: string; sourceRef: string }) => `${e.type}|${e.sourceRef}`;
  const keptKeys = new Set(kept.map(keyOf));
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));
  for (const c of kept) {
    const row = byKey.get(keyOf(c));
    if (row?.status === 'deleted') continue;
    if (row) {
      db.update(learningEntry).set({ status: 'active', detail: JSON.stringify(c.detail) }).where(eq(learningEntry.id, row.id)).run();
    } else {
      db.insert(learningEntry)
        .values({ type: c.type, sourceGameId: gameId, sourceGameName: name, sourceScore: null, sourceRef: c.sourceRef, content: c.content, tags: JSON.stringify(c.tags), detail: JSON.stringify(c.detail), status: 'active', createdAt: now })
        .onConflictDoNothing()
        .run();
    }
  }
  for (const e of existing) if (e.status === 'active' && !keptKeys.has(keyOf(e))) db.update(learningEntry).set({ status: 'suspended' }).where(eq(learningEntry.id, e.id)).run();
}

/** A library delete (GEN-084): the entry is never used again and a rebuild does not bring it back. false = none to delete. */
export function deleteLearningEntry(db: DbOrTx, id: number): boolean {
  return db.update(learningEntry).set({ status: 'deleted', content: '' }).where(and(eq(learningEntry.id, id), ne(learningEntry.status, 'deleted'))).run().changes > 0;
}

/** GEN-084: every entry of a source game, as `deleteLearningEntry` does one. false = the game has none left. */
export function deleteLearningGame(db: DbOrTx, gameId: string): boolean {
  return db.update(learningEntry).set({ status: 'deleted', content: '' }).where(and(eq(learningEntry.sourceGameId, gameId), ne(learningEntry.status, 'deleted'))).run().changes > 0;
}

export interface LearningExample {
  id: number;
  sourceGameId: string;
  sourceRef: string;
  kind: 'narration' | 'dialogue' | 'ruling';
  npcId: string | null;
  content: string;
  tags: string[];
  up: number;
  down: number;
  players: number;
}

/**
 * For GEN-083: the top `good` good_example and top `avoid` avoid entries (active only) of the source games whose
 * tags share at least one with `tags`, most tags matched first, then most 👍 (good) / 👎 (avoid).
 */
export function examplesFor(db: DbOrTx, query: { tags: readonly string[]; sourceGameIds: readonly string[]; good: number; avoid: number }): { good: LearningExample[]; avoid: LearningExample[] } {
  const wanted = new Set(query.tags.map((t) => t.toLowerCase()));
  if (query.sourceGameIds.length === 0 || wanted.size === 0) return { good: [], avoid: [] };
  const rows = db
    .select()
    .from(learningEntry)
    .where(and(inArray(learningEntry.sourceGameId, [...query.sourceGameIds]), inArray(learningEntry.type, [...TYPES]), eq(learningEntry.status, 'active')))
    .all()
    .map((r) => {
      const detail = JSON.parse(r.detail) as { kind: LearningExample['kind']; npcId: string | null; up: number; down: number; players: number };
      const tags = JSON.parse(r.tags) as string[];
      const example: LearningExample = { id: r.id, sourceGameId: r.sourceGameId, sourceRef: r.sourceRef, kind: detail.kind, npcId: detail.npcId, content: r.content, tags, up: detail.up, down: detail.down, players: detail.players };
      return { type: r.type, example, matched: tags.filter((t) => wanted.has(t)).length };
    })
    .filter((r) => r.matched > 0);
  const top = (type: ExampleType, n: number) =>
    rows
      .filter((r) => r.type === type)
      .sort((a, b) => b.matched - a.matched || (type === 'good_example' ? b.example.up - a.example.up : b.example.down - a.example.down) || a.example.id - b.example.id)
      .slice(0, Math.max(0, n))
      .map((r) => r.example);
  return { good: top('good_example', query.good), avoid: top('avoid', query.avoid) };
}

/** For GEN-151: the NPC lines kept as good_example (active), not yet in the NPC example library. */
export function npcCandidates(db: DbOrTx): StyleGoodCandidate[] {
  const inLibrary = new Set(db.select().from(npcExample).where(eq(npcExample.source, 'vote')).all().map((r) => `${r.gameId}/${r.entryId}`));
  return db
    .select()
    .from(learningEntry)
    .where(and(eq(learningEntry.type, 'good_example'), eq(learningEntry.status, 'active')))
    .all()
    .flatMap((r) => {
      const detail = JSON.parse(r.detail) as { kind: string; npcId: string | null; up: number };
      const seq = Number(r.sourceRef.slice('entry-'.length));
      if (detail.kind !== 'dialogue' || detail.npcId === null || inLibrary.has(`${r.sourceGameId}/${seq}`)) return [];
      const name = getGameScenario(db, r.sourceGameId)?.npcs.find((n) => n.id === detail.npcId)?.name ?? detail.npcId;
      return [{ gameId: r.sourceGameId, seq, npc: { id: detail.npcId, name }, text: r.content, up: detail.up }];
    });
}
