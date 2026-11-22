import { validatePhaseActions, type CrossPlayerState, type PhaseAction, type TagContext } from '@isekai/rules';
import { playerToken, TOKEN_PATTERN, type GmWorld, type NarrationContext, type TurnAction } from './context.ts';
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
  });

  return errors.length === 0 ? { ok: true, actions } : { ok: false, errors };
}

/** Member ids in rule messages become player refs (the AI knows players by ref only). */
function refsOnly(world: GmWorld, message: string): string {
  let out = message;
  for (const p of world.players.values()) out = out.split(p.memberId).join(p.ref);
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
  const cast = new Set(ctx.cast.map((c) => c.ref));
  const npcs = new Set(ctx.npcs.map((n) => n.id));
  let last = -1;
  out.segments.forEach((s, i) => {
    const path = `segments[${i}]`;
    const at = beatIndex.get(s.actionId);
    if (at === undefined) fail('unknown_action', `${path}.actionId`, `${s.actionId} is not a beat of this audience; tell only the beats given`);
    else if (at < last) fail('beat_order', `${path}.actionId`, 'tell the beats in the order given');
    else last = at;
    for (const [, kind, id] of s.text.matchAll(TOKEN_PATTERN)) {
      if (kind === 'p' && !cast.has(id!)) fail('unknown_ref', `${path}.text`, `${playerToken(id!)} is not in the cast of this audience`);
      if (kind === 'n' && !npcs.has(id!)) fail('unknown_ref', `${path}.text`, `{{n:${id}}} is not an NPC of this place`);
    }
    if (forbiddenNames.some((name) => s.text.includes(name))) fail('name_leak', `${path}.text`, 'the text has a real name the reader does not know; use the {{p:ref}} / {{n:id}} tokens only');
  });
  for (const b of ctx.beats) if (!out.segments.some((s) => s.actionId === b.actionId)) fail('missing_beat', 'segments', `no segment for beat ${b.actionId}`);
  return errors;
}
