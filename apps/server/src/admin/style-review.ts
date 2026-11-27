import {
  isVotableEntry,
  StyleProposalKind,
  type StyleGoodCandidate,
  type StyleProposal,
  type StyleReviewResponse,
  type StyleReviewRound,
  type StyleSignalCounts,
  type VoteReason,
} from '@isekai/protocol';
import { and, asc, desc, eq, gt, inArray, like, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { AiService } from '../ai/core/service.ts';
import type { GameDataStore } from '../assets/game-data.ts';
import { ForbiddenRule, NpcVoice, VoiceAsset } from '../assets/voice.ts';
import type { Clock } from '../auth/join.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { appMeta, gameDataAudit, npcExample, responseVote, roomEntry, styleReviewRound, styleRuleProposal } from '../db/schema.ts';
import { exampleTokens } from '../gm/npc-examples.ts';
import { styleFlagStats, styleIssues } from '../gm/style-check.ts';
import { gameVotes } from '../room/vote.ts';
import { isClueRow, type EntryMeta, type RoomEntryRow } from '../room/store.ts';
import { getGameScenario } from '../scenario/store.ts';
import { memberNames, npcOf, sceneOf } from './vote-review.ts';
import { npcCandidates } from '../learning/examples.ts';
import { gameEnded } from '../rating/store.ts';

/**
 * GEN-178 (ADR "Learning Across Games" R7, Q-335..Q-338): the style review round. The server counts the 👎 (with
 * their GEN-168 reason chips) and GEN-169 style flags new since the last `done` round; under 20 the round is
 * `skipped` (no AI call). Otherwise one `style_review` call (the AI service's model, claude-sonnet-5-5 by default)
 * reads the counts, ≤ 120 AI messages with names swapped for tokens, and the current Voice, and proposes rules.
 * Each proposal must pass the Voice schema of its kind; it changes nothing until the server owner approves it, which
 * saves the Voice as a new version through the game data store (backup + audit), so the next call uses it.
 */

export const STYLE_REVIEW_MIN_SIGNALS = 20;
export const STYLE_REVIEW_GAMES = 5;
/** The ai_usage game id of a call that belongs to no game. */
export const SYSTEM_USAGE_ID = 'system';
const MAX_EXAMPLES = 120;
const EXAMPLE_CHARS = 300;
const GAMES_KEY = 'style_review_games';

const Evidence = z.array(z.number().int()).max(5).default([]);
/** Loose on `content` on purpose: each proposal is checked alone, so one bad rule does not lose the round (R7). */
const ReviewAnswer = z.object({
  patterns: z.array(z.object({ summary: z.string().min(1).max(300), evidence: Evidence })).max(10).default([]),
  proposals: z
    .array(z.object({ kind: StyleProposalKind, npcId: z.string().nullable().default(null), content: z.record(z.string(), z.unknown()), reason: z.string().max(300).default(''), evidence: Evidence }))
    .max(10)
    .default([]),
});

const Pair = VoiceAsset.shape.pairs.element;

export const STYLE_REVIEW_INSTRUCTIONS = [
  'You are the Thai-language editor of a fantasy TRPG. The job: review the AI GM\'s wording from the players\' signals',
  'Data: count tables (👎 by reason chip, style-check flags by rule id, by NPC id where "" = narration) and samples of text the AI wrote (ref = the text\'s number) with each text\'s chips and flags',
  'People and NPC names are tokens ({{p:player}}, {{n:id}}): never write a real name or quote a player\'s text in a rule',
  'Do: 1) patterns = mistakes that repeat, a short summary in Thai, with at most 5 refs as evidence',
  '2) proposals = at most 10 new rules for the style guide (Voice), each one of:',
  '- kind "forbid": content = ForbiddenRule { id (a-z0-9_), match { type literal|regex|density ... }, scope narration|dialogue|all, severity flag|block, fix } (block only for words that must be rewritten every time)',
  '- kind "pair": content = { bad, good } short Thai examples ≤ 120 characters',
  '- kind "npc_patch": npcId = the id of an NPC in Voice, content = only the profile fields to change (self, you, particles, catchphrases, never, neverWords, note, register)',
  'Propose only general rules with enough evidence, not repeating a rule Voice already has. reason = a short reason in Thai. Every text a rule makes the game write (fix, good, catchphrases, ...) is natural literary Thai, not translated style',
].join('\n');

type Snapshot = Record<string, number>;
const flagKey = (npcId: string | null, reason: string) => `${npcId ?? ''}|${reason}`;
const metaOf = (row: RoomEntryRow): EntryMeta => (row.meta === null ? {} : (JSON.parse(row.meta) as EntryMeta));
const npcIdOf = (row: RoomEntryRow) => (row.kind === 'npc' ? (metaOf(row).npc?.id ?? null) : null);
const bump = (map: Record<string, number>, key: string, by = 1) => (map[key] = (map[key] ?? 0) + by);

function readMeta<T>(db: DbOrTx, key: string, fallback: T): T {
  const row = db.select().from(appMeta).where(eq(appMeta.key, key)).get();
  try {
    return row ? (JSON.parse(row.value) as T) : fallback;
  } catch {
    return fallback;
  }
}
const writeMeta = (db: DbOrTx, key: string, value: unknown) =>
  db.insert(appMeta).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: appMeta.key, set: { value: JSON.stringify(value) } }).run();

/** The checker's running flag counts by NPC and rule. */
const flagTotals = (db: Db): Snapshot => Object.fromEntries(styleFlagStats(db).map((s) => [flagKey(s.npc?.id ?? null, s.reason), s.count]));

/** What the last `done` round used: 👎 up to `toAt`, flags up to the snapshot. */
function lastUsed(db: DbOrTx): { toAt: number; snapshot: Snapshot } {
  const row = db.select().from(styleReviewRound).where(eq(styleReviewRound.status, 'done')).orderBy(desc(styleReviewRound.id)).get();
  return row ? { toAt: row.toAt, snapshot: JSON.parse(row.flagSnapshot) as Snapshot } : { toAt: Number.MIN_SAFE_INTEGER, snapshot: {} };
}

interface Downvoted {
  row: RoomEntryRow;
  down: number;
  reasons: Set<VoteReason>;
}

/** The signals new since the last `done` round, up to `at`: counts, the 👎 messages, and the flag snapshot now. */
function newSignals(db: Db, at: number) {
  const used = lastUsed(db);
  const votes = db
    .select()
    .from(responseVote)
    .where(and(eq(responseVote.vote, 'down'), like(responseVote.sourceRef, 'entry-%'), gt(responseVote.updatedAt, used.toAt), lte(responseVote.updatedAt, at)))
    .all();
  const ids = [...new Set(votes.map((v) => Number(v.sourceRef.slice('entry-'.length))))];
  // R6: only what the AI wrote (a whisper, a player's own line or a fallback template never counts).
  const rows = new Map((ids.length === 0 ? [] : db.select().from(roomEntry).where(inArray(roomEntry.id, ids)).all()).filter((r) => isVotableEntry(r)).map((r) => [r.id, r]));
  const counts: StyleSignalCounts = { downvotes: 0, flags: 0, reasons: {}, rules: {}, npcs: {} };
  const downvoted = new Map<number, Downvoted>();
  for (const v of votes) {
    const row = rows.get(Number(v.sourceRef.slice('entry-'.length)));
    if (!row || row.gameId !== v.gameId) continue;
    const reasons = JSON.parse(v.reasons) as VoteReason[];
    counts.downvotes += 1;
    for (const r of reasons) bump(counts.reasons, r);
    bump(counts.npcs, npcIdOf(row) ?? '');
    const d = downvoted.get(row.id) ?? { row, down: 0, reasons: new Set<VoteReason>() };
    d.down += 1;
    for (const r of reasons) d.reasons.add(r);
    downvoted.set(row.id, d);
  }
  const snapshot = flagTotals(db);
  for (const [key, total] of Object.entries(snapshot)) {
    const fresh = total - (used.snapshot[key] ?? 0);
    if (fresh <= 0) continue;
    const [npc = '', reason = ''] = key.split('|');
    counts.flags += fresh;
    bump(counts.rules, reason, fresh);
    bump(counts.npcs, npc, fresh);
  }
  return { counts, snapshot, downvoted, since: used.toAt };
}

type Voice = z.infer<typeof VoiceAsset>;

/** Names of the game's players and NPCs → tokens (the learning scrub: no lobby name, character name or NPC name). */
function scrubber(db: DbOrTx) {
  const cache = new Map<string, (text: string) => string>();
  return (row: RoomEntryRow) => {
    let scrub = cache.get(row.gameId);
    if (!scrub) {
      const npcs = (getGameScenario(db, row.gameId)?.npcs ?? []).map((n) => ({ id: n.id, names: [n.name, ...(n.otherNames ?? [])] }));
      const players = memberNames(db, row.gameId).flat();
      scrub = (text: string) => exampleTokens(text, npcs, players);
      cache.set(row.gameId, scrub);
    }
    return scrub(row.text).slice(0, EXAMPLE_CHARS);
  };
}

/** ≤ 120 AI messages: the most 👎 first, then the most flagged written since the last round. */
function examplesOf(db: Db, voice: Voice, signals: ReturnType<typeof newSignals>) {
  const scrub = scrubber(db);
  const issues = (row: RoomEntryRow) => {
    const npc = npcIdOf(row);
    return [...new Set(styleIssues(voice, row.text, npc === null ? 'narration' : 'dialogue', npc).map((i) => i.reason))];
  };
  const down = [...signals.downvoted.values()].sort((a, b) => b.down - a.down || b.row.id - a.row.id);
  const flagged = db
    .select()
    .from(roomEntry)
    .where(gt(roomEntry.createdAt, signals.since))
    .orderBy(desc(roomEntry.id))
    .limit(2_000)
    .all()
    // ISK-013: a clue is the server's template, not AI text to review.
    .filter((r) => isVotableEntry(r) && !isClueRow(r) && !signals.downvoted.has(r.id))
    .map((row) => ({ row, flags: issues(row) }))
    .filter((e) => e.flags.length > 0)
    .sort((a, b) => b.flags.length - a.flags.length || b.row.id - a.row.id);
  const view = (row: RoomEntryRow, extra: { down: number; reasons: VoteReason[]; flags: string[] }) => ({
    ref: row.id,
    scene: sceneOf(row, metaOf(row)),
    npc: npcIdOf(row),
    ...extra,
    text: scrub(row),
  });
  return [
    ...down.map((d) => view(d.row, { down: d.down, reasons: [...d.reasons], flags: issues(d.row) })),
    ...flagged.map((f) => view(f.row, { down: 0, reasons: [], flags: f.flags })),
  ].slice(0, MAX_EXAMPLES);
}

/** The proposal's content as the Voice schema of its kind keeps it, or the paths that fail. */
function checkProposal(voice: Voice, kind: StyleProposalKind, npcId: string | null, content: unknown): { ok: true; content: Record<string, unknown> } | { ok: false; paths: string[] } {
  const paths = (error: z.ZodError) => [...new Set(error.issues.map((i) => i.path.join('.') || '(root)'))];
  if (kind === 'forbid') {
    const parsed = ForbiddenRule.safeParse(content);
    return parsed.success ? { ok: true, content: parsed.data } : { ok: false, paths: paths(parsed.error) };
  }
  if (kind === 'pair') {
    const parsed = Pair.safeParse(content);
    return parsed.success ? { ok: true, content: parsed.data } : { ok: false, paths: paths(parsed.error) };
  }
  if (npcId === null || !(npcId in voice.npcs)) return { ok: false, paths: ['npcId'] };
  const parsed = NpcVoice.partial().safeParse(content);
  if (!parsed.success) return { ok: false, paths: paths(parsed.error) };
  // Only the fields the patch names (a partial schema may fill in defaults of the others).
  const keys = new Set(Object.keys(content as object));
  return { ok: true, content: Object.fromEntries(Object.entries(parsed.data).filter(([k]) => keys.has(k))) };
}

/** Version → its JSON as last saved (or, for one only seen before an edit, as it was then) and when. */
function voiceHistory(db: DbOrTx): Map<number, { json: string; at: number | null }> {
  const out = new Map<number, { json: string; at: number | null }>();
  const rows = db.select().from(gameDataAudit).where(eq(gameDataAudit.name, 'Voice')).orderBy(asc(gameDataAudit.id)).all();
  const version = (json: string) => (JSON.parse(json) as { version?: unknown }).version;
  for (const r of rows) {
    const before = version(r.oldJson);
    if (typeof before === 'number' && !out.has(before)) out.set(before, { json: r.oldJson, at: null });
    const after = version(r.newJson);
    if (typeof after === 'number') out.set(after, { json: r.newJson, at: r.at });
  }
  return out;
}

const iso = (t: number) => new Date(t).toISOString();

const roundView = (r: typeof styleReviewRound.$inferSelect): StyleReviewRound => ({
  id: r.id,
  trigger: r.trigger,
  status: r.status,
  signals: r.signals,
  counts: JSON.parse(r.counts) as StyleSignalCounts,
  patterns: JSON.parse(r.patterns) as StyleReviewRound['patterns'],
  error: r.error,
  createdAt: iso(r.createdAt),
});

const proposalView = (p: typeof styleRuleProposal.$inferSelect): StyleProposal => ({
  id: p.id,
  roundId: p.roundId,
  kind: p.kind,
  npcId: p.npcId,
  content: JSON.parse(p.content) as Record<string, unknown>,
  reason: p.reason,
  evidence: JSON.parse(p.evidence) as number[],
  status: p.status,
  voiceVersion: p.voiceVersion,
  decidedAt: p.decidedAt === null ? null : iso(p.decidedAt),
});

/**
 * R13: NPC lines most of their game's players liked (GEN-126 voteVerdict good), not yet in the GEN-151 library. An
 * ended game's lines come from GEN-081's kept good examples (one list, so no line twice); a game still playing is read live.
 */
function goodCandidates(db: DbOrTx): StyleGoodCandidate[] {
  const inLibrary = new Set(db.select().from(npcExample).where(eq(npcExample.source, 'vote')).all().map((r) => `${r.gameId}/${r.entryId}`));
  const games = [...new Set(db.select({ gameId: responseVote.gameId }).from(responseVote).where(and(eq(responseVote.vote, 'up'), like(responseVote.sourceRef, 'entry-%'))).all().map((r) => r.gameId))].filter((g) => !gameEnded(db, g));
  return [...npcCandidates(db), ...games.flatMap((gameId) => {
    const good = gameVotes(db, gameId).entries.filter((e) => e.good && e.kind === 'npc' && !inLibrary.has(`${gameId}/${e.seq}`));
    if (good.length === 0) return [];
    const rows = new Map(db.select().from(roomEntry).where(inArray(roomEntry.id, good.map((e) => e.seq))).all().map((r) => [r.id, r]));
    return good.flatMap((e) => {
      const row = rows.get(e.seq);
      const npc = row && isVotableEntry(row) ? npcOf(db, row, metaOf(row)) : null;
      return npc ? [{ gameId, seq: e.seq, npc, text: e.text, up: e.up }] : [];
    });
  })];
}

export type StyleDecision =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'decided' }
  | { ok: false; reason: 'invalid'; message: string; fields: Record<string, string> };

export interface StyleReview {
  /** One game ended (`finale` / `game_over`); the 5th since the last round starts one. Resolves when that round ends. */
  gameEnded(gameId: string): Promise<void>;
  /** Runs a round now unless one is running; resolves when it is stored. */
  run(trigger: 'games' | 'manual'): Promise<void>;
  state(): StyleReviewResponse;
  approve(id: number, content?: Record<string, unknown>): StyleDecision;
  reject(id: number): StyleDecision;
  /** Saves that version's Voice as the current one (a new edit; later versions stay in the audit). */
  restore(version: number): StyleDecision;
  /** Resolves when no round is running (shutdown). */
  idle(): Promise<void>;
}

export function createStyleReview(deps: { db: Db; ai: AiService; gameData: GameDataStore; now: Clock; log: (line: string) => void }): StyleReview {
  const { db, ai, gameData, now, log } = deps;
  let running: Promise<void> | null = null;

  async function round(trigger: 'games' | 'manual'): Promise<void> {
    const at = now();
    const signals = newSignals(db, at);
    const total = signals.counts.downvotes + signals.counts.flags;
    const base = { trigger, signals: total, counts: JSON.stringify(signals.counts), toAt: at, flagSnapshot: JSON.stringify(signals.snapshot), createdAt: at };
    if (total < STYLE_REVIEW_MIN_SIGNALS) {
      const row = db.insert(styleReviewRound).values({ ...base, status: 'skipped' }).returning().get();
      log(`[style-review] round ${row.id} ${trigger} skipped: ${total} signals (< ${STYLE_REVIEW_MIN_SIGNALS})`);
      return;
    }
    const voice = gameData.assets.voice;
    const result = await ai.call({
      gameId: SYSTEM_USAGE_ID,
      purpose: 'style_review',
      system: [
        { id: 'style-review', text: STYLE_REVIEW_INSTRUCTIONS, cache: true },
        { id: 'voice', text: `The current style guide (Voice):\n${JSON.stringify({ guide: voice.guide, forbidden: voice.forbidden, pairs: voice.pairs, npcs: voice.npcs })}`, cache: true },
      ],
      messages: [{ role: 'user', text: JSON.stringify({ counts: signals.counts, examples: examplesOf(db, voice, signals) }) }],
      output: { name: 'style_review', schema: ReviewAnswer },
      maxOutputTokens: 3_000,
      effort: 'medium',
    });
    if (!result.ok) {
      // R16: no proposal is written; the signals stay unused for the next round.
      const error = (result.error.detail ?? result.error.code).split(':')[0]!.slice(0, 40);
      const row = db.insert(styleReviewRound).values({ ...base, status: 'failed', error }).returning().get();
      log(`[style-review] round ${row.id} ${trigger} failed: ${error}`);
      return;
    }
    const checked = result.value.proposals.map((p, i) => ({ p, i, check: checkProposal(voice, p.kind, p.npcId, p.content) }));
    const roundId = db.transaction((tx) => {
      const row = tx.insert(styleReviewRound).values({ ...base, status: 'done', patterns: JSON.stringify(result.value.patterns) }).returning().get();
      for (const { p, check } of checked) {
        if (!check.ok) continue;
        tx.insert(styleRuleProposal)
          .values({ roundId: row.id, kind: p.kind, npcId: p.kind === 'npc_patch' ? p.npcId : null, content: JSON.stringify(check.content), reason: p.reason, evidence: JSON.stringify(p.evidence), status: 'proposed' })
          .run();
      }
      return row.id;
    });
    // R7: a proposal off the Voice schema is dropped and logged (kind and failing paths only, never its text).
    for (const { p, i, check } of checked) if (!check.ok) log(`[style-review] round ${roundId} proposal ${i + 1} (${p.kind}) dropped: not the Voice schema at ${check.paths.join(', ')}`);
    log(`[style-review] round ${roundId} ${trigger} done: ${total} signals, ${checked.filter((c) => c.check.ok).length} proposals`);
  }

  function run(trigger: 'games' | 'manual'): Promise<void> {
    if (running) return running;
    running = round(trigger)
      .catch((error: unknown) => log(`[style-review] round failed: ${error instanceof Error ? error.name : 'unknown error'}`))
      .finally(() => {
        running = null;
      });
    return running;
  }

  function versionsNow() {
    const history = voiceHistory(db);
    const current = gameData.assets.voice.version;
    if (!history.has(current)) history.set(current, { json: '', at: null });
    return { current, history };
  }

  const proposal = (id: number) => db.select().from(styleRuleProposal).where(eq(styleRuleProposal.id, id)).get();

  return {
    run,
    idle: () => running ?? Promise.resolve(),
    gameEnded(gameId) {
      const ids = readMeta<string[]>(db, GAMES_KEY, []);
      if (ids.includes(gameId)) return Promise.resolve();
      ids.push(gameId);
      // While a round runs the 5th game waits: the next game end starts the round.
      if (ids.length < STYLE_REVIEW_GAMES || running) {
        writeMeta(db, GAMES_KEY, ids);
        return Promise.resolve();
      }
      writeMeta(db, GAMES_KEY, []);
      return run('games');
    },
    state() {
      const { current, history } = versionsNow();
      return {
        running: running !== null,
        minSignals: STYLE_REVIEW_MIN_SIGNALS,
        gamesPerRound: STYLE_REVIEW_GAMES,
        gamesSinceRound: readMeta<string[]>(db, GAMES_KEY, []).length,
        waiting: newSignals(db, now()).counts,
        rounds: db.select().from(styleReviewRound).orderBy(desc(styleReviewRound.id)).limit(20).all().map(roundView),
        proposals: db.select().from(styleRuleProposal).orderBy(desc(styleRuleProposal.roundId), asc(styleRuleProposal.id)).limit(100).all().map(proposalView),
        voice: {
          version: current,
          versions: [...history]
            .sort((a, b) => b[0] - a[0])
            .map(([version, v]) => ({ version, at: v.at === null ? null : iso(v.at), current: version === current })),
        },
        goodCandidates: goodCandidates(db),
      };
    },
    approve(id, edited) {
      const row = proposal(id);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.status !== 'proposed') return { ok: false, reason: 'decided' };
      const voice = gameData.assets.voice;
      const check = checkProposal(voice, row.kind, row.npcId, edited ?? JSON.parse(row.content));
      if (!check.ok) return { ok: false, reason: 'invalid', message: 'กฎนี้ไม่ผ่าน schema ของ Voice', fields: Object.fromEntries(check.paths.map((p) => [p, 'ไม่ผ่าน schema'])) };
      const raw = gameData.get('Voice')?.value as Voice;
      const { history } = versionsNow();
      const version = Math.max(voice.version, ...history.keys()) + 1;
      const content = check.content;
      const next: Voice =
        row.kind === 'forbid'
          ? { ...raw, version, forbidden: [...raw.forbidden.filter((r) => r.id !== content.id), content as ForbiddenRule] }
          : row.kind === 'pair'
            ? { ...raw, version, pairs: [...raw.pairs, content as Voice['pairs'][number]] }
            : { ...raw, version, npcs: { ...raw.npcs, [row.npcId!]: { ...raw.npcs[row.npcId!]!, ...content } } };
      const saved = gameData.save('Voice', next);
      if (!saved.ok) return saved.reason === 'invalid' ? saved : { ok: false, reason: 'not_found' };
      db.update(styleRuleProposal).set({ status: 'approved', content: JSON.stringify(content), voiceVersion: version, decidedAt: now() }).where(eq(styleRuleProposal.id, id)).run();
      log(`[style-review] proposal ${id} approved: Voice version ${version}`);
      return { ok: true };
    },
    reject(id) {
      const row = proposal(id);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.status !== 'proposed') return { ok: false, reason: 'decided' };
      db.update(styleRuleProposal).set({ status: 'rejected', decidedAt: now() }).where(eq(styleRuleProposal.id, id)).run();
      return { ok: true };
    },
    restore(version) {
      const { current, history } = versionsNow();
      if (version === current) return { ok: true };
      const saved = history.get(version);
      if (!saved || saved.json === '') return { ok: false, reason: 'not_found' };
      const outcome = gameData.save('Voice', JSON.parse(saved.json));
      if (!outcome.ok) return outcome.reason === 'invalid' ? outcome : { ok: false, reason: 'not_found' };
      log(`[style-review] Voice restored to version ${version} (was ${current})`);
      return { ok: true };
    },
  };
}
