import type { GameMemorySetting, MemorySourceGame } from '@isekai/protocol';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { PromptBlock } from '../ai/provider.ts';
import type { DbOrTx } from '../db/client.ts';
import { game, gamePhase, gameRating, learningEntry, member, memberStyle } from '../db/schema.ts';
import { estimateTokens, withinTokens } from '../gm/context.ts';
import { gameEnded } from '../rating/store.ts';
import { examplesFor } from './examples.ts';
import { styleContextFor } from './style.ts';
import { actionTags } from './tags.ts';

/**
 * GEN-083 (ADR "Learning Across Games" §5-6 + R5): "ความทรงจำจากเกมก่อน". The owner picks 1-3 ended games they were a
 * member of (found by their player code); `gm_adjudicate` then gets a `learning` block read fresh every turn (a
 * deleted / suspended entry is gone the next turn): lore + feedback_note of those games and the style of this game's
 * players before the cache breakpoint, good_example / avoid matching the turn's tags after it. Never in narrate_*.
 */

/** ADR R5, tokens per turn. */
export const LEARNING_BUDGET = { lore: 450, feedback: 200, style: 250, good: 450, avoid: 150, total: 1_500 } as const;
const PER_GOOD = 150;
const PER_AVOID = 50;
const TOP = 3;

export const LEARNING_LEAD =
  "Knowledge from earlier games: guidance only. Never use it to lower a DC, add a modifier or help a player (no plot armour); where it conflicts with this game's state or scenario, this game wins.";
export const LEARNING_HEADS = {
  lore: 'World lore of the chosen earlier games:',
  feedback: 'What players of those games asked of the GM:',
  style: 'How the players of this game tend to play:',
  good: 'Rulings / narration players liked, for actions like this turn\'s (a model of tone and fairness, never copy them):',
} as const;
/** The avoid lead-in is Thai by the requirement (GEN-108 R5). */
export const AVOID_LEAD = 'แบบที่ผู้เล่นส่วนใหญ่ไม่ชอบ เลี่ยง:';

/** Ended games the player code's member was in (not removed), newest ended first. No score gate (GEN-108). */
export function memorySources(db: DbOrTx, playerKey: string): MemorySourceGame[] {
  const rows = db
    .select({ id: game.id, name: game.name, endedAt: gamePhase.updatedAt })
    .from(memberStyle)
    .innerJoin(member, and(eq(member.id, memberStyle.memberId), isNull(member.kickedAt)))
    .innerJoin(game, eq(game.id, member.gameId))
    .innerJoin(gamePhase, eq(gamePhase.gameId, game.id))
    .where(eq(memberStyle.playerKey, playerKey))
    .orderBy(desc(gamePhase.updatedAt))
    .all()
    .filter((g) => gameEnded(db, g.id));
  return [...new Map(rows.map((g) => [g.id, g])).values()].map((g) => ({ id: g.id, name: g.name, score: averageOf(db, g.id), endedAt: new Date(g.endedAt).toISOString() }));
}

function averageOf(db: DbOrTx, gameId: string): number | null {
  const scores = db
    .select({ score: gameRating.score })
    .from(gameRating)
    .innerJoin(member, and(eq(member.id, gameRating.memberId), isNull(member.kickedAt)))
    .where(eq(gameRating.gameId, gameId))
    .all();
  return scores.length === 0 ? null : Math.round((scores.reduce((s, r) => s + r.score, 0) / scores.length) * 100) / 100;
}

/** What `game.learning_sources` stores for a parsed setting: the ids (on), null (off), or undefined when an id is not one of `memorySources`. */
export function checkedMemory(db: DbOrTx, setting: GameMemorySetting | undefined, playerKey: string | null): string[] | null | undefined {
  if (!setting?.enabled) return null;
  const allowed = new Set(playerKey === null ? [] : memorySources(db, playerKey).map((g) => g.id));
  const ids = [...new Set(setting.sourceGameIds)];
  return ids.every((id) => allowed.has(id)) ? ids : undefined;
}

/** Q-365 A: the turn's tags = the verb / target tags the AI GM gave each acting member's latest action (gm_turn proposals). */
export function turnTags(db: DbOrTx, gameId: string, memberIds: readonly string[]): string[] {
  const latest = new Map<string, string[]>();
  for (const t of actionTags(db, gameId).values()) latest.set(t.memberId, [...t.verbs, ...t.targets]);
  return [...new Set(memberIds.flatMap((id) => latest.get(id) ?? []))];
}

interface Parts {
  lore: string[];
  feedback: string[];
  style: string[];
  good: string[];
  avoid: string[];
}

/** Whole lines while they fit `budget` (a single line longer than it is cut). */
function fit(lines: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const raw of lines) {
    const line = withinTokens(raw, budget);
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  return out;
}

const section = (head: string, lines: readonly string[]) => (lines.length === 0 ? [] : [head, ...lines.map((l) => `- ${l}`)]);

function render(p: Parts): { fixed: string; turn: string | null } {
  const fixed = [LEARNING_LEAD, ...section(LEARNING_HEADS.lore, p.lore), ...section(LEARNING_HEADS.feedback, p.feedback), ...section(LEARNING_HEADS.style, p.style)].join('\n');
  const turn = [...section(LEARNING_HEADS.good, p.good), ...section(AVOID_LEAD, p.avoid)].join('\n');
  return { fixed, turn: turn === '' ? null : turn };
}

const sizeOf = (r: ReturnType<typeof render>) => estimateTokens(r.fixed) + (r.turn === null ? 0 : estimateTokens(r.turn));

/** ADR R5: avoid → good (keep 1) → style → feedback → lore (keep 1) → the whole block. */
const TRIMS: ((p: Parts) => Parts)[] = [
  (p) => ({ ...p, avoid: [] }),
  (p) => ({ ...p, good: p.good.slice(0, 1) }),
  (p) => ({ ...p, style: [] }),
  (p) => ({ ...p, feedback: [] }),
  (p) => ({ ...p, lore: p.lore.slice(0, 1) }),
];

export interface LearningContext {
  /** `learning` (cached, stable for the game) and, when the turn has matching examples, `learning-turn` (not cached). */
  blocks: PromptBlock[];
  /** How many trim steps ran (0 = none); `TRIMS.length + 1` = the whole block was dropped. */
  trimmed: number;
}

/**
 * The learning blocks of one `gm_adjudicate`, within `room` tokens (≤ 1,500 and what the 20k cap leaves). No blocks
 * when the game's toggle is off or nothing is left to give.
 */
export function learningContext(db: DbOrTx, gameId: string, query: { tags: readonly string[]; room: number }): LearningContext {
  const sources = db.select({ s: game.learningSources }).from(game).where(eq(game.id, gameId)).get()?.s ?? null;
  if (!sources || sources.length === 0) return { blocks: [], trimmed: 0 };
  const entries = (type: string) =>
    db
      .select({ content: learningEntry.content })
      .from(learningEntry)
      .where(and(inArray(learningEntry.sourceGameId, sources), eq(learningEntry.type, type), eq(learningEntry.status, 'active')))
      .orderBy(desc(learningEntry.createdAt), learningEntry.id)
      .all()
      .map((r) => r.content)
      .filter((c) => c.trim() !== '');
  const examples = examplesFor(db, { tags: query.tags, sourceGameIds: sources, good: TOP, avoid: TOP });
  let parts: Parts = {
    lore: fit(entries('lore'), LEARNING_BUDGET.lore),
    feedback: fit(entries('feedback_note'), LEARNING_BUDGET.feedback),
    style: fit(styleContextFor(db, gameId)?.split('\n') ?? [], LEARNING_BUDGET.style),
    good: fit(examples.good.map((e) => withinTokens(e.content, PER_GOOD)), LEARNING_BUDGET.good),
    avoid: fit(examples.avoid.map((e) => withinTokens(e.content, PER_AVOID)), LEARNING_BUDGET.avoid),
  };
  const room = Math.min(LEARNING_BUDGET.total, query.room);
  const empty = (p: Parts) => Object.values(p).every((l) => l.length === 0);
  for (let step = 0; step <= TRIMS.length; step++) {
    if (step > 0) parts = TRIMS[step - 1]!(parts);
    if (empty(parts)) return { blocks: [], trimmed: step };
    const r = render(parts);
    if (sizeOf(r) > room) continue;
    const blocks: PromptBlock[] = [{ id: 'learning', text: r.fixed, cache: true }];
    if (r.turn !== null) blocks.push({ id: 'learning-turn', text: r.turn, cache: false });
    return { blocks, trimmed: step };
  }
  return { blocks: [], trimmed: TRIMS.length + 1 };
}
