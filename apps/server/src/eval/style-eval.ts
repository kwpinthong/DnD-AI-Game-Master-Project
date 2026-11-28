import { defaultScenario, NPC_REPLY_MAX_LENGTH, type StyleEvalMark, type StyleEvalResponse, type StyleEvalRun, type StyleEvalSceneResult } from '@isekai/protocol';
import { desc, eq, lt } from 'drizzle-orm';
import type { Weather } from '@isekai/rules';
import { z } from 'zod';
import type { AiConfig } from '../ai/config.ts';
import { createAiService } from '../ai/core/service.ts';
import { createUsageStore } from '../ai/core/usage.ts';
import type { AiProvider, PromptBlock } from '../ai/provider.ts';
import type { GameAssets } from '../assets/load.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { styleEvalRun } from '../db/schema.ts';
import { DIALOGUE_BLOCK, FINALE_BLOCK, JOURNAL_BLOCK, NARRATOR_BLOCK, SUMMARY_BLOCK } from '../gm/context.ts';
import { clampLine } from '../gm/npc-lines.ts';
import { SCENE_BLOCK } from '../gm/scene.ts';
import { GM_OUTPUT, GmDaySummary, GmDialogue, GmFinale, GmJournal, GmNarration, GmScene } from '../gm/schema.ts';
import { styleIssues } from '../gm/style-check.ts';
import { toneBlock } from '../gm/tone.ts';
import { NPC_CHAT_BLOCK, NpcChatAnswer } from '../npc-chat/prompt.ts';
import { STYLE_SCENES, type StyleScene, type StyleSceneContext } from './style-scenes.ts';

/**
 * GEN-167: runs the eval set once against the configured AI and saves the round (results, prompts, Voice version,
 * models, USD). Its AiUsage rows go under the pseudo game id below, so no real game is read or written.
 */
export const STYLE_EVAL_GAME_ID = 'style-eval';

/** One scene's call: the prompt the game would send for this context, and how to read the answer back as text. */
interface Call<T> {
  system: PromptBlock[];
  output: { name: string; schema: z.ZodType<T> };
  maxOutputTokens: number;
  scope: 'narration' | 'dialogue';
  texts: (value: T) => { text: string; npcId: string | null }[];
}

const call = <T>(c: Call<T>) => c as Call<unknown>;

/** The same system blocks, output schema and token cap as the game's own call for that context kind. */
function callFor(context: StyleSceneContext, assets: GameAssets): Call<unknown> {
  const tone = toneBlock(assets.voice, assets.voice.tone);
  switch (context.kind) {
    case 'gm_scene':
      return call({ system: [SCENE_BLOCK, tone], output: { name: GM_OUTPUT.scene, schema: GmScene }, maxOutputTokens: 600, scope: 'narration', texts: (v) => [{ text: v.text, npcId: null }] });
    case 'gm_narration':
      return call({
        system: [NARRATOR_BLOCK, tone],
        output: { name: GM_OUTPUT.narration, schema: GmNarration },
        maxOutputTokens: 1_500,
        scope: 'narration',
        texts: (v) => [...v.segments.map((s) => s.text), ...(v.arrival !== undefined ? [v.arrival] : [])].map((text) => ({ text, npcId: null })),
      });
    case 'gm_dialogue':
      // shortcut: no NPC example library block (GEN-151) in the eval, so a round does not depend on the DB's library; add it when the library is part of what is judged.
      return call({
        system: [DIALOGUE_BLOCK, tone],
        output: { name: GM_OUTPUT.dialogue, schema: GmDialogue },
        maxOutputTokens: 1_000,
        scope: 'dialogue',
        texts: (v) => v.npcLines.map((l) => ({ text: l.text, npcId: l.npcId })),
      });
    case 'gm_journal':
      return call({ system: [JOURNAL_BLOCK], output: { name: GM_OUTPUT.journal, schema: GmJournal }, maxOutputTokens: 3_000, scope: 'narration', texts: (v) => [{ text: v.journal, npcId: null }, { text: v.saga, npcId: null }] });
    case 'gm_day':
      return call({ system: [SUMMARY_BLOCK], output: { name: GM_OUTPUT.daySummary, schema: GmDaySummary }, maxOutputTokens: 3_000, scope: 'narration', texts: (v) => [{ text: v.recap, npcId: null }, { text: v.saga, npcId: null }] });
    case 'gm_finale':
      return call({
        system: [FINALE_BLOCK, tone],
        output: { name: GM_OUTPUT.finale, schema: GmFinale },
        maxOutputTokens: 4_000,
        scope: 'narration',
        texts: (v) => [{ text: v.overall, npcId: null }, ...v.players.map((p) => ({ text: p.text, npcId: null }))],
      });
    case 'npc_chat':
      // As gm_dialogue: no example library block. 400 = the cap of npc-chat/service.ts.
      return call({
        system: [NPC_CHAT_BLOCK, tone],
        output: { name: 'npc_chat', schema: NpcChatAnswer },
        maxOutputTokens: 400,
        scope: 'dialogue',
        texts: (v) => [{ text: v.reply, npcId: context.chat.npc.id }],
      });
  }
}

/** ISK-025: one judge call per NPC scene (chat or turn lines): the 4 parts of each reply, as booleans. Eval only, never in a game. */
const JUDGE_BLOCK: PromptBlock = {
  id: 'npc-reply-judge',
  cache: true,
  text: [
    'You judge NPC replies of a Thai fantasy game. The message JSON gives scene (everything the NPC was given: persona, voice, what the player said or did, the place, period, weather, who is around) and replies.',
    'For each reply, in order, answer 4 booleans:',
    '- persona: it sounds like this NPC (its persona and voice)',
    '- feeling: it shows how the NPC feels now through tone or a gesture (stating the feeling outright is false)',
    '- reaction: it reacts to what the player just said or did',
    '- place: it uses one real detail of here and now that the scene gives (place, period, weather, people around); a detail the scene does not give (rain when the weather is not rain) is false',
  ].join('\n'),
};
const JudgeAnswer = z.object({ verdicts: z.array(z.object({ persona: z.boolean(), feeling: z.boolean(), reaction: z.boolean(), place: z.boolean() })) });
const PARTS = ['persona', 'feeling', 'reaction', 'place'] as const;

/** ISK-026: one judge call per narration scene: the 4 parts of each action result, and C12 (never deciding for the player). Eval only. */
const RESULT_JUDGE_BLOCK: PromptBlock = {
  id: 'narration-judge',
  cache: true,
  text: [
    'You judge the action results of a Thai fantasy game narration. The message JSON gives scene (everything the narrator was given: beats = what the players did and how it went, the place, period, cast, NPCs) and results (each one action\'s result as the player reads it).',
    'For each result, in order, answer 5 booleans:',
    '- reaction: the world or the people here react to the action',
    '- feeling: it shows what the acting character senses or feels, through the body or what they see (stating the feeling outright is false)',
    '- persona: it has personality: a voice in the game\'s tone, or the manner of an NPC involved',
    '- place: it uses one real detail of here and now that the scene gives (place, period, weather, people); a detail the scene does not give is false',
    '- playerChoice: true = it never decides or feels for the player beyond what their action says; false = it adds a choice, a deed or a feeling the action did not state',
  ].join('\n'),
};
const ResultJudgeAnswer = z.object({
  verdicts: z.array(z.object({ persona: z.boolean(), feeling: z.boolean(), reaction: z.boolean(), place: z.boolean(), playerChoice: z.boolean() })),
});
type ResultVerdict = z.infer<typeof ResultJudgeAnswer>['verdicts'][number];

/** C4: weather words a reply may use only when the scene has that weather (a turn line's scene has none). */
const WEATHER_WORDS: [string, readonly Weather[]][] = [
  ['ฝน', ['Rain', 'Storm']],
  ['พายุ', ['Storm']],
  ['หมอก', ['Fog']],
];
const inventsWeather = (text: string, context: StyleSceneContext) => {
  const weather = context.kind === 'npc_chat' ? context.chat.scene.weather : null;
  return WEATHER_WORDS.some(([word, allowed]) => text.includes(word) && (weather === null || !allowed.includes(weather)));
};

/** Real NPC names of the scenario: the eval's readers know every NPC only by alias. */
const realNpcNames = () => defaultScenario().npcs.flatMap((n) => [n.name, ...(n.otherNames ?? [])]).filter((n) => n.trim().length > 1);

interface StoredScene extends StyleEvalSceneResult {
  prompt: { system: PromptBlock[]; user: string };
  /** ISK-025: each NPC reply of an NPC scene with its length and the judge's verdict (server only, like the prompt). */
  replies?: { text: string; chars: number; verdict: NpcReplyVerdict | null }[];
  /** ISK-026: each action result of a narration scene as the player reads it (`clampLine`), its raw length and the judge's verdict. */
  results?: { text: string; chars: number; raw: number; verdict: ResultVerdict | null }[];
}

export interface StyleEvalDeps {
  db: Db;
  assets: GameAssets;
  provider: AiProvider;
  config: AiConfig;
  now?: () => number;
  log?: (line: string) => void;
  /** The round stops calling once its spend reaches this (USD); the scenes left are reported as `budget`. */
  maxUsd: number;
}

export async function runStyleEval(deps: StyleEvalDeps, scenes: readonly StyleScene[] = STYLE_SCENES): Promise<StyleEvalRun> {
  const { db, assets, provider, config, maxUsd } = deps;
  const now = deps.now ?? Date.now;
  const store = createUsageStore(db);
  let sceneCost = 0;
  const models = new Set<string>();
  const ai = createAiService({
    provider,
    config,
    now,
    ...(deps.log ? { log: deps.log } : {}),
    usage: {
      record(row) {
        sceneCost += row.costUsdMicros;
        models.add(row.model);
        store.record(row);
      },
      spentThisMonth: (gameId, at) => store.spentThisMonth(gameId, at),
    },
  });
  const names = realNpcNames();
  const limit = Math.round(maxUsd * 1_000_000);
  let spent = 0;
  const results: StoredScene[] = [];
  for (const scene of scenes) {
    const c = callFor(scene.context, assets);
    const user = JSON.stringify(scene.context.kind === 'npc_chat' ? scene.context.chat : scene.context);
    const base = { sceneId: scene.id, title: scene.title, purpose: scene.purpose, prompt: { system: c.system, user } };
    if (spent >= limit) {
      results.push({ ...base, ok: false, text: null, failure: 'budget', flags: [], costUsdMicros: 0 });
      continue;
    }
    sceneCost = 0;
    // C4: one failed scene is reported and the set goes on.
    const result = await ai.call({ gameId: STYLE_EVAL_GAME_ID, purpose: scene.purpose, system: c.system, messages: [{ role: 'user', text: user }], output: c.output, maxOutputTokens: c.maxOutputTokens });
    if (!result.ok) {
      spent += sceneCost;
      results.push({ ...base, ok: false, text: null, failure: result.error.detail ?? result.error.code, flags: [], costUsdMicros: sceneCost });
      continue;
    }
    const parts = c.texts(result.value);
    const text = parts.map((p) => (p.npcId ? `{{n:${p.npcId}}}: ${p.text}` : p.text)).join('\n');
    // C5: a real name the reader should not know, then the Voice rules the game's checker flags (GEN-169).
    const flags = [...(names.some((n) => text.includes(n)) ? ['real_name'] : []), ...parts.flatMap((p) => styleIssues(assets.voice, p.text, c.scope, p.npcId).map((i) => i.reason))];
    // ISK-025: the NPC replies (scope dialogue = turn lines and chat): length, invented weather (C4), the judge's 4 parts.
    let replies: StoredScene['replies'];
    if (c.scope === 'dialogue' && parts.length > 0) {
      // shortcut: the judge runs as purpose npc_chat (the summary model) so the eval needs no AiPurpose of its own; add one if its usage must show apart.
      const judged = await ai.call({
        gameId: STYLE_EVAL_GAME_ID,
        purpose: 'npc_chat',
        system: [JUDGE_BLOCK],
        messages: [{ role: 'user', text: JSON.stringify({ scene: JSON.parse(user) as unknown, replies: parts.map((p) => p.text) }) }],
        output: { name: 'npc_reply_judge', schema: JudgeAnswer },
        maxOutputTokens: 300,
      });
      const verdicts = judged.ok && judged.value.verdicts.length === parts.length ? judged.value.verdicts : null;
      replies = parts.map((p, i) => ({ text: p.text, chars: [...p.text].length, verdict: verdicts?.[i] ?? null }));
      if (replies.some((r) => r.chars > NPC_REPLY_MAX_LENGTH)) flags.push('too_long');
      if (parts.some((p) => inventsWeather(p.text, scene.context))) flags.push('not_in_scene');
      if (!verdicts) flags.push('judge_failed');
      for (const part of PARTS) if (verdicts?.some((v) => !v[part])) flags.push(`missing_${part}`);
    }
    // ISK-026: the action results (not an arrival), cut as the game cuts them, judged on the 4 parts + C12.
    let actionResults: StoredScene['results'];
    if (scene.context.kind === 'gm_narration') {
      const arrivals = new Set(scene.context.beats.filter((b) => b.kind === 'arrival').map((b) => b.actionId));
      const raw = (result.value as GmNarration).segments.filter((s) => !arrivals.has(s.actionId)).map((s) => s.text);
      const read = raw.map(clampLine);
      const judged = await ai.call({
        gameId: STYLE_EVAL_GAME_ID,
        // Q-611 B: the main model (style_review), the summary model judged unstably (38% then 25% on near-identical prompts).
        purpose: 'style_review',
        system: [RESULT_JUDGE_BLOCK],
        messages: [{ role: 'user', text: JSON.stringify({ scene: scene.context, results: read }) }],
        output: { name: 'narration_judge', schema: ResultJudgeAnswer },
        // The model thinks first: 300 ran out (max_tokens) on the real AI.
        maxOutputTokens: 1_500,
      });
      const verdicts = judged.ok && judged.value.verdicts.length === read.length ? judged.value.verdicts : null;
      actionResults = read.map((t, i) => ({ text: t, chars: [...t].length, raw: [...raw[i]!].length, verdict: verdicts?.[i] ?? null }));
      if (actionResults.some((r) => r.chars > NPC_REPLY_MAX_LENGTH)) flags.push('result_too_long');
      if (!verdicts) flags.push('result_judge_failed');
      for (const part of PARTS) if (verdicts?.some((v) => !v[part])) flags.push(`result_missing_${part}`);
      if (verdicts?.some((v) => !v.playerChoice)) flags.push('decides_for_player');
    }
    spent += sceneCost;
    results.push({ ...base, ok: true, text, failure: null, flags: [...new Set(flags)], costUsdMicros: sceneCost, ...(replies ? { replies } : {}), ...(actionResults ? { results: actionResults } : {}) });
  }
  const row = db
    .insert(styleEvalRun)
    .values({ createdAt: now(), provider: provider.id, models: JSON.stringify([...models]), voiceVersion: assets.voice.version, costUsdMicros: spent, scenes: JSON.stringify(results) })
    .returning()
    .get();
  return runOf(row);
}

/** ISK-025: what the judge said of one NPC reply / line (null = not judged). */
export interface NpcReplyVerdict {
  persona: boolean;
  feeling: boolean;
  reaction: boolean;
  place: boolean;
}

/** ISK-025 C8: the NPC replies of a round against the bar (every reply ≤ 120, all 4 parts in ≥ 80%). */
export interface NpcReplyReport {
  replies: number;
  withinLength: number;
  /** Replies the judge found all 4 parts in. */
  complete: number;
  completeRate: number;
  pass: boolean;
  /** Up to 5 replies to show in the task result. */
  samples: string[];
}

export function npcReplyReport(db: DbOrTx, runId: number): NpcReplyReport {
  const row = db.select({ scenes: styleEvalRun.scenes }).from(styleEvalRun).where(eq(styleEvalRun.id, runId)).get();
  const scenes = row ? (JSON.parse(row.scenes) as StoredScene[]) : [];
  const replies = scenes.flatMap((s) => s.replies ?? []);
  const withinLength = replies.filter((r) => r.chars <= NPC_REPLY_MAX_LENGTH).length;
  const complete = replies.filter((r) => r.verdict !== null && PARTS.every((p) => r.verdict![p])).length;
  const completeRate = replies.length === 0 ? 0 : complete / replies.length;
  return {
    replies: replies.length,
    withinLength,
    complete,
    completeRate,
    pass: replies.length > 0 && withinLength === replies.length && completeRate >= 0.8,
    samples: scenes.flatMap((s) => s.replies?.slice(0, 1).map((r) => r.text) ?? []).slice(0, 5),
  };
}

/** ISK-026 C7 / C12: the action results of a round's narration scenes against the bar. */
export interface NarrationReport {
  results: number;
  withinLength: number;
  complete: number;
  completeRate: number;
  /** Results the judge found do not decide or feel for the player beyond the action (C12). */
  respectsPlayer: number;
  /** Results the AI wrote over 120 (the player reads them cut). */
  overRaw: number;
  pass: boolean;
  samples: string[];
}

export function narrationReport(db: DbOrTx, runId: number): NarrationReport {
  const row = db.select({ scenes: styleEvalRun.scenes }).from(styleEvalRun).where(eq(styleEvalRun.id, runId)).get();
  const scenes = row ? (JSON.parse(row.scenes) as StoredScene[]) : [];
  const all = scenes.flatMap((s) => s.results ?? []);
  const withinLength = all.filter((r) => r.chars <= NPC_REPLY_MAX_LENGTH).length;
  const complete = all.filter((r) => r.verdict !== null && PARTS.every((p) => r.verdict![p])).length;
  const completeRate = all.length === 0 ? 0 : complete / all.length;
  return {
    results: all.length,
    withinLength,
    complete,
    completeRate,
    respectsPlayer: all.filter((r) => r.verdict?.playerChoice === true).length,
    overRaw: all.filter((r) => r.raw > NPC_REPLY_MAX_LENGTH).length,
    pass: all.length > 0 && withinLength === all.length && completeRate >= 0.8,
    samples: scenes.flatMap((s) => s.results?.slice(0, 1).map((r) => r.text) ?? []).slice(0, 6),
  };
}

type RunRow = typeof styleEvalRun.$inferSelect;

/** The round as the admin page reads it: no prompts. */
function runOf(row: RunRow): StyleEvalRun {
  const scenes = (JSON.parse(row.scenes) as StoredScene[]).map(({ prompt: _prompt, replies: _replies, results: _results, ...s }) => s);
  return { id: row.id, createdAt: row.createdAt, provider: row.provider, models: JSON.parse(row.models) as string[], voiceVersion: row.voiceVersion, costUsdMicros: row.costUsdMicros, scenes };
}

function viewOf(db: DbOrTx, current: RunRow | undefined): StyleEvalResponse {
  if (!current) return { current: null, previous: null, marks: {}, summary: { better: 0, same: 0, worse: 0, unmarked: 0 } };
  const previous = db.select().from(styleEvalRun).where(lt(styleEvalRun.id, current.id)).orderBy(desc(styleEvalRun.id)).limit(1).get();
  const marks = JSON.parse(current.marks) as Record<string, StyleEvalMark>;
  const run = runOf(current);
  const count = (m: StyleEvalMark) => Object.values(marks).filter((v) => v === m).length;
  return {
    current: run,
    previous: previous ? runOf(previous) : null,
    marks,
    summary: { better: count('better'), same: count('same'), worse: count('worse'), unmarked: run.scenes.length - Object.keys(marks).length },
  };
}

/** The latest round against the one before it. */
export const styleEvalView = (db: Db): StyleEvalResponse => viewOf(db, db.select().from(styleEvalRun).orderBy(desc(styleEvalRun.id)).limit(1).get());

/** Nok's mark of one scene of a round against the round before (null clears it). */
export function markStyleEval(db: Db, runId: number, sceneId: string, mark: StyleEvalMark | null): StyleEvalResponse | 'not_found' | 'no_previous' {
  return db.transaction((tx) => {
    const row = tx.select().from(styleEvalRun).where(eq(styleEvalRun.id, runId)).get();
    if (!row || !(JSON.parse(row.scenes) as StoredScene[]).some((s) => s.sceneId === sceneId)) return 'not_found';
    if (!tx.select({ id: styleEvalRun.id }).from(styleEvalRun).where(lt(styleEvalRun.id, runId)).limit(1).get()) return 'no_previous';
    const { [sceneId]: _old, ...rest } = JSON.parse(row.marks) as Record<string, StyleEvalMark>;
    const marks = JSON.stringify(mark ? { ...rest, [sceneId]: mark } : rest);
    tx.update(styleEvalRun).set({ marks }).where(eq(styleEvalRun.id, runId)).run();
    return viewOf(tx, { ...row, marks });
  });
}
