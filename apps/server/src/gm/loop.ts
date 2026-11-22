import {
  ReplayRng,
  isDrowsy,
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
import type { GameAssets } from '../assets/load.ts';
import { tagVocabulary } from '../assets/tags.ts';
import type { Clock } from '../auth/join.ts';
import { applyPhaseActions, crossPlayerState } from '../crossplayer/phase.ts';
import { tagContexts, weatherTagging, type TaggingOptions } from '../crossplayer/tags.ts';
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { gamePhase } from '../db/schema.ts';
import type { ClosedPhase, PhaseResolution, PhaseResolver, ResolutionEntry, ResolverStuck } from '../room/resolver.ts';
import { CryptoRng } from '../rng.ts';
import { buildEventContext } from '../timeline/context.ts';
import { setEventOutcome } from '../timeline/store.ts';
import { discoverHiddenEvidence, locationSnapshot, npcBondsOf } from '../visibility/store.ts';
import { checkNarration, checkTurnProposal, type GmError } from './check.ts';
import {
  CONTEXT_BUDGET,
  NARRATOR_BLOCK,
  RULES_BLOCK,
  SUMMARY_BLOCK,
  TOKEN_PATTERN,
  buildTurnContext,
  loadWorld,
  requestTokens,
  type Beat,
  type DayContext,
  type GmWorld,
  type NarrationContext,
  type TurnAction,
} from './context.ts';
import { GM_OUTPUT, GmDaySummary, GmNarration, GmTurnProposal } from './schema.ts';
import {
  activeConstraints,
  addConstraint,
  dayLog,
  getStoredTurn,
  hasDaySummary,
  latestSaga,
  markApplied,
  releaseConstraint,
  saveAdjudicated,
  saveDaySummary,
  saveNarration,
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
}

const STUCK_MESSAGE = 'AI GM ติดขัด สรุปผลเทิร์นนี้ไม่ได้ action ทุกอันยังอยู่ กด "ลองใหม่" ได้';
const BUDGET_PLAYER_MESSAGE = 'AI GM ติดขัด: AI ของเกมนี้ใช้ครบงบของเดือนแล้ว รอเจ้าของเกมจัดการ action ทุกอันยังอยู่';
const NOT_READY_PLAYER_MESSAGE = 'AI GM ติดขัด: ยังเรียก AI ไม่ได้ รอเจ้าของเกมจัดการ action ทุกอันยังอยู่';

const RESULT_OF = (o: ActionOutcome): string => (o.status === 'resolved' ? o.log.degree : o.status);

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
  const vocabulary = tagVocabulary(assets);

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
    signal?: AbortSignal;
  }): Promise<T> {
    const first: { role: 'user' | 'assistant'; text: string }[] = [{ role: 'user', text: JSON.stringify(opts.context) }];
    if (requestTokens(opts.system, first) > opts.budget) stuck(`limit_exceeded ${opts.purpose}`, opts.gameId);
    let messages = first;
    for (const purpose of [opts.purpose, opts.repairPurpose]) {
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
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!result.ok) throw new StuckError(stuckFrom(result.error));
      const errors = opts.check(result.value);
      if (errors.length === 0) return result.value;
      log(`[gm] game=${opts.gameId} purpose=${purpose} refused: ${[...new Set(errors.map((e) => e.code))].join(', ')}`);
      messages = [
        ...first,
        { role: 'assistant' as const, text: JSON.stringify(result.value) },
        { role: 'user' as const, text: JSON.stringify({ errors, instruction: 'แก้ทุกข้อแล้วตอบใหม่ทั้งก้อนในรูปแบบเดิม' }) },
      ];
    }
    return stuck(`still invalid after repair (${opts.purpose})`, opts.gameId);
  }

  async function resolveTurn(input: ClosedPhase): Promise<PhaseResolution> {
    const { gameId, at, signal } = input;
    const world = loadWorld(db, gameId, assets);
    const drowsy = new Set(input.state.order.filter((id) => input.state.players[id] && isDrowsy(input.state.players[id]!, input.state.day)));
    const state = crossPlayerState(db, gameId, drowsy);
    const tagging: TaggingOptions = weatherTagging(assets, at.day, at.phase, input.weather ?? null);
    const tags = tagContexts(db, gameId, state, tagging);

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
    const events = buildEventContext(db, gameId, at.day, at.phase);
    const checkInput = (o: TurnAction[]) => ({
      world,
      state,
      tags,
      order: o,
      activeEventIds: new Set(events.active.map((e) => e.id)),
      activeConstraintIds: new Set(constraints.map((c) => c.id)),
    });

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
        vocabulary,
        drowsy,
        at,
        actions: order,
        resting: input.actions.filter((a) => a.rest).map((a) => a.memberId),
        weather: input.weather ?? null,
      });
      let checked: PhaseAction[] = [];
      const proposal = await ask({
        gameId,
        at,
        purpose: 'gm_adjudicate',
        repairPurpose: 'gm_repair',
        system: [RULES_BLOCK],
        context,
        output: { name: GM_OUTPUT.turn, schema: GmTurnProposal },
        maxOutputTokens: 8_000,
        budget: CONTEXT_BUDGET.gm_adjudicate,
        check: (p) => {
          const r = checkTurnProposal(checkInput(order), p);
          if (r.ok) checked = r.actions;
          return r.ok ? [] : r.errors;
        },
        ...(signal ? { signal } : {}),
      });
      actions = checked;
      const rng = new TurnRng(new CryptoRng(), orderRng.faces);
      const result = resolvePhaseActions({ state, actions, tags }, rng);
      if (!result.ok) return stuck(`rules refused a checked proposal`, gameId);
      resolved = result;
      saveAdjudicated(db, gameId, at, proposal, result.log.rolls, now());
      stored = { status: 'adjudicated', proposal, rolls: [...result.log.rolls], narrations: {} };
    } else {
      // Restart: the stored proposal is in the server's order already; the stored dice replay everything.
      const memberOfAction = new Map(acting.map((a) => [actionIdOf(a.memberId), a.memberId]));
      order = stored.proposal.actions.flatMap((a) => (memberOfAction.has(a.actionId) ? [toTurnAction(memberOfAction.get(a.actionId)!)] : []));
      const r = checkTurnProposal(checkInput(order), stored.proposal);
      if (!r.ok) return stuck('stored proposal no longer fits the game', gameId);
      actions = r.actions;
      const result = resolvePhaseActions({ state, actions, tags }, new ReplayRng(stored.rolls));
      if (!result.ok) return stuck('stored dice no longer replay', gameId);
      resolved = result;
    }

    // 5: narration per place and per player.
    const proposal = stored.proposal;
    const textOf = new Map(order.map((a) => [a.actionId, world.tokenise(a.text)]));
    const placeName = new Map(world.places.map((p) => [p.id, p.name]));
    const start = locationSnapshot(db, gameId);
    const investigators = new Set(proposal.actions.filter((a) => a.investigate).map((a) => a.actionId));
    // Q-135: found Hidden Evidence is narrated from its id + place + day only (never who left it).
    const evidenceFor = (o: ActionOutcome): Beat[] =>
      o.status === 'resolved' && investigators.has(o.actionId)
        ? discoverHiddenEvidence(db, gameId, o.actorId, at.day, o.log.degree).map((f) => ({
            actionId: `evidence:${f.id}`,
            kind: 'evidence' as const,
            actor: world.players.get(o.actorId)!.ref,
            text: `พบร่องรอยลับ (หลักฐาน ${f.id}) ที่${placeName.get(f.locationId) ?? f.locationId} ซึ่งมีคนทิ้งไว้ในวันที่ ${f.day}`,
            result: 'scene',
            target: null,
            moved: null,
            items: [],
          }))
        : [];
    const audiences = narrationAudiences(world, resolved.log, textOf, start, events.active, evidenceFor);
    const narrations: { key: string; ctx: NarrationContext; out: GmNarration }[] = [];
    for (const audience of audiences) {
      const ctx: NarrationContext = { kind: 'gm_narration', ...audience.ctx, turn: at, place: { id: audience.placeId, name: placeName.get(audience.placeId) ?? audience.placeId } };
      const saved = stored.narrations[audience.key];
      const forbidden = forbiddenNamesFor(world, audience.readers);
      const out =
        saved ??
        (await ask({
          gameId,
          at,
          purpose: 'player' in ctx.audience ? 'narrate_player' : 'narrate_place',
          repairPurpose: 'player' in ctx.audience ? 'narrate_player' : 'narrate_place',
          system: [NARRATOR_BLOCK],
          context: ctx,
          output: { name: GM_OUTPUT.narration, schema: GmNarration },
          maxOutputTokens: 1_500,
          budget: 'player' in ctx.audience ? CONTEXT_BUDGET.narrate_player : CONTEXT_BUDGET.narrate_place,
          check: (n) => checkNarration(ctx, n, forbidden),
          ...(signal ? { signal } : {}),
        }));
      if (!saved) saveNarration(db, gameId, at, audience.key, out, now());
      narrations.push({ key: audience.key, ctx, out });
    }

    // 6: what the room publishes and applies.
    const entries: ResolutionEntry[] = narrations.map(({ ctx, out }) => {
      const reader = 'player' in ctx.audience ? world.byRef.get(ctx.audience.player)!.memberId : null;
      const text = out.segments.map((s) => renderTokens(db, world, s.text, reader)).join('\n');
      return reader === null ? { kind: 'feed', locationId: ctx.place.id, actorMemberId: null, text } : { kind: 'narration', memberId: reader, text };
    });
    const rolls = stored.rolls;
    return {
      results: resultsOf(state, resolved.state, resolved.log, world),
      entries,
      apply: (tx) => {
        const applied = applyPhaseActions(tx, gameId, actions, new ReplayRng(rolls), now(), tagging, drowsy);
        if (!applied.ok) throw new Error('the stored turn no longer applies');
        for (const c of proposal.constraints.add) {
          addConstraint(tx, { gameId, memberId: world.byRef.get(c.player)!.memberId, text: c.text, reason: c.reason, day: at.day }, now());
        }
        for (const c of proposal.constraints.release) releaseConstraint(tx, gameId, c.id, c.reason, at.day);
        for (const e of proposal.eventOutcomes) setEventOutcome(tx, gameId, e.eventId, e.outcome, now());
        markApplied(tx, gameId, at, now());
      },
      after: () => summarizeFinishedDays(gameId, at),
    };
  }

  /** Day summaries for every finished day that has none (C5); a failure is retried after the next turn. */
  async function summarizeFinishedDays(gameId: string, at: TurnAt): Promise<void> {
    const current = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, gameId)).get()?.state;
    const day = current ? (JSON.parse(current) as { day: number }).day : at.day;
    for (let d = 1; d < day; d++) {
      if (hasDaySummary(db, gameId, d)) continue;
      const context: DayContext = { kind: 'gm_day', day: d, saga: latestSaga(db, gameId, d), log: dayLog(db, gameId, d) };
      const system = [SUMMARY_BLOCK];
      const messages = [{ role: 'user' as const, text: JSON.stringify(context) }];
      if (requestTokens(system, messages) > CONTEXT_BUDGET.summarize_day) {
        log(`[gm] game=${gameId} summarize_day day=${d} limit_exceeded`);
        continue;
      }
      const result = await ai.call({
        gameId,
        purpose: 'summarize_day',
        day: d,
        system,
        messages,
        output: { name: GM_OUTPUT.daySummary, schema: GmDaySummary },
        maxOutputTokens: 1_500,
      });
      if (!result.ok) {
        log(`[gm] game=${gameId} summarize_day day=${d} failed: ${result.error.code}`);
        return;
      }
      saveDaySummary(db, gameId, d, result.value, now());
    }
  }

  return {
    async resolve(input) {
      try {
        return await resolveTurn(input);
      } catch (error) {
        if (error instanceof StuckError) return { stuck: error.stuck };
        throw error;
      }
    },
  };
}

// --- Audiences and beats (ADR §5.1): who learns what of the turn ---

interface Audience {
  key: string;
  placeId: string;
  /** Members who read the text (the player, or everyone at the place when the turn closed). */
  readers: string[];
  ctx: Pick<NarrationContext, 'audience' | 'cast' | 'npcs' | 'beats'>;
}

function narrationAudiences(
  world: GmWorld,
  log: PhaseActionsLog,
  textOf: ReadonlyMap<string, string>,
  start: ReadonlyMap<string, string>,
  activeEvents: readonly { id: string; title: string; place: string | null }[],
  evidenceFor: (o: ActionOutcome) => Beat[],
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
  for (const e of activeEvents) {
    if (e.place === null) continue;
    const placeId = world.places.find((p) => p.name === e.place)?.id;
    if (placeId) push(placeBeats, placeId, { actionId: `event:${e.id}`, kind: 'event', actor: null, text: e.title, result: 'scene', target: null, moved: null, items: [] });
  }

  const castOf = (beats: Beat[], extra: string[], self: string | null) => {
    const refs = new Set([...extra, ...beats.flatMap((b) => [b.actor, b.target].filter((r): r is string => r !== null))]);
    return [...refs].flatMap((r) => {
      const p = world.byRef.get(r);
      return p ? [{ ref: r, looks: world.tokenise(p.appearance), title: p.socialTitle, self: r === self }] : [];
    });
  };
  const npcsAt = (placeId: string) => world.npcs.filter((n) => n.locationId === placeId).map((n) => ({ id: n.id, alias: n.alias }));

  const out: Audience[] = [];
  for (const [placeId, beats] of placeBeats) {
    const readers = [...start].filter(([, loc]) => loc === placeId).map(([id]) => id);
    if (readers.length === 0) continue;
    out.push({
      key: `place:${placeId}`,
      placeId,
      readers,
      ctx: { audience: { place: placeId }, cast: castOf(beats, readers.filter((id) => world.players.has(id)).map(ref), null), npcs: npcsAt(placeId), beats },
    });
  }
  for (const [memberId, beats] of playerBeats) {
    const p = world.players.get(memberId);
    if (!p) continue;
    const placeId = start.get(memberId) ?? p.locationId;
    out.push({ key: `player:${p.ref}`, placeId, readers: [memberId], ctx: { audience: { player: p.ref }, cast: castOf(beats, [p.ref], p.ref), npcs: npcsAt(placeId), beats } });
  }
  return out;
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

/** Tokens → what this reader sees: "คุณ" for themselves, a known real name, otherwise how they look; NPCs by alias until revealed. */
function renderTokens(db: DbOrTx, world: GmWorld, text: string, reader: string | null): string {
  const revealed = reader === null ? new Set<string>() : new Set(npcBondsOf(db, reader).filter((b) => b.nameRevealed).map((b) => b.npcId));
  return text.replace(TOKEN_PATTERN, (_all, kind: string, id: string) => {
    if (kind === 'n') {
      const npc = world.npcs.find((n) => n.id === id);
      return npc ? (revealed.has(id) ? npc.name : npc.alias) : '';
    }
    const p = world.byRef.get(id);
    if (!p) return '';
    if (p.memberId === reader) return 'คุณ';
    return reader !== null && world.knownNames(reader).has(p.memberId) ? p.name : p.appearance;
  });
}

/** HP / Stamina / Karma per player after the turn, for the day / period engine (`PlayerResult`). */
function resultsOf(before: CrossPlayerState, after: CrossPlayerState, log: PhaseActionsLog, world: GmWorld): Record<string, PlayerResult> {
  const results: Record<string, PlayerResult> = {};
  for (const p of Object.values(after.players)) {
    const was = before.players[p.id]!;
    if (p.hp === was.hp && p.stamina === was.stamina && p.karma === was.karma) continue;
    const safety = world.places.find((l) => l.id === p.locationId)?.safety as PlayerResult['safety'];
    results[p.id] = { hp: p.hp, stamina: p.stamina, karma: p.karma, ...(p.hp === 0 && safety ? { safety } : {}) };
  }
  for (const o of log.outcomes) {
    if (o.status !== 'resolved' || o.target === null) continue;
    const action = log.input.actions.find((a) => a.proposal.actionId === o.actionId);
    if (action?.targetPlayer?.intent === 'rescue' && (o.log.degree === 'success' || o.log.degree === 'crit')) {
      results[o.target.playerId] = { ...results[o.target.playerId], rescued: true };
    }
  }
  return results;
}
