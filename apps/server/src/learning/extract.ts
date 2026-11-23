import type { LearningExtractResponse } from '@isekai/protocol';
import { and, eq, isNull, lte } from 'drizzle-orm';
import type { AiService } from '../ai/core/service.ts';
import type { GameAssets } from '../assets/load.ts';
import type { Clock } from '../auth/join.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { game, gamePhase, gameRating, learningEntry, learningExtract, member } from '../db/schema.ts';
import { getEnding } from '../finale/store.ts';
import { revealFor } from '../finale/reveal.ts';
import { activeMembers } from '../game/service.ts';
import { containsName } from '../gm/check.ts';
import { exampleTokens, PLAYER_TOKEN } from '../gm/npc-examples.ts';
import { gameEnded } from '../rating/store.ts';
import { getGameScenario } from '../scenario/store.ts';
import { timelineFor } from '../timeline/routes.ts';
import { ExtractAnswer, LEARNING_EXTRACT_INSTRUCTIONS } from './extract-prompt.ts';

/**
 * GEN-080 (ADR "Learning Across Games" + Revised GEN-108): lore + feedback_note of an ended game, from the end page
 * only (`GameReveal`, the timeline events every player saw, the rating comments): no GM-only table is read here.
 * No score gate (Q-324): the average rating is kept as `sourceScore`. Once per game; a failure stores nothing.
 */

const FAILED = 'สกัดไม่สำเร็จ';
const TAG = /^[a-z0-9_]{1,24}$/;

/** Lobby names → "ผู้เล่น", NPC names → `{{n:id}}` (the learning scrub). */
function scrubberOf(db: DbOrTx, gameId: string) {
  const npcs = (getGameScenario(db, gameId)?.npcs ?? []).map((n) => ({ id: n.id, names: [n.name, ...(n.otherNames ?? [])] }));
  const lobby = db.select({ name: member.name }).from(member).where(eq(member.gameId, gameId)).all().map((m) => m.name);
  const scrub = (text: string) => exampleTokens(text, npcs, lobby).split(PLAYER_TOKEN).join('ผู้เล่น');
  const hasLobbyName = (text: string) => lobby.some((name) => containsName(text, name));
  return { scrub, hasLobbyName };
}

/** The average rating of the members now (null = nobody rated) and the non-empty comments. */
function ratingsOf(db: DbOrTx, gameId: string) {
  const members = new Set(activeMembers(db, gameId).map((m) => m.id));
  const rows = db.select().from(gameRating).where(eq(gameRating.gameId, gameId)).all().filter((r) => members.has(r.memberId));
  return {
    average: rows.length === 0 ? null : rows.reduce((sum, r) => sum + r.score, 0) / rows.length,
    comments: rows.map((r) => r.comment.trim()).filter((c) => c.length > 0),
  };
}

/** The extract's input: only what the end page shows every player, names scrubbed. */
export function learningSourceFor(db: Db, assets: GameAssets, gameId: string) {
  const { scrub } = scrubberOf(db, gameId);
  const reveal = revealFor(db, assets, gameId);
  const players = activeMembers(db, gameId).filter((m) => m.role === 'player');
  // Timeline events every player saw (a place event only its witnesses saw is not on everyone's page).
  const seen = players.map((p) => timelineFor(db, p).events);
  const timeline = (seen[0] ?? []).filter((e) => seen.every((list) => list.some((x) => x.id === e.id)));
  const { average, comments } = ratingsOf(db, gameId);
  return {
    average,
    comments: comments.length,
    input: {
      ending: { reason: getEnding(db, gameId)?.reason ?? null, path: reveal.path },
      players: reveal.players.map((p, i) => ({
        player: `ผู้เล่น ${i + 1}`,
        character: p.characterName,
        title: p.finalTitle ?? null,
        karma: p.karmaTier,
        outcome: p.outcome,
        spawn: p.spawn === null ? null : scrub(p.spawn),
        companions: p.companions.map(scrub),
        secretActions: p.secretActions.map((s) => ({ day: s.day, phase: s.phase, text: scrub(s.text) })),
        epilogue: p.epilogue ? scrub(p.epilogue) : null,
      })),
      timeline: timeline.map((e) => ({ day: e.day, phase: e.phase, title: scrub(e.title), status: e.status })),
      comments: comments.map(scrub),
    },
  };
}

const countsOf = (db: DbOrTx, gameId: string) => {
  const rows = db.select({ type: learningEntry.type }).from(learningEntry).where(eq(learningEntry.sourceGameId, gameId)).all();
  return { lore: rows.filter((r) => r.type === 'lore').length, feedback: rows.filter((r) => r.type === 'feedback_note').length };
};

export type ExtractOutcome = { kind: 'not_found' } | { kind: 'not_ended' } | { kind: 'ok'; body: LearningExtractResponse };

export interface LearningExtractor {
  /** Extracts once per game (a repeat or a call while one runs gets the same answer); resolves when stored. */
  extract(gameId: string): Promise<ExtractOutcome>;
  /** Resolves when no extract is running (shutdown). */
  idle(): Promise<void>;
}

export function createLearningExtractor(deps: { db: Db; ai: AiService; assets: GameAssets; now: Clock; log: (line: string) => void }): LearningExtractor {
  const { db, ai, assets, now, log } = deps;
  const running = new Map<string, Promise<ExtractOutcome>>();

  const failed = (gameId: string, error: string): ExtractOutcome => {
    const at = now();
    db.insert(learningExtract).values({ gameId, status: 'failed', error, updatedAt: at }).onConflictDoUpdate({ target: learningExtract.gameId, set: { status: 'failed', error, updatedAt: at } }).run();
    log(`[learning] game=${gameId} extract failed: ${error}`);
    return { kind: 'ok', body: { status: 'failed', message: FAILED, ...countsOf(db, gameId) } };
  };

  async function run(gameId: string): Promise<ExtractOutcome> {
    const row = db.select({ name: game.name }).from(game).where(eq(game.id, gameId)).get();
    if (!row) return { kind: 'not_found' };
    if (!gameEnded(db, gameId)) return { kind: 'not_ended' };
    const state = db.select().from(learningExtract).where(eq(learningExtract.gameId, gameId)).get();
    if (state?.status === 'done') return { kind: 'ok', body: { status: 'done', message: 'สกัดความรู้แล้ว', ...countsOf(db, gameId) } };

    const source = learningSourceFor(db, assets, gameId);
    const { scrub, hasLobbyName } = scrubberOf(db, gameId);
    const ask = () =>
      ai.call({
        gameId,
        purpose: 'learning_extract',
        system: [{ id: 'learning-extract', text: LEARNING_EXTRACT_INSTRUCTIONS, cache: true }],
        messages: [{ role: 'user', text: JSON.stringify(source.input) }],
        output: { name: 'learning_extract', schema: ExtractAnswer },
        maxOutputTokens: 1_000,
      });
    const first = await ask();
    if (!first.ok) return failed(gameId, (first.error.detail ?? first.error.code).split(':')[0]!.slice(0, 40));

    /** The answer's entries, scrubbed; `named`: still holds a lobby name (never stored). */
    const entriesOf = (answer: ExtractAnswer) =>
      [
        ...answer.lore.map((l, i) => ({ type: 'lore', sourceRef: `lore-${i + 1}`, content: l.content, tags: l.tags, detail: { endingPath: source.input.ending.path ?? 'none', npcIds: l.npcIds } })),
        ...(answer.feedback && source.comments > 0 ? [{ type: 'feedback_note', sourceRef: 'feedback', content: answer.feedback.content, tags: [] as string[], detail: { fromComments: source.comments } }] : []),
      ].map((e) => ({ ...e, named: hasLobbyName(e.content), content: scrub(e.content) }));
    let entries = entriesOf(first.value);
    if (entries.some((e) => e.named)) {
      // C8: one retry; an entry that still names someone is dropped.
      const second = await ask();
      if (second.ok) entries = entriesOf(second.value);
      const dropped = entries.filter((e) => e.named);
      if (dropped.length > 0) log(`[learning] game=${gameId} ${dropped.length} entr${dropped.length === 1 ? 'y' : 'ies'} dropped: a lobby name after the retry (${dropped.map((e) => e.sourceRef).join(', ')})`);
    }

    const at = now();
    db.transaction((tx) => {
      for (const e of entries.filter((x) => !x.named)) {
        tx.insert(learningEntry)
          .values({
            type: e.type,
            sourceGameId: gameId,
            sourceGameName: row.name,
            sourceScore: source.average,
            sourceRef: e.sourceRef,
            content: e.content,
            tags: JSON.stringify([...new Set(e.tags.map((t) => t.toLowerCase()).filter((t) => TAG.test(t)))]),
            detail: JSON.stringify(e.detail),
            status: 'active',
            createdAt: at,
          })
          .onConflictDoNothing()
          .run();
      }
      tx.insert(learningExtract).values({ gameId, status: 'done', error: null, updatedAt: at }).onConflictDoUpdate({ target: learningExtract.gameId, set: { status: 'done', error: null, updatedAt: at } }).run();
    });
    const counts = countsOf(db, gameId);
    log(`[learning] game=${gameId} extract done: ${counts.lore} lore, ${counts.feedback} feedback`);
    return { kind: 'ok', body: { status: 'done', message: 'สกัดความรู้แล้ว', ...counts } };
  }

  return {
    extract(gameId) {
      const busy = running.get(gameId);
      if (busy) return busy;
      const job = run(gameId)
        .catch((error: unknown) => failed(gameId, error instanceof Error ? error.name : 'unknown error'))
        .finally(() => running.delete(gameId));
      running.set(gameId, job);
      return job;
    },
    idle: async () => {
      await Promise.all([...running.values()]);
    },
  };
}

/** Q-363: the extract state of a game for its owner's end page. */
export function extractStatus(db: DbOrTx, gameId: string): 'pending' | 'done' | 'failed' {
  return db.select({ status: learningExtract.status }).from(learningExtract).where(eq(learningExtract.gameId, gameId)).get()?.status ?? 'pending';
}

/**
 * Q-364: ended games never extracted whose phase last changed (the end) `afterMs` or longer ago. A failed one is left
 * to its owner's retry (Q-363), so a broken AI is not called again every check.
 */
export function extractDue(db: DbOrTx, now: number, afterMs: number): string[] {
  return db
    .select({ gameId: gamePhase.gameId })
    .from(gamePhase)
    .leftJoin(learningExtract, eq(learningExtract.gameId, gamePhase.gameId))
    .where(and(isNull(learningExtract.gameId), lte(gamePhase.updatedAt, now - afterMs)))
    .all()
    .map((r) => r.gameId)
    .filter((gameId) => gameEnded(db, gameId));
}

/** Q-364: checks at start and every hour; returns the stop. */
export function startAutoExtract(db: Db, learning: LearningExtractor, now: Clock, afterMs: number): () => void {
  const run = () => {
    for (const gameId of extractDue(db, now(), afterMs)) void learning.extract(gameId);
  };
  run();
  const timer = setInterval(run, 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** True when every member of the ended game rated it (the extract then starts by itself). */
export function everyoneRated(db: DbOrTx, gameId: string): boolean {
  const members = activeMembers(db, gameId).map((m) => m.id);
  const rated = new Set(db.select({ memberId: gameRating.memberId }).from(gameRating).where(eq(gameRating.gameId, gameId)).all().map((r) => r.memberId));
  return members.length > 0 && members.every((m) => rated.has(m));
}
