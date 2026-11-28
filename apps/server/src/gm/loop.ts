import {
  ReplayRng,
  isDrowsy,
  karmaBand,
  orderPhaseActions,
  resolvePhaseActions,
  type ActionOutcome,
  type CrossPlayerState,
  type PhaseAction,
  type PhaseActionsLog,
  type PlayerResult,
  type Rng,
} from '@isekai/rules';
import type { z } from 'zod';
import type { AiService, AiServiceError } from '../ai/core/service.ts';
import type { AiPurpose, PromptBlock } from '../ai/provider.ts';
import { pinAssets } from '../assets/game-data.ts';
import type { GameAssets } from '../assets/load.ts';
import { tagVocabulary } from '../assets/tags.ts';
import type { VoiceForm } from '../assets/voice.ts';
import type { Clock } from '../auth/join.ts';
import { applyPhaseActions, crisesOf, crossPlayerState, seatedKarmaByMember, seatedKarmas } from '../crossplayer/phase.ts';
import { outdoorLocationIds, tagContexts, weatherTagging, type TaggingOptions } from '../crossplayer/tags.ts';
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { game, gamePhase, travelPending } from '../db/schema.ts';
import type { GmFallbackCause } from '@isekai/protocol';
import type { ClosedPhase, DialogueStage, PhaseResolution, PhaseResolver, ResolutionEntry, ResolutionHit, ResolverStuck } from '../room/resolver.ts';
import { spentOnTurn } from '../ai/core/usage.ts';
import { actionCausesOf } from '../room/turn-changes.ts';
import { itemsInGame, skillsInGame } from '../crossplayer/items.ts';
import { castCurseLabels } from '../statuses/curses.ts';
import { checkViewOf, hitOf, rollViewOf } from './roll-view.ts';
import { CryptoRng } from '../rng.ts';
import { buildEventContext } from '../timeline/context.ts';
import { setEventOutcome } from '../timeline/store.ts';
import { discoverHiddenEvidence, learnName, locationSnapshot, npcBondsOf } from '../visibility/store.ts';
import { recordTurnProgress } from '../skills/progress.ts';
import { applySkillChanges, checkSkillChanges, earnedSkillChanges, SUCCEEDED } from './skill-grants.ts';
import { setEndingPath } from '../finale/store.ts';
import { DRIFT_STRATEGY_ID, recordStrategyParticipation } from '../strategy/store.ts';
import { SCENARIO_DAYS } from '@isekai/protocol';
import { buildFinaleContext, checkFinale, finaleCheckInput, finaleEntries, templateFinale } from './finale.ts';
import { recordRefusal } from './refusal-log.ts';
import { checkNarration, checkTurnProposal, containsName, maskNames, type GmError } from './check.ts';
import {
  CONTEXT_BUDGET,
  FINALE_BLOCK,
  JOURNAL_BLOCK,
  DIALOGUE_BLOCK,
  NARRATOR_BLOCK,
  REPAIR_INSTRUCTION,
  RULES_BLOCK,
  STYLE_REWRITE_INSTRUCTION,
  SUMMARY_BLOCK,
  TOKEN_PATTERN,
  buildTurnContext,
  loadWorld,
  npcToken,
  requestTokens,
  stripStrayTokens,
  type Arrival,
  type Beat,
  type DayContext,
  type DialogueContext,
  type GmWorld,
  type NarrationContext,
  type TurnAction,
} from './context.ts';
import { journalContext, memoryJournal, storeTopics, topicsForPrompt, topicsOf } from './player-memory.ts';
import { createStageTimer, type StageTimer } from './timing.ts';
import { learningContext, turnTags } from '../learning/memory.ts';
import { introduceNpcs } from './npc-intro.ts';
import { dialoguePrompt } from './npc-examples.ts';
import { recordNpcMemories } from './npc-memory.ts';
import { capTotal, cleanNpcLines, lingerAfter, lingersNow, npcAnswers, npcLineLimits, npcPlacesNow, npcPrompt, npcsPresentAt, saveLingers, withVoice } from './npc-lines.ts';
import { npcFarewellFor } from './server-lines.ts';
import { newsSources, publicNews, saveNews, storedNews } from './news.ts';
import { arrivalAt, arrivalBeatId, periodScenes } from './scene.ts';
import { GM_OUTPUT, GmDaySummary, GmDialogue, GmFinale, GmJournal, GmNarration, GmTurnProposal } from './schema.ts';
import { gateStyle, styleIssues, type StyleScope } from './style-check.ts';
import { gameTone, styleBlock, toneBlock } from './tone.ts';
import {
  activeConstraints,
  addConstraint,
  dayLog,
  dialogueJobDone,
  dialogueJobsLeft,
  getStoredTurn,
  saveDialogueJobs,
  type DialogueJob,
  hasDaySummary,
  hasJournal,
  latestSaga,
  saveJournal,
  markApplied,
  releaseConstraint,
  saveAdjudicated,
  saveDaySummary,
  saveNarration,
  type StoredNarration,
  type TurnAt,
} from './store.ts';

/**
 * The AI GM turn loop (GEN-057, ADR "Isekai Chronicles - AI GM" loop B). For one closed turn:
 * 1. order the actions on the server (GEN-060 §10.5) and build the context (state, events, place, weather
 *    slot, tag vocabulary + each player's sources, constraints, memory), names as tokens (Q-045);
 * 2. one `gm_adjudicate`: a proposal per action (verb / target tags, GEN-064) + constraints + event outcomes;
 * 3. check it all-or-nothing (server + rules engine + tags + cross-player rules); errors → one `gm_repair`;
 *    still wrong → stuck: nothing changes and the room offers retry (Q-049, C2);
 * 4. roll every die once and store proposal + dice (`gm_turn`, C6);
 * 5. one narration per place (public, by place) and per player (private), each checked (beats, cast tokens,
 *    real names the reader does not know: C3, C8) with one repair; each stored as it passes;
 * 6. hand the room the rendered entries and an `apply` that replays the stored dice inside the publish
 *    transaction; then the day summary when a day ended (C5).
 * The budget ceiling (Q-078) and a provider that is not ready stop the loop before any call (C7).
 */
export interface AiGmDeps {
  db: Db;
  ai: Pick<AiService, 'call'>;
  assets: GameAssets;
  now: Clock;
  /** Metadata only: never prompt text, names or action text. */
  log: (line: string) => void;
  /** GEN-169: how long a style rewrite may take (AI_STYLE_REWRITE_MS); default 8 s. */
  styleRewriteMs?: number;
}

const STUCK_MESSAGE = 'AI GM ติดขัด สรุปผลเทิร์นนี้ไม่ได้ action ทุกอันยังอยู่ กด "ลองใหม่" ได้';
const BUDGET_PLAYER_MESSAGE = 'AI GM ติดขัด: AI ของเกมนี้ใช้ครบงบของเดือนแล้ว รอเจ้าของเกมจัดการ action ทุกอันยังอยู่';
const NOT_READY_PLAYER_MESSAGE = 'AI GM ติดขัด: ยังเรียก AI ไม่ได้ รอเจ้าของเกมจัดการ action ทุกอันยังอยู่';

/** GEN-128: the calls of a turn's result stage; what they cost is kept in reserve for the next one while the dialogue runs. */
const RESULT_STAGE: readonly AiPurpose[] = ['gm_adjudicate', 'gm_repair', 'narrate_place', 'narrate_player'];

/** Q-177: a narration call that fails is tried once more, then the template goes out. */
const NARRATION_RETRIES = 1;

/** Why a failed AI call ends in the template (Q-177). */
function fallbackCause(error: AiServiceError): GmFallbackCause {
  if (error.code === 'budget_reached') return 'budget';
  return error.detail?.startsWith('timeout') ? 'timeout' : 'error';
}

/** GEN-162: the code plus the provider's error kind (`max_tokens`, `timeout`...), never its detail text, for a server log. */
const failureOf = (error: AiServiceError) => (error.detail ? `${error.code} (${error.detail.split(':')[0]})` : error.code);

const RESULT_OF =(o: ActionOutcome): string => (o.status === 'resolved' ? o.log.degree : o.status);

class StuckError extends Error {
  readonly stuck: ResolverStuck;
  constructor(stuck: ResolverStuck) {
    super(stuck.code);
    this.stuck = stuck;
  }
}

/** Records the dice it hands out; with `prefix`, the first dice come from it (the order rolled before the AI call). */
class TurnRng implements Rng {
  readonly faces: number[] = [];
  readonly #prefix: readonly number[];
  readonly #inner: Rng;
  #next = 0;
  constructor(inner: Rng, prefix: readonly number[] = []) {
    this.#inner = inner;
    this.#prefix = prefix;
  }
  nextInt(min: number, max: number): number {
    const face = this.#next < this.#prefix.length ? this.#prefix[this.#next++]! : this.#inner.nextInt(min, max);
    this.faces.push(face);
    return face;
  }
}

export function createAiGmResolver(deps: AiGmDeps): PhaseResolver {
  const { db, ai, assets, now, log } = deps;
  /**
   * GEN-157: the summaries still being written per game (they run in the background after the turn is published).
   * The rule: the next adjudicate waits for `day` (its `memory.yesterday`), the next narrations for `journals`;
   * neither promise rejects. A failed summary is simply missing and retried after the next turn (as before).
   */
  const writing = new Map<string, { day: Promise<void>; journals: Promise<void> }>();
  /** GEN-128: the turns whose dialogue stage runs in this process (`dialogueLeft` never starts them twice). */
  const running = new Set<string>();
  const runningKey = (gameId: string, at: TurnAt) => `${gameId}:${at.day}:${at.phase}:${at.turn}`;

  function stuckFrom(error: AiServiceError): ResolverStuck {
    if (error.code === 'budget_reached') return { code: 'budget_reached', message: BUDGET_PLAYER_MESSAGE, ownerMessage: error.message };
    if (error.code === 'ai_not_ready') return { code: 'ai_not_ready', message: NOT_READY_PLAYER_MESSAGE, ownerMessage: error.message };
    return { code: 'stuck', message: STUCK_MESSAGE, ownerMessage: STUCK_MESSAGE };
  }
  const stuck = (why: string, gameId: string): never => {
    log(`[gm] game=${gameId} stuck: ${why}`);
    throw new StuckError({ code: 'stuck', message: STUCK_MESSAGE, ownerMessage: STUCK_MESSAGE });
  };

  /** One AI request with the context JSON; when `check` finds errors, one repair with the full list. */
  async function ask<T>(opts: {
    gameId: string;
    at: TurnAt;
    purpose: AiPurpose;
    repairPurpose: AiPurpose;
    system: PromptBlock[];
    context: unknown;
    output: { name: string; schema: z.ZodType<T> };
    maxOutputTokens: number;
    budget: number;
    check: (value: T) => GmError[];
    /** GEN-117 C6: fixes what the server can fix by itself (a leaked real name → the alias) before `check`, so it never costs a repair. */
    sanitize?: (value: T) => T;
    /**
     * Narration only: the server template, used when the answer is still wrong after the repair (Q-151) or
     * the call failed (Q-177: timeout after one retry, budget at once, any other failure). Without it → stuck.
     */
    fallback?: { label: string; make: () => T; onCallFailure?: boolean };
    signal?: AbortSignal;
    /** GEN-115: where the call time and tokens go (stage = the first call; the repair is always `repair`). */
    timer?: { timer: StageTimer; stage: string };
  }): Promise<{ value: T; fallback: GmFallbackCause | null }> {
    const first: { role: 'user' | 'assistant'; text: string }[] = [{ role: 'user', text: JSON.stringify(opts.context) }];
    if (requestTokens(opts.system, first) > opts.budget) stuck(`limit_exceeded ${opts.purpose}`, opts.gameId);
    const useFallback = (cause: GmFallbackCause) => {
      log(`[gm] game=${opts.gameId} purpose=${opts.purpose} audience=${opts.fallback!.label} fallback: server template cause=${cause}`);
      return { value: opts.fallback!.make(), fallback: cause };
    };
    let messages = first;
    for (const [i, purpose] of [opts.purpose, opts.repairPurpose].entries()) {
      const callStart = performance.now();
      const result = await ai.call({
        gameId: opts.gameId,
        purpose,
        day: opts.at.day,
        phase: opts.at.phase,
        turn: opts.at.turn,
        system: opts.system,
        messages,
        output: opts.output,
        maxOutputTokens: opts.maxOutputTokens,
        ...(opts.fallback ? { maxRetries: NARRATION_RETRIES } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      opts.timer?.timer.add(i === 0 ? opts.timer.stage : 'repair', performance.now() - callStart);
      if (result.ok) opts.timer?.timer.addTokens(result.usage);
      if (!result.ok) {
        log(`[gm] game=${opts.gameId} purpose=${purpose} failed: ${failureOf(result.error)}`);
        // A shutdown is not a failure of the AI: the turn resumes after the restart (C6).
        // GEN-059 C7: the ending (onCallFailure: false) stays untold and retryable when the call fails; nothing waits on it.
        if (!opts.fallback || opts.fallback.onCallFailure === false || opts.signal?.aborted) throw new StuckError(stuckFrom(result.error));
        // Q-221: a budget fallback is shown to the owner / Human GM as the room's gmStatus (ai.budgetNotice).
        return useFallback(fallbackCause(result.error));
      }
      const value = opts.sanitize ? opts.sanitize(result.value) : result.value;
      const errors = opts.check(value);
      if (errors.length === 0) return { value, fallback: null };
      try {
        recordRefusal(db, { gameId: opts.gameId, purpose, stage: i === 0 ? 'first' : 'repair', value, errors, at: now() });
      } catch (e) {
        // GEN-199: the record is for the server owner only; a failure never stops the turn.
        log(`[gm] game=${opts.gameId} refusal not recorded: ${(e as Error).message}`);
      }
      // GEN-163: an unknown_ref message starts with the ref (an opaque id or token, never prompt text).
      const unknown = errors.filter((e) => e.code === 'unknown_ref').map((e) => `${e.message.split(' ')[0]} at ${e.path}`);
      log(
        `[gm] game=${opts.gameId} purpose=${purpose} stage=${i === 0 ? 'first' : 'repair'} refused: ${[...new Set(errors.map((e) => e.code))].join(', ')}` +
          (unknown.length > 0 ? ` unknown_ref=[${unknown.join('; ')}]` : ''),
      );
      messages = [
        ...first,
        { role: 'assistant' as const, text: JSON.stringify(value) },
        { role: 'user' as const, text: JSON.stringify({ errors, instruction: REPAIR_INSTRUCTION }) },
      ];
    }
    if (opts.fallback) return useFallback('invalid');
    return stuck(`still invalid after repair (${opts.purpose})`, opts.gameId);
  }

  /**
   * GEN-169: the style check of an answer the server already accepted (`value`, built from the AI's `answer`); a
   * block hit with the rewrite setting on asks once more with the issues, and `accept` turns that answer into what
   * goes out (undefined = refused, the original goes out). The message is never dropped.
   */
  function styled<R, T>(opts: {
    gameId: string;
    at: TurnAt;
    purpose: AiPurpose;
    system: PromptBlock[];
    context: unknown;
    output: { name: string; schema: z.ZodType<R> };
    maxOutputTokens: number;
    answer: R;
    value: T;
    scope: StyleScope;
    texts: (value: T) => { text: string; npcId: string | null; form?: VoiceForm | null | undefined }[];
    accept: (answer: R) => T | undefined;
    label: string;
    signal?: AbortSignal;
    reserveUsdMicros?: number;
  }): Promise<T> {
    return gateStyle({
      db,
      value: opts.value,
      timeoutMs: deps.styleRewriteMs ?? 8_000,
      label: `game=${opts.gameId} purpose=${opts.purpose} audience=${opts.label}`,
      log,
      ...(opts.signal ? { signal: opts.signal } : {}),
      issuesOf: (v) => opts.texts(v).flatMap((t) => styleIssues(assets.voice, t.text, opts.scope, t.npcId, t.form)),
      rewrite: async (issues, signal) => {
        const result = await ai.call({
          gameId: opts.gameId,
          purpose: opts.purpose,
          day: opts.at.day,
          phase: opts.at.phase,
          turn: opts.at.turn,
          system: opts.system,
          messages: [
            { role: 'user', text: JSON.stringify(opts.context) },
            { role: 'assistant', text: JSON.stringify(opts.answer) },
            { role: 'user', text: JSON.stringify({ styleIssues: issues.map((i) => ({ rule: i.reason, fix: i.fix })), instruction: STYLE_REWRITE_INSTRUCTION }) },
          ],
          output: opts.output,
          maxOutputTokens: opts.maxOutputTokens,
          maxRetries: 0,
          signal,
          ...(opts.reserveUsdMicros !== undefined ? { reserveUsdMicros: opts.reserveUsdMicros } : {}),
        });
        return result.ok ? opts.accept(result.value) : undefined;
      },
    }).then((r) => r.value);
  }

  async function resolveTurn(input: ClosedPhase): Promise<PhaseResolution> {
    const { gameId, at, signal } = input;
    const timer = createStageTimer();
    const memoryWait = writing.get(gameId)?.day;
    if (memoryWait) await timer.time('memory_wait', () => memoryWait);
    const buildStart = performance.now();
    const world = loadWorld(db, gameId, assets);
    const drowsy = new Set(input.state.order.filter((id) => input.state.players[id] && isDrowsy(input.state.players[id]!, input.state.day)));
    const crises = crisesOf(input.state);
    // GEN-110 / GEN-137: the NPCs the schedule puts at a place now; GEN-144: who the last turn left talking stays at that
    // place a little longer, who has to go says goodbye. GEN-175: the rules and the turn context place NPCs by the same rule.
    const presence = (karmas: number[]) => ({ phase: at.phase, weather: input.weather?.weather ?? null, karmas });
    const everyone = presence(seatedKarmas(db, gameId));
    const { last: lastTurn, lingering, farewells } = lingersNow(db, world, assets, everyone);
    const npcPlaces = npcPlacesNow(world, assets, { ...everyone, lingering });
    // GEN-184: each actor's presence check by their own karma, like the chips they see (`npcsHereNow`).
    const npcPlacesOf = new Map([...seatedKarmaByMember(db, gameId)].map(([memberId, karma]) => [memberId, npcPlacesNow(world, assets, { ...presence([karma]), lingering })]));
    const state = crossPlayerState(db, gameId, drowsy, assets, crises, npcPlaces, npcPlacesOf);
    const tagging: TaggingOptions = weatherTagging(assets, at.day, at.phase, input.weather ?? null);
    const tags = tagContexts(db, gameId, state, tagging);
    // GEN-068: the same weather input as the turn's apply (`applyPhaseActions`), so the results the engine gets
    // (and writes back to the character) carry the weather's Stamina / d20 too.
    const weatherInput = tagging.periodWeather
      ? { weather: { current: tagging.periodWeather, outdoorLocationIds: outdoorLocationIds(db, gameId, assets) } }
      : {};

    const seat = new Map(input.state.order.map((id, i) => [id, i]));
    const acting = input.actions.filter((a) => !a.rest && state.players[a.memberId] !== undefined);
    if (acting.length === 0) return {};
    const actionIdOf = (memberId: string) => `act-${(seat.get(memberId) ?? 0) + 1}`;

    // 1-4: the proposal and the dice, or the ones stored before a restart (C6).
    let stored = getStoredTurn(db, gameId, at);
    let order: TurnAction[];
    let actions: PhaseAction[];
    let resolved: { state: CrossPlayerState; log: PhaseActionsLog };
    const constraints = activeConstraints(db, gameId);
    const events = buildEventContext(db, gameId, at.day, at.phase, assets);
    const strategies = {
      known: new Set((assets.day10Strategies ?? []).map((s) => s.id).filter((id) => id !== DRIFT_STRATEGY_ID)),
      active: new Set(events.active.flatMap((e) => e.strategies.map((s) => s.id)).filter((id) => id !== DRIFT_STRATEGY_ID)),
    };
    const checkInput = (o: TurnAction[]) => ({
      strategies,
      world,
      state,
      tags,
      order: o,
      activeEventIds: new Set(events.active.map((e) => e.id)),
      activeConstraintIds: new Set(constraints.map((c) => c.id)),
      finaleActive: events.active.some((e) => e.kind === 'finale'),
    });

    const memberOfRef = (ref: string) => world.byRef.get(ref)?.memberId;
    const skillTime = () => ({ day: at.day, period: at.phase, now: now() });

    const toTurnAction = (memberId: string): TurnAction => {
      const a = acting.find((x) => x.memberId === memberId)!;
      return { actionId: actionIdOf(memberId), memberId, text: a.text, visibility: a.visibility };
    };

    if (stored === null) {
      // The server orders first (GEN-060 §10.5); the same dice open the resolve below, so the order holds.
      const orderRng = new TurnRng(new CryptoRng());
      order = orderPhaseActions(acting.map((a) => state.players[a.memberId]!), orderRng).order.map(toTurnAction);
      const context = buildTurnContext(db, {
        world,
        state,
        tags,
        // Per turn: an admin edit of the game data (GEN-147) reaches the next turn.
        vocabulary: tagVocabulary(assets),
        drowsy,
        at,
        actions: order,
        resting: input.actions.filter((a) => a.rest).map((a) => a.memberId),
        weather: input.weather ?? null,
        assets,
      });
      // GEN-083: the learning blocks fit what the 20k cap leaves (2 = the joins of the two blocks).
      const room = CONTEXT_BUDGET.gm_adjudicate - requestTokens([RULES_BLOCK], [{ text: JSON.stringify(context) }]) - 2;
      const learning = learningContext(db, gameId, { tags: turnTags(db, gameId, order.map((a) => a.memberId)), room });
      if (learning.trimmed > 0) log(`[gm] game=${gameId} learning_trimmed step=${learning.trimmed}`);
      timer.add('build', performance.now() - buildStart);
      let checked: PhaseAction[] = [];
      const { value: proposal } = await ask({
        gameId,
        at,
        purpose: 'gm_adjudicate',
        repairPurpose: 'gm_repair',
        system: [RULES_BLOCK, ...learning.blocks],
        context,
        output: { name: GM_OUTPUT.turn, schema: GmTurnProposal },
        maxOutputTokens: 8_000,
        budget: CONTEXT_BUDGET.gm_adjudicate,
        check: (p) =>
          timer.time('rules', () => {
            const r = checkTurnProposal(checkInput(order), p);
            if (!r.ok) return r.errors;
            // Q-180: flags and grants go through the sheet / unlock rules too (dry run, nothing kept).
            const refused = checkSkillChanges(db, assets, memberOfRef, p, skillTime());
            if (refused.length === 0) checked = r.actions;
            return refused;
          }),
        timer: { timer, stage: 'adjudicate' },
        ...(signal ? { signal } : {}),
      });
      actions = checked;
      const rng = new TurnRng(new CryptoRng(), orderRng.faces);
      const result = timer.time('rules', () => resolvePhaseActions({ state, actions, tags, ...weatherInput }, rng));
      if (!result.ok) return stuck(`rules refused a checked proposal`, gameId);
      resolved = result;
      timer.time('db', () => saveAdjudicated(db, gameId, at, proposal, result.log.rolls, now()));
      stored = { status: 'adjudicated', proposal, rolls: [...result.log.rolls], narrations: {} };
    } else {
      // Restart: the stored proposal is in the server's order already; the stored dice replay everything.
      const memberOfAction = new Map(acting.map((a) => [actionIdOf(a.memberId), a.memberId]));
      order = stored.proposal.actions.flatMap((a) => (memberOfAction.has(a.actionId) ? [toTurnAction(memberOfAction.get(a.actionId)!)] : []));
      const r = checkTurnProposal(checkInput(order), stored.proposal);
      if (!r.ok) return stuck('stored proposal no longer fits the game', gameId);
      actions = r.actions;
      const result = resolvePhaseActions({ state, actions, tags, ...weatherInput }, new ReplayRng(stored.rolls));
      if (!result.ok) return stuck('stored dice no longer replay', gameId);
      resolved = result;
    }

    // GEN-190: the day's last turn: all the day summary reads of it (the proposal) is stored and final, so the summary
    // runs next to the narrations instead of after the publish, and the next day's adjudicate hardly waits for it.
    // shortcut: a game that ends (game_over) on a day's last turn gets that day's summary too (one unused call); upgrade if that costs.
    const summaryStarted = at.phase === 'NOCTHERION' && at.turn === 2 && at.day < SCENARIO_DAYS && !hasDaySummary(db, gameId, at.day);
    // GEN-190b (Q-384 = B): what turn 1's narrations cost stays under the ceiling for this turn's (GEN-128 sizing).
    // shortcut: a turn 1 with no AI narration reserves nothing; upgrade if the summary still eats a narration's money.
    if (summaryStarted) {
      const reserveUsdMicros = spentOnTurn(db, gameId, { ...at, turn: 1 }, ['narrate_place', 'narrate_player']);
      void summarizeFinishedDays(gameId, signal, { day: at.day, journals: false, reserveUsdMicros });
    }

    // 5: narration per place and per player.
    const proposal = stored.proposal;
    const textOf = new Map(order.map((a) => [a.actionId, world.tokenise(a.text)]));
    const placeName = new Map(world.places.map((p) => [p.id, p.name]));
    const start = locationSnapshot(db, gameId);
    const investigators = new Set(proposal.actions.filter((a) => a.investigate).map((a) => a.actionId));
    // Q-135: found Hidden Evidence is narrated from its id + place + day only (never who left it).
    const discoveredBy = (o: ActionOutcome) => (o.status === 'resolved' && investigators.has(o.actionId) ? discoverHiddenEvidence(db, gameId, o.actorId, at.day, o.log.degree) : []);
    const evidenceFor = (o: ActionOutcome): Beat[] =>
      discoveredBy(o).map((f) => ({
        actionId: `evidence:${f.id}`,
        kind: 'evidence' as const,
        actor: world.players.get(o.actorId)!.ref,
        text: `พบร่องรอยลับ (หลักฐาน ${f.id}) ที่${placeName.get(f.locationId) ?? f.locationId} ซึ่งมีคนทิ้งไว้ในวันที่ ${f.day}`,
        result: 'scene',
        target: null,
        targetNpc: null,
        moved: null,
        items: [],
      }));
    const karmaOf = (memberId: string) => state.players[memberId]?.karma ?? 0;
    // GEN-143: who a place was talking to last turn answers an action there that names nobody.
    const partnerAt = (placeId: string) => lastTurn.find((l) => l.talked && l.placeId === placeId)?.npcId ?? null;
    const lingeringIds = new Set(lingering.map((l) => l.npcId));
    const hereAt = (placeId: string, members: string[]) => npcsPresentAt(world, assets, placeId, { ...presence(members.map(karmaOf)), lingering });
    const npcsFor = (placeId: string, members: string[]) => {
      const hereIds = new Set(hereAt(placeId, members).map((n) => n.id));
      // `here` (GEN-137 + GEN-144): an NPC whose NPC_Schedule row matches this place now, else (no row anywhere now) at its
      // scenario place, plus the NPCs lingering here after a talk; only these speak. Tokens may also name the other NPCs of
      // the scenario place (scheduled elsewhere now).
      return npcPrompt(db, assets, world, world.npcs.filter((n) => hereIds.has(n.id) || n.locationId === placeId), hereIds, members, lingeringIds);
    };
    // The NPCs acted on this turn where they were: they linger next turn if the schedule moves them.
    const talkedTo = proposal.actions.flatMap((a) => {
      const member = world.byRef.get(a.actor)?.memberId;
      const placeId = member === undefined ? undefined : start.get(member);
      if (a.targetNpc === null || member === undefined || placeId === undefined) return [];
      return hereAt(placeId, [member]).some((n) => n.id === a.targetNpc) ? [{ npcId: a.targetNpc, placeId }] : [];
    });
    // shortcut: a turn where everyone rests returns before this and leaves the state as it was (counts one turn late); upgrade if that shows in play.
    const nextLingers = lingerAfter(lingering, talkedTo);
    // One goodbye per reader at the place, in the name that reader may see (GEN-121).
    const farewellEntries = farewells.flatMap((f): ResolutionEntry[] => {
      const npc = world.npcs.find((n) => n.id === f.npcId);
      if (!npc) return [];
      const byText = new Map<string, string[]>();
      for (const [memberId, loc] of start) {
        if (loc !== f.placeId || !world.players.has(memberId)) continue;
        const text = npcFarewellFor(db, assets, memberId, npc);
        byText.set(text, [...(byText.get(text) ?? []), memberId]);
      }
      return [...byText].map(([text, only]) => ({ kind: 'feed', locationId: f.placeId, actorMemberId: null, text, only }));
    });
    const secretBy = new Set(order.filter((a) => a.visibility === 'secret').map((a) => a.memberId));
    const targetNpcs = new Map(proposal.actions.map((a) => [a.actionId, a.targetNpc]));
    const lookedAt = new Map<string, Set<string>>();
    for (const a of proposal.actions) {
      const member = world.byRef.get(a.actor)?.memberId;
      if (member) lookedAt.set(member, new Set([...(a.targetPlayer ? [a.targetPlayer.player] : []), ...(a.looksAt ?? [])]));
    }
    // GEN-190: the period's scene (written next to this turn) renders who knows whom as it was before this turn.
    if (input.scene) await timer.time('scene_wait', () => input.scene);
    // GEN-117 (Q-292): who learned whose real name this turn, before any text is rendered. Idempotent, so a replay after a restart is safe.
    introduce(db, world, order, start, lookedAt, now());
    introduceNpcs(db, assets, world, order, proposal.actions, start, hereAt, now());
    // ISK-009: where each player is when the turn ends, whatever moved them (the AI's moveTo, a trip or a rift visit that ends at
    // the close), against where they were when it opened (`movedFrom`: a same-zone move during the turn).
    const trips = new Map(db.select().from(travelPending).where(eq(travelPending.gameId, gameId)).all().map((p) => [p.memberId, p.locationId]));
    const endOf = (m: string) => trips.get(m) ?? resolved.state.players[m]?.locationId ?? start.get(m);
    const arrivalOf = (m: string) => {
      const to = endOf(m);
      if (to === undefined || to === (input.movedFrom?.get(m) ?? start.get(m)) || !world.places.some((p) => p.id === to)) return null;
      const others = [...world.players.values()].filter((p) => p.memberId !== m && endOf(p.memberId) === to).map((p) => p.ref);
      return arrivalAt(world, assets, to, { ...presence([karmaOf(m)]), lingering }, others);
    };
    const audiences = narrationAudiences(world, resolved.log, textOf, start, events.active, evidenceFor, npcsFor, (m) => karmaBand(karmaOf(m)), (id) => targetNpcs.get(id) ?? null, (m) => lookedAt.get(m) ?? new Set(), arrivalOf);
    const journalWait = writing.get(gameId)?.journals;
    if (journalWait) await timer.time('journal_wait', () => journalWait);
    // GEN-115: the narrations do not depend on each other, so they run together: the wait is the slowest one, not the sum.
    // GEN-177: the game's tone right after the fixed rules, in the stable (cached) start of every narration / dialogue call.
    const tone = toneBlock(assets.voice, gameTone(db, gameId));
    // GEN-195: the Voice's forbidden phrases + bad → good pairs, cached right after the tone.
    const narratorSystem = [NARRATOR_BLOCK, tone, styleBlock(assets.voice, 'narration')];
    const dialogueSystem = [DIALOGUE_BLOCK, tone, styleBlock(assets.voice, 'dialogue')];
    const narrations = await timer.time('narrate', () => Promise.all(audiences.map(async (audience): Promise<{ key: string; ctx: NarrationContext; out: StoredNarration; forbidden: string[]; readers: string[] }> => {
      const ctx: NarrationContext = {
        kind: 'gm_narration',
        ...audience.ctx,
        turn: at,
        place: { id: audience.placeId, name: placeName.get(audience.placeId) ?? audience.placeId },
        answers: npcAnswers(audience.ctx.beats, new Set(audience.ctx.npcs.filter((n) => n.here).map((n) => n.id)), partnerAt(audience.placeId)),
        privateLines: 'player' in audience.ctx.audience && secretBy.has(audience.readers[0]!),
        journal: 'player' in audience.ctx.audience ? memoryJournal(db, audience.readers[0]!, at.day, assets.playerMemory.promptTokens) : null,
      };
      const saved = stored.narrations[audience.key];
      const forbidden = forbiddenNamesFor(world, audience.readers);
      const aliases = aliasesOf(world, forbidden);
      const purpose = 'player' in ctx.audience ? 'narrate_player' : 'narrate_place';
      const output = { name: GM_OUTPUT.narration, schema: GmNarration };
      const sanitize = (n: GmNarration): GmNarration => ({ ...n, segments: n.segments.map((s) => ({ ...s, text: maskNames(s.text, aliases) })) });
      const check = (n: GmNarration) => checkNarration(ctx, n, forbidden);
      const out: StoredNarration =
        saved ??
        (await ask({
          gameId,
          at,
          purpose,
          repairPurpose: purpose,
          system: narratorSystem,
          context: ctx,
          output,
          maxOutputTokens: 1_500,
          budget: 'player' in ctx.audience ? CONTEXT_BUDGET.narrate_player : CONTEXT_BUDGET.narrate_place,
          sanitize,
          check,
          fallback: { label: audience.key, make: () => templateNarration(ctx) },
          timer: { timer, stage: 'narrate_calls' },
          ...(signal ? { signal } : {}),
        }).then(({ value, fallback }) =>
          fallback === null
            ? styled({
                gameId,
                at,
                purpose,
                system: narratorSystem,
                context: ctx,
                output,
                maxOutputTokens: 1_500,
                answer: value,
                value,
                scope: 'narration',
                texts: (n) => n.segments.map((s) => ({ text: s.text, npcId: null })),
                accept: (n) => {
                  const clean = sanitize(n);
                  return check(clean).length === 0 ? clean : undefined;
                },
                label: audience.key,
                ...(signal ? { signal } : {}),
              })
            : { ...value, fallback },
        ));
      if (!saved) timer.time('db', () => saveNarration(db, gameId, at, audience.key, out, now()));
      return { key: audience.key, ctx, out, forbidden, readers: audience.readers };
    })));

    // Q-229: each player's own roll (F5) and the hit card of whoever another player cost something.
    const items = itemsInGame(db, gameId);
    const skillNames = new Map([...skillsInGame(db, gameId).values()].flat().map((s) => [s.id, s.name]));
    const nameOf = (ref: string) => items.get(ref)?.name ?? skillNames.get(ref);
    const rollOf = new Map(
      resolved.log.outcomes.flatMap((o) => {
        const view = o.status === 'resolved' ? rollViewOf(o.log, nameOf) : null;
        return view ? [[o.actorId, view] as const] : [];
      }),
    );
    // Screens and Flows v2 §5: the Human GM sees every number of each roll of the held turn.
    const closed = new Map(input.actions.map((a) => [a.memberId, a]));
    const checks = resolved.log.outcomes.flatMap((o) => checkViewOf(o, closed.get(o.actorId), nameOf) ?? []);
    const hits: ResolutionHit[] = resolved.log.outcomes.flatMap((o) => {
      const actor = world.players.get(o.actorId);
      const target = o.status === 'resolved' ? o.target : null;
      if (!actor || !target) return [];
      const looks = world.knownNames(target.playerId).has(o.actorId) ? actor.name : actor.appearance;
      const found = hitOf(o, looks, (id) => nameOf(id) ?? 'ไอเทม', castCurseLabels(db, gameId, assets, o));
      if (!found) return [];
      return [{ ...found, text: found.hit.actor === null ? 'มีใครบางคนลงมือกับคุณโดยที่คุณไม่ทันเห็นตัว' : `${found.hit.actor} ลงมือกับคุณ` }];
    });

    // 6: what the room publishes and applies. GEN-116: the result and narration only; the NPC lines are the second stage below.
    const perAudience = narrations.map(({ ctx, out, readers }): ResolutionEntry[] => {
      const reader = 'player' in ctx.audience ? world.byRef.get(ctx.audience.player)!.memberId : null;
      const render = (who: string | null, shared: boolean) => out.segments.map((s) => renderTokens(db, world, s.text, who, shared)).join('\n');
      const fallback = out.fallback ? { fallback: out.fallback } : {};
      if (reader !== null) {
        const roll = rollOf.has(reader) ? { roll: rollOf.get(reader)! } : {};
        return [{ kind: 'narration', memberId: reader, text: render(reader, false), ...roll, ...fallback }];
      }
      // GEN-117 C5: the place feed reads the alias by default; a reader who knows someone in it (or has met an NPC) gets their own text.
      const text = render(null, true);
      const own = new Map<string, string[]>();
      for (const r of readers) {
        // ISK-008: their own token in the feed reads "คุณ" too.
        const t = render(r, false);
        if (t !== text) own.set(t, [...(own.get(t) ?? []), r]);
      }
      const feed = { kind: 'feed' as const, locationId: ctx.place.id, actorMemberId: null, ...fallback };
      return [
        { ...feed, text, except: [...own.values()].flat() },
        ...[...own].map(([t, only]): ResolutionEntry => ({ ...feed, text: t, only })),
      ];
    });
    // ISK-013 (Q-389 = A): each found Hidden Evidence is also its own private clue entry, last so `firstEntry` below holds.
    const clueEntries = resolved.log.outcomes.flatMap((o) =>
      discoveredBy(o).map((f): ResolutionEntry => ({ kind: 'narration', memberId: o.actorId, text: `พบร่องรอยลับที่${placeName.get(f.locationId) ?? f.locationId} ซึ่งมีคนทิ้งไว้ในวันที่ ${f.day}`, clue: true })),
    );
    const entries: ResolutionEntry[] = [...farewellEntries, ...perAudience.flat(), ...clueEntries];
    // GEN-128: where each audience's own text (its narration, or its place feed as most read it) sits in `entries`.
    const firstEntry = (i: number) => farewellEntries.length + perAudience.slice(0, i).reduce((n, e) => n + e.length, 0);

    // GEN-116: the second stage, run by the room after the entries above are out and not waited for. One call per
    // audience that has someone to speak. GEN-128: the calls are stored first, so a restart asks again what is not done.
    const level = db.select({ level: game.npcDialogue }).from(game).where(eq(game.id, gameId)).get()?.level ?? 'normal';
    const limits = npcLineLimits(level);
    const dialogue: DialogueStage = async (publish, published = entries, places) => {
      const jobs = narrations.flatMap(({ key, ctx, out, forbidden }, i): DialogueJob[] => {
        const reader = 'player' in ctx.audience ? world.byRef.get(ctx.audience.player)!.memberId : null;
        // Nobody here may speak, or a private narration of a public action (what is said in front of everyone is in the place feed once).
        if (!ctx.npcs.some((n) => n.here) || (reader !== null && !ctx.privateLines)) return [];
        const { journal: _journal, kind: _kind, ...rest } = ctx;
        // GEN-151: the rules + each NPC's persona and library first (cached), the turn after.
        const { system: libSystem, npcs } = dialoguePrompt(db, assets, world, withVoice(assets, rest.npcs));
        // GEN-177 + GEN-151: rules, then the game's tone, then the NPC library — all stable, so all cacheable.
        const system = [...dialogueSystem, ...libSystem.slice(1)];
        // GEN-128 C3: the lines follow the narration the players read, a Human GM's edit included (names back to tokens).
        const edited = published[firstEntry(i)]?.text;
        const narration = edited !== undefined && edited !== entries[firstEntry(i)]!.text ? [world.tokenise(edited)] : out.segments.map((s) => s.text);
        // ISK-098: lines to one reader alone carry that reader's memory, the topics naming an NPC here first.
        const here = rest.npcs.filter((n) => n.here).map((n) => npcToken(n.id));
        const memory = reader === null ? {} : { memory: topicsForPrompt(topicsOf(db, reader), assets.playerMemory.promptTokens / 2, here) };
        const context: DialogueContext = { ...rest, npcs, kind: 'gm_dialogue', narration, limits, ...memory };
        if (requestTokens(system, [{ text: JSON.stringify(context) }]) > CONTEXT_BUDGET.npc_dialogue) {
          log(`[gm] game=${gameId} purpose=npc_dialogue audience=${key} skipped: limit_exceeded`);
          return [];
        }
        const readers = reader === null ? places?.get(ctx.place.id) : undefined;
        return [{ key, system, context, forbidden, ...(readers ? { readers: [...readers] } : {}) }];
      });
      saveDialogueJobs(db, gameId, at, jobs, now());
      await runDialogue(gameId, at, jobs, publish, signal);
    };
    const rolls = stored.rolls;
    log(`[gm] game=${gameId} day=${at.day} phase=${at.phase} turn=${at.turn} timing ${timer.line()}`);
    return {
      results: resultsOf(state, resolved.state, resolved.log),
      entries,
      dialogue,
      hits,
      causes: actionCausesOf(resolved.log.outcomes, nameOf),
      checks,
      apply: (tx) => {
        const applied = applyPhaseActions(tx, gameId, actions, new ReplayRng(rolls), now(), tagging, drowsy, crises, npcPlaces, npcPlacesOf);
        if (!applied.ok) throw new Error('the stored turn no longer applies');
        // GEN-055: the unlock progress of every action (verb tags, karma) and the library's INVESTIGATE reveal.
        recordTurnProgress(tx, assets, gameId, applied.log, { day: at.day, period: at.phase, now: now() }, investigators);
        // Q-180: the flags and grants of the actions that succeeded.
        const results = new Map(applied.log.outcomes.map((o) => [o.actionId, RESULT_OF(o)]));
        const earned = earnedSkillChanges(proposal, (id) => results.get(id));
        const skipped = applySkillChanges(tx, assets, memberOfRef, earned, proposal, skillTime());
        if (skipped.length > 0) log(`[gm] game=${gameId} skill changes skipped at apply: ${[...new Set(skipped.map((e) => e.code))].join(', ')}`);
        for (const c of proposal.constraints.add) {
          addConstraint(tx, { gameId, memberId: world.byRef.get(c.player)!.memberId, text: c.text, reason: c.reason, day: at.day }, now());
        }
        for (const c of proposal.constraints.release) releaseConstraint(tx, gameId, c.id, c.reason, at.day);
        // Q-243: a proposal stored before `side` existed has none; the store then reads the old text prefix.
        for (const e of proposal.eventOutcomes) setEventOutcome(tx, gameId, e.eventId, e.outcome, e.side, now());
        // GEN-059: the ending path the players completed during the finale (a proposal stored before it has none).
        if (proposal.endingPath) setEndingPath(tx, gameId, proposal.endingPath, now());
        // GEN-093: each action's Day-10 plan and role, with whether it succeeded (a proposal stored before it has none).
        for (const a of proposal.actions) {
          const memberId = a.strategy ? memberOfRef(a.actor) : undefined;
          if (!a.strategy || memberId === undefined) continue;
          const success = SUCCEEDED.has(results.get(a.actionId) ?? '');
          recordStrategyParticipation(tx, gameId, { memberId, strategyId: a.strategy.id, role: a.strategy.role, success, day: at.day }, now());
        }
        saveLingers(tx, gameId, nextLingers);
        // GEN-146: one memory line per NPC the turn involved, from the applied result (no AI call).
        recordNpcMemories(tx, world, applied.log.outcomes, new Map(proposal.actions.map((a) => [a.actionId, a.intentSummary])), at, now());
        markApplied(tx, gameId, at, now());
      },
      // GEN-190: a summary started during the turn is not asked again (a failed one waits for the next turn, as before).
      after: (afterSignal) => summarizeFinishedDays(gameId, afterSignal, { day: summaryStarted ? null : 'finished', journals: true }),
    };
  }

  /**
   * GEN-116 / GEN-128: the dialogue calls of one published turn, all at once; each audience's lines go to `publish` as soon as
   * its call is done. A call is done (removed from the stored jobs) once its lines are stored, or when it gave up; never
   * when the server shuts down, so the first join after the restart asks again (`dialogueLeft`).
   */
  async function runDialogue(gameId: string, at: TurnAt, jobs: readonly DialogueJob[], publish: Parameters<DialogueStage>[0], signal?: AbortSignal): Promise<void> {
    const id = runningKey(gameId, at);
    running.add(id);
    try {
      const world = loadWorld(db, gameId, assets);
      const realNpcNames = world.npcs.flatMap((n) => n.names.filter((name) => name !== n.alias));
      const level = db.select({ level: game.npcDialogue }).from(game).where(eq(game.id, gameId)).get()?.level ?? 'normal';
      // GEN-128 C1: what this turn's result stage cost stays under the ceiling, for the next turn's result stage.
      const reserveUsdMicros = spentOnTurn(db, gameId, at, RESULT_STAGE);
      const dialogueTimer = createStageTimer();
      let lineBudget = npcLineLimits(level).total;
      const done = (key: string) => () => dialogueJobDone(db, gameId, at, key, now());
      await Promise.all(
        jobs.map(async ({ key, system, context, forbidden }) => {
          const reader = 'player' in context.audience ? (world.byRef.get(context.audience.player)?.memberId ?? null) : null;
          try {
            if ('player' in context.audience && reader === null) return done(key)();
            const callStart = performance.now();
            const result = await ai.call({
              gameId,
              purpose: 'npc_dialogue',
              day: at.day,
              phase: at.phase,
              turn: at.turn,
              system,
              messages: [{ role: 'user', text: JSON.stringify(context) }],
              output: { name: GM_OUTPUT.dialogue, schema: GmDialogue },
              maxOutputTokens: 1_000,
              maxRetries: NARRATION_RETRIES,
              reserveUsdMicros,
              ...(signal ? { signal } : {}),
            });
            dialogueTimer.add('dialogue_calls', performance.now() - callStart);
            if (!result.ok) {
              // C3: no lines, no repair, no more retries than the narration gets; the turn is complete without them.
              log(`[gm] game=${gameId} purpose=npc_dialogue audience=${key} gave up: ${failureOf(result.error)}`);
              if (!signal?.aborted) done(key)();
              return;
            }
            dialogueTimer.addTokens(result.usage);
            const clean = (npcLines: GmDialogue['npcLines']) =>
              capTotal(
                cleanNpcLines(npcLines, {
                  present: new Set(context.npcs.filter((n) => n.here).map((n) => n.id)),
                  audience: reader === null ? 'public' : 'private',
                  forbidden: [...forbidden, ...realNpcNames],
                  cast: new Set(context.cast.map((c) => c.ref)),
                  level,
                  askers: new Map(context.answers.map((a) => [a.npcId, a.actionIds.length])),
                }),
                level,
              );
            // GEN-169: each line against its NPC's speech profile; a rewrite that leaves nobody speaking is refused.
            const lines = (
              await styled({
                gameId,
                at,
                purpose: 'npc_dialogue',
                system,
                context,
                output: { name: GM_OUTPUT.dialogue, schema: GmDialogue },
                maxOutputTokens: 1_000,
                answer: result.value,
                value: clean(result.value.npcLines),
                scope: 'dialogue',
                // GEN-193: in the form its audience sees it in (a job stored before GEN-193 has none: any form).
                texts: (ls) => ls.map((l) => ({ text: l.text, npcId: l.npcId, form: context.npcs.find((n) => n.id === l.npcId)?.form })),
                accept: (d) => {
                  const again = clean(d.npcLines);
                  return again.length > 0 ? again : undefined;
                },
                label: key,
                reserveUsdMicros,
                ...(signal ? { signal } : {}),
              })
            ).slice(0, lineBudget);
            lineBudget -= lines.length;
            if (lines.length === 0) return done(key)();
            publish(
              lines.map((l): ResolutionEntry => ({
                kind: 'npc',
                npcId: l.npcId,
                npcKind: l.kind,
                locationId: reader === null ? context.place.id : null,
                memberId: reader,
                text: renderTokens(db, world, l.text, reader),
              })),
              done(key),
            );
          } catch (error) {
            log(`[gm] game=${gameId} purpose=npc_dialogue audience=${key} failed: ${error instanceof Error ? error.name : 'unknown error'}`);
            if (!signal?.aborted) done(key)();
          }
        }),
      );
      log(`[gm] game=${gameId} day=${at.day} phase=${at.phase} turn=${at.turn} dialogue timing ${dialogueTimer.line()}`);
    } finally {
      running.delete(id);
    }
  }

  /**
   * Day summaries (C5) and each player's journal (Q-153) for every finished day that has none; a failure is
   * retried after the next turn and never holds the game. GEN-157: the day chain and the journal chain run
   * together (neither reads the other), each journal of a day at once; a run started while one is still going
   * follows it, so a summary is never asked for twice. GEN-190: `parts.day` = a number: the days through that one (its
   * last turn is adjudicated), null: no day summaries this run (already started during the turn).
   */
  function summarizeFinishedDays(
    gameId: string,
    signal?: AbortSignal,
    parts: { day: number | 'finished' | null; journals: boolean; reserveUsdMicros?: number } = { day: 'finished', journals: true },
  ): Promise<void> {
    const before = writing.get(gameId);
    const endingDay = typeof parts.day === 'number' ? parts.day : undefined;
    // `one` → null: nothing was missing for that day; false: a call failed (later days wait for the next run).
    // ISK-098: journals go on past a failed day (no saga chains them any more): its talk waits in the next day's summary (C9).
    const chain = (after: Promise<void> | undefined, stage: string, one: (d: number) => Promise<boolean | null>, goOn = false) =>
      (async () => {
        await after;
        const current = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, gameId)).get()?.state;
        const day = endingDay !== undefined ? endingDay + 1 : current ? (JSON.parse(current) as { day: number }).day : 1;
        const start = performance.now();
        let asked = false;
        for (let d = 1; d < day; d++) {
          const done = await one(d);
          asked ||= done !== null;
          if (done === false && !goOn) break;
        }
        if (asked) log(`[gm] game=${gameId} ${stage} timing total_ms=${Math.round(performance.now() - start)}`);
      })().catch((error) => log(`[gm] game=${gameId} ${stage} failed: ${error instanceof Error ? error.name : 'unknown error'}`));
    const entry = {
      day: parts.day === null ? (before?.day ?? Promise.resolve()) : chain(before?.day, 'summarize_day', (d) => summarizeDay(gameId, d, signal, parts.reserveUsdMicros)),
      // A journal reads the published texts, so never during the turn.
      journals: parts.journals ? chain(before?.journals, 'summarize_journal', (d) => summarizeJournals(gameId, d, signal), true) : (before?.journals ?? Promise.resolve()),
    };
    writing.set(gameId, entry);
    return Promise.all([entry.day, entry.journals]).then(() => {
      if (writing.get(gameId) === entry) writing.delete(gameId);
    });
  }

  /** One `summarize_journal` per player of the game for day `d` (all at once), from what reached that player only; null when none was missing. */
  async function summarizeJournals(gameId: string, d: number, signal?: AbortSignal): Promise<boolean | null> {
    const world = loadWorld(db, gameId, assets);
    const missing = [...world.players.values()].filter((p) => !hasJournal(db, p.memberId, d));
    if (missing.length === 0) return null;
    const done = await Promise.all(missing.map((p) => summarizeJournal(gameId, world, p, d, signal)));
    return done.every(Boolean);
  }

  /**
   * One player's journal of day `d` and (ISK-098) their memory topics, in the same call; false when the journal
   * failed (asked again after the next turn, as before). Wrong topics or a failed call keep the topics and let the
   * day wait for the next summary.
   */
  async function summarizeJournal(gameId: string, world: GmWorld, p: { memberId: string; ref: string }, d: number, signal?: AbortSignal): Promise<boolean> {
    const { context, plan, names, topics } = journalContext(db, world, assets, p, d);
    const memory = { gameId, memberId: p.memberId, plan, topics, names, limits: assets.playerMemory };
    const system = [JOURNAL_BLOCK];
    const messages = [{ role: 'user' as const, text: JSON.stringify(context) }];
    if (requestTokens(system, messages) > CONTEXT_BUDGET.summarize_journal) {
      log(`[gm] game=${gameId} summarize_journal day=${d} player=${p.ref} limit_exceeded`);
      return true;
    }
    const result = await ai.call({
      gameId,
      purpose: 'summarize_journal',
      day: d,
      system,
      messages,
      output: { name: GM_OUTPUT.journal, schema: GmJournal },
      // GEN-161 (Q-327): 800 hit max_tokens on every real call; GEN-180 (Q-342): 1500 still did 2 of 8 times.
      // ISK-098: + the topics it may rewrite (about 1 token per Thai character).
      maxOutputTokens: 3_000 + assets.playerMemory.maxChars,
      ...(signal ? { signal } : {}),
    });
    if (!result.ok) {
      log(`[gm] game=${gameId} summarize_journal day=${d} player=${p.ref} failed: ${failureOf(result.error)}`);
      storeTopics(db, memory, null, now());
      return false;
    }
    if (result.value.topics === null) log(`[gm] game=${gameId} summarize_journal day=${d} player=${p.ref} topics invalid`);
    storeTopics(db, memory, result.value.topics, now());
    if (result.value.journal === '') {
      log(`[gm] game=${gameId} summarize_journal day=${d} player=${p.ref} journal invalid`);
      return false;
    }
    saveJournal(db, gameId, p.memberId, d, result.value.journal, now());
    return true;
  }

  /** The GM's summary of day `d` when it has none (null: nothing was missing); false when the call failed. */
  async function summarizeDay(gameId: string, d: number, signal?: AbortSignal, reserveUsdMicros?: number): Promise<boolean | null> {
    if (hasDaySummary(db, gameId, d)) return null;
    // ISK-014: the same call writes tomorrow's morning news.
    const context: DayContext = { kind: 'gm_day', day: d, saga: latestSaga(db, gameId, d), log: dayLog(db, gameId, d), news: newsSources(db, gameId, d + 1) };
    const system = [SUMMARY_BLOCK];
    const messages = [{ role: 'user' as const, text: JSON.stringify(context) }];
    if (requestTokens(system, messages) > CONTEXT_BUDGET.summarize_day) {
      log(`[gm] game=${gameId} summarize_day day=${d} limit_exceeded`);
      return true;
    }
    const result = await ai.call({
      gameId,
      purpose: 'summarize_day',
      day: d,
      system,
      messages,
      output: { name: GM_OUTPUT.daySummary, schema: GmDaySummary },
      // ISK-028: day 2 hit max_tokens 3 of 3 (in=1462 out=1500, Railway 2026-11-23); 3,000 like summarize_journal (Q-342), room for ISK-014's news.
      maxOutputTokens: 3_000,
      ...(reserveUsdMicros !== undefined ? { reserveUsdMicros } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!result.ok) {
      log(`[gm] game=${gameId} summarize_day day=${d} failed: ${failureOf(result.error)}`);
      return false;
    }
    // Before the summary, which marks the day done: a restart in between asks again rather than losing the news.
    const news = publicNews(db, assets, gameId, result.value.news);
    if (news) saveNews(db, gameId, d + 1, news, now());
    saveDaySummary(db, gameId, d, result.value, now());
    return true;
  }

  /** GEN-059: one `finale` call (one repair; still wrong → the server template, Q-151); an AI error → stuck. */
  async function tellFinale(gameId: string, signal?: AbortSignal): Promise<{ entries: ResolutionEntry[] }> {
    const context = buildFinaleContext(db, assets, gameId);
    if (!context) return stuck('finale without a stored ending', gameId);
    const { forbiddenNames, npcIds } = finaleCheckInput(db, assets, gameId);
    const out = await ask({
      gameId,
      at: { day: SCENARIO_DAYS, phase: 'NOCTHERION', turn: 2 },
      purpose: 'finale',
      repairPurpose: 'finale',
      // GEN-194: the game's tone in the cached start, as narration (GEN-177).
      system: [FINALE_BLOCK, toneBlock(assets.voice, gameTone(db, gameId))],
      context,
      output: { name: GM_OUTPUT.finale, schema: GmFinale },
      maxOutputTokens: 4_000,
      budget: CONTEXT_BUDGET.finale,
      check: (o) => checkFinale(context, o, forbiddenNames, npcIds),
      fallback: { label: 'finale', make: () => templateFinale(context), onCallFailure: false },
      ...(signal ? { signal } : {}),
    });
    // Q-177: a template ending carries the fallback marker like any other narration.
    const entries = finaleEntries(db, assets, gameId, out.value);
    return { entries: out.fallback ? entries.map((e) => ({ ...e, fallback: out.fallback! })) : entries };
  }

  return {
    async resolve(input) {
      // GEN-174: one game data snapshot for the whole turn, its apply and its background stages included.
      const pin = pinAssets(assets);
      try {
        const r = await pin(() => resolveTurn(input));
        return {
          ...r,
          ...(r.apply ? { apply: (tx: Parameters<typeof r.apply>[0]) => pin(() => r.apply!(tx)) } : {}),
          ...(r.dialogue ? { dialogue: ((publish, published, places) => pin(() => r.dialogue!(publish, published, places))) satisfies DialogueStage } : {}),
          ...(r.after ? { after: (signal?: AbortSignal) => pin(() => r.after!(signal)) } : {}),
        };
      } catch (error) {
        if (error instanceof StuckError) return { stuck: error.stuck };
        throw error;
      }
    },
    async finale({ gameId, signal }) {
      try {
        return await pinAssets(assets)(() => tellFinale(gameId, signal));
      } catch (error) {
        if (error instanceof StuckError) return { stuck: error.stuck };
        throw error;
      }
    },
    catchUp: ({ gameId, signal }) => pinAssets(assets)(() => summarizeFinishedDays(gameId, signal)),
    dialogueLeft: ({ gameId, signal }) =>
      dialogueJobsLeft(db, gameId)
        .filter(({ at }) => !running.has(runningKey(gameId, at)))
        .map(({ at, jobs }) => ({
          at,
          dialogue: (publish) => pinAssets(assets)(() => runDialogue(gameId, at, jobs, publish, signal)),
          places: new Map(jobs.flatMap((j) => (j.readers ? [[j.context.place.id, new Set(j.readers)] as const] : []))),
        })),
    scene: (input) => pinAssets(assets)(() => periodScenes({ db, ai, assets, log }, input)),
    // ISK-014: what the summary of the day before wrote for `day` (waits for a summary still running); null = none.
    news: async ({ gameId, day }) => {
      await writing.get(gameId)?.day;
      return storedNews(db, gameId, day);
    },
  };
}

// --- Audiences and beats (ADR §5.1): who learns what of the turn ---

interface Audience {
  key: string;
  placeId: string;
  /** Members who read the text (the player, or everyone at the place when the turn closed). */
  readers: string[];
  ctx: Pick<NarrationContext, 'audience' | 'cast' | 'npcs' | 'beats' | 'arrival'>;
}

function narrationAudiences(
  world: GmWorld,
  log: PhaseActionsLog,
  textOf: ReadonlyMap<string, string>,
  start: ReadonlyMap<string, string>,
  activeEvents: readonly { id: string; title: string; places: readonly string[] | null }[],
  evidenceFor: (o: ActionOutcome) => Beat[],
  /** GEN-110: who is at a place now (the schedule), what they are like, and how each player stands with them. */
  npcsFor: (placeId: string, members: string[]) => NarrationContext['npcs'],
  karmaBandOf: (memberId: string) => number,
  targetNpcOf: (actionId: string) => string | null,
  /** GEN-117: the player refs this member's action really looked at (target or `looksAt`); only they get looks in that member's narration. */
  lookedAt: (memberId: string) => ReadonlySet<string>,
  /** ISK-009: what a player who arrived somewhere this turn sees there; null = did not arrive. */
  arrivalOf: (memberId: string) => Arrival | null,
): Audience[] {
  const ref = (memberId: string) => world.players.get(memberId)!.ref;
  const placeBeats = new Map<string, Beat[]>();
  const playerBeats = new Map<string, Beat[]>();
  const push = (map: Map<string, Beat[]>, key: string, beat: Beat) => map.set(key, [...(map.get(key) ?? []), beat]);

  for (const o of log.outcomes) {
    const text = textOf.get(o.actionId) ?? '';
    const resolved = o.status === 'resolved' ? o : null;
    const target = resolved?.target ?? null;
    const base: Beat = {
      actionId: o.actionId,
      kind: 'own_action',
      actor: ref(o.actorId),
      text,
      result: RESULT_OF(o),
      target: target ? ref(target.playerId) : o.status === 'no_target' ? ref(o.targetId) : null,
      targetNpc: targetNpcOf(o.actionId),
      moved: resolved?.moved ?? null,
      items: [],
    };
    push(playerBeats, o.actorId, base);
    for (const beat of evidenceFor(o)) push(playerBeats, o.actorId, beat);
    if (target && target.playerId !== o.actorId) {
      const changed = target.hp.damage > 0 || target.hp.heal > 0 || target.itemsLost.length > 0 || target.itemsGained.length > 0;
      if (changed || target.knowsActor) {
        push(playerBeats, target.playerId, {
          ...base,
          kind: 'affected',
          actor: target.knowsActor ? base.actor : null,
          text: target.knowsActor ? text : 'มีใครบางคนทำบางอย่างกับคุณโดยที่คุณไม่ทันเห็นตัว',
        });
      }
    }
    if (o.status !== 'skipped' && o.visibility === 'public') push(placeBeats, o.locationId, { ...base, kind: 'public_action' });
  }
  // GEN-097: an event at several places is a beat of each of their feeds; a town-wide one of none.
  for (const e of activeEvents) {
    for (const place of e.places ?? []) {
      const placeId = world.places.find((p) => p.name === place)?.id;
      if (placeId) push(placeBeats, placeId, { actionId: `event:${e.id}`, kind: 'event', actor: null, text: e.title, result: 'scene', target: null, targetNpc: null, moved: null, items: [] });
    }
  }
  // ISK-009: an arrival ends the arriver's own narration, and joins the feed of a place that has one already (never a new call).
  const arrivals = new Map<string, Arrival>();
  for (const p of world.players.values()) {
    const arrival = arrivalOf(p.memberId);
    if (!arrival) continue;
    const beat: Beat = { actionId: arrivalBeatId(p.ref), kind: 'arrival', actor: p.ref, text: `มาถึง${arrival.place.name}`, result: 'scene', target: null, targetNpc: null, moved: null, items: [] };
    if (playerBeats.has(p.memberId)) {
      push(playerBeats, p.memberId, beat);
      arrivals.set(p.memberId, arrival);
    }
    if (placeBeats.has(arrival.place.id)) push(placeBeats, arrival.place.id, beat);
  }

  // GEN-117: looks only of the reader themself and of whoever the reader looked at; a place feed (many readers) has none.
  const castOf = (beats: Beat[], extra: string[], self: string | null, looked: ReadonlySet<string> = new Set()) => {
    const refs = new Set([...extra, ...looked, ...beats.flatMap((b) => [b.actor, b.target].filter((r): r is string => r !== null))]);
    return [...refs].flatMap((r) => {
      const p = world.byRef.get(r);
      const looks = r === self || looked.has(r) ? world.tokenise(p?.appearance ?? '') : '';
      return p ? [{ ref: r, looks, title: p.socialTitle, self: r === self, karmaBand: karmaBandOf(p.memberId) }] : [];
    });
  };
  const npcsAt = (placeId: string, cast: { ref: string }[]) => npcsFor(placeId, cast.flatMap((c) => world.byRef.get(c.ref)?.memberId ?? []));

  const out: Audience[] = [];
  for (const [placeId, beats] of placeBeats) {
    const readers = [...start].filter(([, loc]) => loc === placeId).map(([id]) => id);
    if (readers.length === 0) continue;
    const cast = castOf(beats, readers.filter((id) => world.players.has(id)).map(ref), null);
    out.push({ key: `place:${placeId}`, placeId, readers, ctx: { audience: { place: placeId }, cast, npcs: npcsAt(placeId, cast), beats } });
  }
  for (const [memberId, beats] of playerBeats) {
    const p = world.players.get(memberId);
    if (!p) continue;
    const placeId = start.get(memberId) ?? p.locationId;
    const cast = castOf(beats, [p.ref], p.ref, lookedAt(memberId));
    const arrival = arrivals.get(memberId);
    out.push({ key: `player:${p.ref}`, placeId, readers: [memberId], ctx: { audience: { player: p.ref }, cast, npcs: npcsAt(placeId, cast), beats, ...(arrival ? { arrival } : {}) } });
  }
  return out;
}

const TEMPLATE_RESULT: Record<string, string> = {
  crit: 'สำเร็จอย่างงดงาม',
  success: 'สำเร็จ',
  fail: 'พลาด',
  fumble: 'พลาดอย่างหนัก',
  no_target: 'แต่เป้าหมายไม่อยู่ตรงนั้นแล้ว',
  skipped: 'แต่ไม่ได้ลงมือ',
  blocked: 'แต่ทำไม่ได้',
};

/**
 * Q-151 (ADR §2 step 8): the server's own text, one segment per beat, when the AI narration is still wrong
 * after its repair. Built only from the audience's beats (the validated outcome), with tokens for people,
 * so it never names someone the reader does not know nor tells what happened elsewhere.
 */
export function templateNarration(ctx: Pick<NarrationContext, 'beats'>): GmNarration {
  return {
    segments: ctx.beats.map((b) => {
      const who = b.actor === null ? '' : `{{p:${b.actor}}}`;
      const outcome = TEMPLATE_RESULT[b.result] ?? '';
      const text = [who, b.text, outcome].filter((s) => s.length > 0).join(' ');
      return { actionId: b.actionId, text: (text.length > 0 ? text : 'มีบางอย่างเกิดขึ้น').slice(0, 800) };
    }),
  };
}

/** Real names (players and NPCs) at least one reader does not know (GEN-050 / GEN-067). */
function forbiddenNamesFor(world: GmWorld, readers: readonly string[]): string[] {
  const names = new Set<string>();
  for (const p of world.players.values()) {
    if (p.name.trim().length === 0) continue;
    if (readers.some((r) => r !== p.memberId && !world.knownNames(r).has(p.memberId))) names.add(p.name);
  }
  for (const n of world.npcs) if (n.name.trim().length > 0 && n.name !== n.alias) names.add(n.name);
  return [...names];
}

/** GEN-117: each forbidden real name → the alias a reader who does not know them sees (a player's Social Title, an NPC's alias). */
function aliasesOf(world: GmWorld, names: readonly string[]): Map<string, string> {
  const alias = new Map<string, string>();
  for (const p of world.players.values()) alias.set(p.name, p.socialTitle);
  for (const n of world.npcs) alias.set(n.name, n.alias);
  return new Map(names.flatMap((name) => (alias.has(name) ? [[name, alias.get(name)!] as const] : [])));
}

/**
 * GEN-117 (Q-292): a player who says their own real name in an action introduces themself: to everyone at their
 * place when the action is Public, to whoever it is aimed at when Secret. One way: it tells the hearers nothing
 * about the speaker knowing them. The pair state is `known_name` (survives a restart); allies know each other
 * by `namesVisibleTo`.
 */
function introduce(db: DbOrTx, world: GmWorld, order: readonly TurnAction[], start: ReadonlyMap<string, string>, lookedAt: ReadonlyMap<string, ReadonlySet<string>>, at: number): void {
  for (const a of order) {
    const me = world.players.get(a.memberId);
    if (!me || !containsName(a.text, me.name)) continue;
    const place = start.get(a.memberId);
    const hearers =
      a.visibility === 'public'
        ? [...start].filter(([, loc]) => loc === place).map(([id]) => id)
        : [...(lookedAt.get(a.memberId) ?? [])].flatMap((ref) => world.byRef.get(ref)?.memberId ?? []);
    for (const id of hearers) if (world.players.has(id)) learnName(db, id, a.memberId, 'introduced', at);
  }
}

/**
 * Tokens → what this reader sees: "คุณ" for themselves, a known real name, otherwise the alias (Social Title; GEN-117: never
 * how they look, that comes only to who looked); NPCs by alias until revealed. `shared`: a text many read (the place feed),
 * where the reader's own token is a person like any other.
 */
export function renderTokens(db: DbOrTx, world: GmWorld, text: string, reader: string | null, shared = false): string {
  let revealed: Set<string> | undefined;
  const isRevealed = (id: string) => (revealed ??= reader === null ? new Set() : new Set(npcBondsOf(db, reader).filter((b) => b.nameRevealed).map((b) => b.npcId))).has(id);
  const nameOf = (kind: string, id: string) => {
    if (kind === 'n') {
      const npc = world.npcs.find((n) => n.id === id);
      return npc ? (isRevealed(id) ? npc.name : npc.alias) : '';
    }
    const p = world.byRef.get(id);
    if (!p) return '';
    if (p.memberId === reader && !shared) return 'คุณ';
    return reader !== null && world.knownNames(reader).has(p.memberId) ? p.name : p.socialTitle;
  };
  // GEN-143: the spaces the AI puts around a token; "คุณ" takes none (Thai writes no space around it).
  const known = text.replace(new RegExp(`([ \\t]*)${TOKEN_PATTERN.source}([ \\t]*)`, 'g'), (_all, before: string, kind: string, id: string, after: string) => {
    const name = nameOf(kind, id);
    return name === 'คุณ' ? name : `${before}${name}${after}`;
  });
  return stripStrayTokens(dedupeNames(known, world));
}

/** GEN-143: a player title written twice in a row (the title, then the same words as the look) shows once. */
function dedupeNames(text: string, world: GmWorld): string {
  const titles = new Set([...world.byRef.values()].map((p) => p.socialTitle.trim()).filter((t) => t.length > 0));
  let out = text;
  for (const t of titles) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}([ \\t]+${escaped})+`, 'g'), t);
  }
  return out;
}

/** HP / Stamina / Karma per player after the turn, for the day / period engine (`PlayerResult`). */
function resultsOf(before: CrossPlayerState, after: CrossPlayerState, log: PhaseActionsLog): Record<string, PlayerResult> {
  const results: Record<string, PlayerResult> = {};
  for (const p of Object.values(after.players)) {
    const was = before.players[p.id]!;
    if (p.hp === was.hp && p.stamina === was.stamina && p.karma === was.karma) continue;
    results[p.id] = { hp: p.hp, stamina: p.stamina, karma: p.karma };
  }
  // GEN-070: a successful EXECUTE on a player out cold kills them for good.
  for (const o of log.outcomes) {
    if (o.status === 'resolved' && o.target?.executed) results[o.target.playerId] = { ...results[o.target.playerId], executed: true };
  }
  return results;
}
