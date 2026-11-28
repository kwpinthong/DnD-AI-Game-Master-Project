import { validatePhaseActions, type CrossPlayerState, type PhaseAction, type TagContext } from '@isekai/rules';
import { playerToken, TOKEN_PATTERN, type GmWorld, type NarrationContext, type TurnAction } from './context.ts';
import { hasSidePrefix } from '../timeline/store.ts';
import type { GmNarration, GmTurnProposal } from './schema.ts';

/**
 * The server's checks of an AI GM answer (GEN-057, Q-049 all-or-nothing). Every problem is collected, so the
 * one repair call gets the whole list. Messages go back into a prompt: they name refs and ids, never a real name.
 */
export interface GmError {
  code: string;
  path: string;
  message: string;
}

export interface TurnCheckInput {
  world: GmWorld;
  state: CrossPlayerState;
  tags: Readonly<Record<string, TagContext>>;
  /** The turn's actions in the server's order. */
  order: readonly TurnAction[];
  activeEventIds: ReadonlySet<string>;
  activeConstraintIds: ReadonlySet<number>;
  /** GEN-059: the day 12 finale event is active (only then may the proposal name an `endingPath`). */
  finaleActive: boolean;
  /**
   * GEN-093: the Day10_Strategies plan ids of the game data (`known`, D10-DRIFT left out) and the ones an active
   * event names now (`active`, the night of day 10); an action's `strategy` must be in both.
   */
  strategies: { known: ReadonlySet<string>; active: ReadonlySet<string> };
}

export type TurnCheck = { ok: true; actions: PhaseAction[] } | { ok: false; errors: GmError[] };

export function checkTurnProposal(input: TurnCheckInput, proposal: GmTurnProposal): TurnCheck {
  const { world, order } = input;
  const errors: GmError[] = [];
  const fail = (code: string, path: string, message: string) => errors.push({ code, path, message });
  const byId = new Map(order.map((a) => [a.actionId, a]));
  const given = proposal.actions.map((a) => a.actionId);

  for (const a of order) if (!given.includes(a.actionId)) fail('missing_action', 'actions', `no proposal for action ${a.actionId}; answer every id of order`);
  const seen = new Set<string>();
  proposal.actions.forEach((a, i) => {
    if (!byId.has(a.actionId)) fail('unknown_action', `actions[${i}].actionId`, `${a.actionId} is not an action of this turn`);
    else if (seen.has(a.actionId)) fail('duplicate_action', `actions[${i}].actionId`, `${a.actionId} is answered twice`);
    seen.add(a.actionId);
  });
  if (errors.length === 0 && given.some((id, i) => order[i]!.actionId !== id)) {
    fail('order_mismatch', 'actions', `answer the actions in the server order: ${order.map((a) => a.actionId).join(', ')}`);
  }

  const memberOfRef = (ref: string) => world.byRef.get(ref)?.memberId;
  const places = new Set(world.places.map((p) => p.id));
  const actions: PhaseAction[] = [];
  const indexOf: number[] = [];
  proposal.actions.forEach((a, i) => {
    const turnAction = byId.get(a.actionId);
    if (!turnAction) return;
    const path = `actions[${i}]`;
    if (memberOfRef(a.actor) !== turnAction.memberId) fail('actor_mismatch', `${path}.actor`, `the actor of ${a.actionId} is ${world.players.get(turnAction.memberId)?.ref}`);
    // A proposal stored before GEN-093 has no strategy.
    const plan = a.strategy ?? null;
    if (plan !== null && !input.strategies.known.has(plan.id)) {
      fail('unknown_strategy', `${path}.strategy.id`, `${plan.id} is not a plan of Day10_Strategies; use an id of the active event's strategies or null`);
    } else if (plan !== null && !input.strategies.active.has(plan.id)) {
      fail('strategy_not_active', `${path}.strategy`, `${plan.id} is only for the night of day 10 while its event is active; answer null`);
    }
    (a.looksAt ?? []).forEach((r, k) => {
      if (memberOfRef(r) === undefined) fail('unknown_ref', `${path}.looksAt[${k}]`, `${r} is not a player ref of this game`);
    });
    if (a.moveTo !== null && !places.has(a.moveTo)) fail('unknown_location', `${path}.moveTo`, `the scenario has no place ${a.moveTo}`);
    let targetMember: string | undefined;
    if (a.targetPlayer !== null) {
      targetMember = memberOfRef(a.targetPlayer.player);
      if (targetMember === undefined) fail('unknown_ref', `${path}.targetPlayer.player`, `${a.targetPlayer.player} is not a player ref of this game`);
    }
    const tagging = a.tagging.verbTags.length > 0 || a.tagging.activate.length > 0 ? a.tagging : undefined;
    actions.push({
      actorId: turnAction.memberId,
      proposal: {
        actionId: a.actionId,
        kind: a.kind,
        tags: a.tags,
        opposed: a.opposed,
        staminaCost: a.staminaCost,
        visibility: turnAction.visibility,
        target: a.targetNpc === null ? null : { npc: a.targetNpc },
        check: a.check.type === 'dc' ? { type: 'dc', dc: a.check.dc as 5 } : a.check,
        modifiers: a.modifiers,
        witnessNpcIds: a.witnessNpcIds,
        repDeltaIfCaught: a.repDeltaIfCaught,
        onSuccess: a.onSuccess,
        onFail: a.onFail,
        reason: a.reason,
        ...(tagging ? { tagging } : {}),
      },
      targetPlayer:
        a.targetPlayer === null || targetMember === undefined
          ? null
          : {
              player: targetMember,
              intent: a.targetPlayer.intent,
              reachRef: null,
              defenseRef: a.targetPlayer.defenseRef,
              perceptionRef: a.targetPlayer.perceptionRef,
              onSuccess: a.targetPlayer.onSuccess,
              onFail: a.targetPlayer.onFail,
            },
      moveTo: a.moveTo,
      awareness: a.awareness,
    });
    indexOf.push(i);
  });

  // The rules engine's own checks (Rules Spec §13 + GEN-060 + GEN-064 tags), before any die.
  for (const e of validatePhaseActions({ state: input.state, actions, tags: input.tags })) {
    fail(e.code, `actions[${indexOf[e.action]}].${e.path.replace(/^proposal\./, '')}`, refsOnly(world, e.message));
  }

  proposal.constraints.add.forEach((c, i) => {
    if (memberOfRef(c.player) === undefined) fail('unknown_ref', `constraints.add[${i}].player`, `${c.player} is not a player ref of this game`);
  });
  proposal.constraints.release.forEach((c, i) => {
    if (!input.activeConstraintIds.has(c.id)) fail('unknown_constraint', `constraints.release[${i}].id`, `constraint ${c.id} is not active`);
    if (c.reason.trim().length === 0) fail('release_without_reason', `constraints.release[${i}].reason`, 'a constraint is released only with the reason it ends');
  });
  proposal.eventOutcomes.forEach((e, i) => {
    if (!input.activeEventIds.has(e.eventId)) fail('unknown_event', `eventOutcomes[${i}].eventId`, `${e.eventId} is not an active event this period`);
    // Q-243: the side is its own field. A proposal stored before the field existed (no `side`) keeps its old prefix; the store splits it.
    if (e.side !== undefined && hasSidePrefix(e.outcome)) {
      fail('outcome_side_prefix', `eventOutcomes[${i}].outcome`, 'outcome must not begin with a side name (Good: / Evil: / Neutral:); put the side in eventOutcomes.side and write only what happened');
    }
  });
  // Stored proposals from before GEN-059 have no endingPath.
  if ((proposal.endingPath ?? null) !== null && !input.finaleActive) {
    fail('ending_path_not_allowed', 'endingPath', 'endingPath is only for the day 12 finale event while it is active; answer null');
  }

  return errors.length === 0 ? { ok: true, actions } : { ok: false, errors };
}

/** Member ids in rule messages become player refs (the AI knows players by ref only). */
function refsOnly(world: GmWorld, message: string): string {
  let out = message;
  for (const p of world.players.values()) out = out.split(p.memberId).join(p.ref);
  return out;
}

const SEGMENTER = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
const MARK = /\p{M}/u;

/**
 * Q-152: whether `text` names `name` as a whole word, both NFC-normalised and the name trimmed. Thai has no
 * spaces, so the Thai word segmenter (ICU dictionary) decides: an occurrence does not count when one
 * segment holds all of it and more (ลิน inside the dictionary word คลินิก, ดา inside ดารา, Lin inside
 * Linda). A name the dictionary does not know comes out in odd pieces (ดาริน → ดา|ริน, ลินที่ → ลิ|นที่);
 * none of them holds the whole name, so it still counts. An occurrence followed by a combining mark is
 * part of another syllable and does not count. Without Intl.Segmenter every other occurrence counts.
 */
export function containsName(text: string, name: string): boolean {
  return nameOccurrences(text.normalize('NFC'), name.normalize('NFC').trim()).length > 0;
}

/** GEN-169: how many times `text` has `word` as a whole word (same rule as `containsName`). */
export const wordCount = (text: string, word: string): number => nameOccurrences(text.normalize('NFC'), word.normalize('NFC').trim()).length;

const THAI = /[฀-๿]/;
/** GEN-202: a Thai/non-Thai script change is a word edge even inside one segment (ICU keeps ของNok as one). */
const glued = (t: string, at: number) => THAI.test(t[at - 1]!) !== THAI.test(t[at]!);

/** Start offsets in `t` (already NFC) of the whole-word occurrences of `n` (NFC, trimmed); see `containsName`. */
export function nameOccurrences(t: string, n: string): number[] {
  const found: number[] = [];
  if (n.length === 0) return found;
  let words: (readonly [number, number])[] | null = null;
  for (let i = t.indexOf(n); i !== -1; i = t.indexOf(n, i + 1)) {
    const end = i + n.length;
    if (end < t.length && MARK.test(t[end]!)) continue;
    if (SEGMENTER) {
      words ??= [...SEGMENTER.segment(t)].map((s) => [s.index, s.index + s.segment.length] as const);
      const inside = ([from, to]: readonly [number, number]) =>
        from <= i && end <= to && to - from > n.length && (from === i || !glued(t, i)) && (end === to || !glued(t, end));
      if (words.some(inside)) continue;
    }
    found.push(i);
  }
  return found;
}

/** GEN-117 C6: `text` with every whole-word occurrence of each real name swapped for its alias (longest names first). */
export function maskNames(text: string, aliases: ReadonlyMap<string, string>): string {
  let out = text.normalize('NFC');
  for (const [name, alias] of [...aliases].sort((x, y) => y[0].length - x[0].length)) {
    const n = name.normalize('NFC').trim();
    for (const i of nameOccurrences(out, n).reverse()) out = out.slice(0, i) + alias + out.slice(i + n.length);
  }
  return out;
}

/**
 * A narration for one audience. `forbiddenNames`: real names a reader of this text does not know (C3); the
 * message never repeats the name, so it does not end up in the repair prompt (Q-045).
 */
export function checkNarration(ctx: NarrationContext, out: GmNarration, forbiddenNames: readonly string[]): GmError[] {
  const errors: GmError[] = [];
  const fail = (code: string, path: string, message: string) => errors.push({ code, path, message });
  const beatIndex = new Map(ctx.beats.map((b, i) => [b.actionId, i]));
  // ISK-009: who is at the place the reader arrived at may be named too.
  const cast = new Set([...ctx.cast.map((c) => c.ref), ...(ctx.arrival?.players ?? [])]);
  const npcs = new Set([...ctx.npcs, ...(ctx.arrival?.npcs ?? [])].map((n) => n.id));
  // ISK-026: the reader's own arrival is told in `arrival`, never as a segment (a segment is cut to 120).
  const ownArrival = ctx.arrival ? ctx.beats.find((b) => b.kind === 'arrival')?.actionId : undefined;
  const checkText = (text: string, path: string) => {
    for (const [, kind, id] of text.matchAll(TOKEN_PATTERN)) {
      if (kind === 'p' && !cast.has(id!)) fail('unknown_ref', path, `${playerToken(id!)} is not in the cast of this audience`);
      if (kind === 'n' && !npcs.has(id!)) fail('unknown_ref', path, `{{n:${id}}} is not an NPC of this place`);
    }
    if (forbiddenNames.some((name) => containsName(text, name))) fail('name_leak', path, 'the text has a real name the reader does not know; use the {{p:ref}} / {{n:id}} tokens only');
  };
  let last = -1;
  out.segments.forEach((s, i) => {
    const path = `segments[${i}]`;
    const at = beatIndex.get(s.actionId);
    if (at === undefined) fail('unknown_action', `${path}.actionId`, `${s.actionId} is not a beat of this audience; tell only the beats given`);
    else if (s.actionId === ownArrival) fail('arrival_segment', `${path}.actionId`, `tell ${s.actionId} in arrival, not as a segment`);
    else if (at < last) fail('beat_order', `${path}.actionId`, 'tell the beats in the order given');
    else last = at;
    checkText(s.text, `${path}.text`);
  });
  if (out.arrival !== undefined && ownArrival === undefined) fail('unknown_action', 'arrival', 'this audience has no arrival of its own; leave arrival out');
  else if (out.arrival !== undefined) checkText(out.arrival, 'arrival');
  for (const b of ctx.beats) {
    if (b.actionId === ownArrival) {
      if (out.arrival === undefined) fail('missing_beat', 'arrival', `no arrival for beat ${b.actionId}`);
    } else if (!out.segments.some((s) => s.actionId === b.actionId)) fail('missing_beat', 'segments', `no segment for beat ${b.actionId}`);
  }
  return errors;
}
