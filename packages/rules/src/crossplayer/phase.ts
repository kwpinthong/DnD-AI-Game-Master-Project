import { rollDice } from '../dice.ts';
import type { Rng } from '../rng.ts';
import { ReplayRng, resolveAction } from '../resolution/resolve.ts';
import { RULES, SEVERITY_BASE, TIER_CAP, clamp, computeStat } from '../resolution/tables.ts';
import { SEVERITIES, type NpcState, type OwnedRef, type ProposalErrorCode } from '../resolution/types.ts';
import { validateProposal } from '../resolution/validate.ts';
import {
  PLAYER_INTENTS,
  type ActionOutcome,
  type Awareness,
  type CrossPlayerError,
  type CrossPlayerErrorCode,
  type OrderLog,
  type PhaseAction,
  type PhaseActionsInput,
  type PhaseActionsResult,
  type PhaseActionsLog,
  type PlayerEffects,
  type PlayerState,
  type PriorityRoll,
  type RollOff,
  type TargetGearRef,
  type TargetResult,
} from './types.ts';

/** Records every die drawn so the phase log replays. */
class RecordingRng implements Rng {
  readonly faces: number[] = [];
  readonly #inner: Rng;

  constructor(inner: Rng) {
    this.#inner = inner;
  }

  nextInt(min: number, max: number): number {
    const face = this.#inner.nextInt(min, max);
    this.faces.push(face);
    return face;
  }
}

const d20 = (rng: Rng) => rollDice('1d20', rng).faces[0]!;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Spec §10.5: at most this many roll-off rounds, then seat order. */
const ROLL_OFF_ROUNDS = 3;
/** Spec §10.2: an action whose target is out of reach costs a general action. */
const NO_TARGET_COST = 3;
/** Spec §10.3: DC_pvp base. */
const PVP_DC_BASE = 11;
const AWARENESS_MOD: Readonly<Record<Awareness, number>> = { watch: 3, asleep: -5, normal: 0 };
/** Spec §10.4: A acts on B from another place with reach: remote. */
const REMOTE_AWARENESS = -5;
/** Spec §10.2: the intents that may target an unconscious player. */
const UNCONSCIOUS_OK = new Set(['rescue', 'steal']);

/**
 * Orders the players who act this phase (spec §10.5, T1):
 * priority = d20 + floor(Stamina / 5) + stat(actor, 'priority'), high first; tie -> higher Stamina ->
 * higher HP -> roll-off d20 (higher first, ≤ 3 rounds) -> seat order. Priority dice are rolled in seat order.
 */
export function orderPhaseActions(players: readonly PlayerState[], rng: Rng): OrderLog {
  const bySeat = [...players].sort((a, b) => a.seat - b.seat);
  const priorities: PriorityRoll[] = bySeat.map((p) => {
    const roll = d20(rng);
    const staminaBonus = Math.floor(p.stamina / 5);
    const stat = computeStat(p, { use: 'priority' });
    return { playerId: p.id, d20: roll, staminaBonus, stat, priority: roll + staminaBonus + stat };
  });
  const priorityOf = new Map(priorities.map((p) => [p.playerId, p.priority]));
  const key = (p: PlayerState) => [priorityOf.get(p.id)!, p.stamina, p.hp];
  const sorted = [...bySeat].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return kb[0]! - ka[0]! || kb[1]! - ka[1]! || kb[2]! - ka[2]!;
  });

  const rollOffs: RollOff[] = [];
  const rollOff = (group: readonly PlayerState[], round: number): PlayerState[] => {
    if (round > ROLL_OFF_ROUNDS) return [...group];
    const rolls = group.map((p) => ({ playerId: p.id, d20: d20(rng) }));
    rollOffs.push({ round, rolls });
    const faceOf = new Map(rolls.map((r) => [r.playerId, r.d20]));
    return splitTies([...group].sort((a, b) => faceOf.get(b.id)! - faceOf.get(a.id)!), (p) => faceOf.get(p.id)!, (tied) => rollOff(tied, round + 1));
  };
  const order = splitTies(sorted, (p) => key(p).join(','), (tied) => rollOff(tied, 1));
  return { order: order.map((p) => p.id), priorities, rollOffs };
}

/** Walks a sorted list and replaces each run of equal keys (length > 1) with `breakTie(run)`. */
function splitTies<T>(sorted: readonly T[], keyOf: (item: T) => unknown, breakTie: (tied: readonly T[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && keyOf(sorted[j]!) === keyOf(sorted[i]!)) j++;
    const run = sorted.slice(i, j);
    out.push(...(run.length > 1 ? breakTie(run) : run));
    i = j;
  }
  return out;
}

/**
 * Resolves one phase's actions (GEN-060, spec §10): validate every action against the phase-start
 * snapshot (all-or-nothing, Q-049: on any error nothing is rolled), order them (§10.5), then resolve
 * each against the state the earlier ones left: a target out of reach at the actor's turn is
 * `no_target` (§10.2), a Secret against a player gives the target an observation roll (§10.4),
 * moves apply in order. Never mutates the input.
 */
export function resolvePhaseActions(input: PhaseActionsInput, rng: Rng): PhaseActionsResult {
  const errors = validatePhaseActions(input);
  if (errors.length > 0) return { ok: false, errors };

  const snapshot = copy(input);
  const dice = new RecordingRng(rng);
  const byActor = new Map(snapshot.actions.map((a) => [a.actorId, a]));
  const order = orderPhaseActions(
    snapshot.actions.map((a) => snapshot.state.players[a.actorId]!),
    dice,
  );

  const players: Record<string, PlayerState> = copy(snapshot.state.players);
  let npcs: Record<string, NpcState> = copy(snapshot.state.npcs);
  const outcomes: ActionOutcome[] = [];

  for (const actorId of order.order) {
    const action = byActor.get(actorId)!;
    const { proposal, targetPlayer } = action;
    const actor = players[actorId]!;
    if (actor.hp <= 0) {
      outcomes.push({ status: 'skipped', actionId: proposal.actionId, actorId, reason: 'actor_unconscious' });
      continue;
    }
    const locations = Object.fromEntries(Object.values(players).map((p) => [p.id, p.locationId]));
    const base = { actionId: proposal.actionId, actorId, visibility: proposal.visibility, locationId: actor.locationId, locations };

    const target = targetPlayer === null ? null : players[targetPlayer.player]!;
    if (targetPlayer !== null && target !== null) {
      const remote = targetPlayer.reachRef !== null;
      const reason =
        target.locationId !== actor.locationId && !remote
          ? ('not_same_place' as const)
          : target.hp <= 0 && !UNCONSCIOUS_OK.has(targetPlayer.intent)
            ? ('target_unconscious' as const)
            : null;
      if (reason !== null) {
        const net = Math.max(RULES.minNetCost, NO_TARGET_COST - actor.afterActionStamina);
        const after = clamp(actor.stamina - net, 0, RULES.staminaMax);
        players[actorId] = { ...actor, stamina: after };
        outcomes.push({ status: 'no_target', ...base, targetId: target.id, reason, stamina: { before: actor.stamina, net, after } });
        continue;
      }
    }

    const pvp =
      targetPlayer === null || target === null
        ? undefined
        : {
            dc: PVP_DC_BASE + clamp(computeStat(target, { use: 'defense' }) + (targetPlayer.defenseRef?.value ?? 0), -RULES.modCapTotal, RULES.modCapTotal),
            observeModifier:
              proposal.visibility === 'secret' && target.hp > 0
                ? clamp(
                    computeStat(target, { use: 'observe' }) +
                      (target.locationId !== actor.locationId ? REMOTE_AWARENESS : AWARENESS_MOD[byActor.get(target.id)?.awareness ?? 'normal']) +
                      (targetPlayer.perceptionRef?.value ?? 0),
                    -RULES.modCapTotal,
                    RULES.modCapTotal,
                  )
                : null,
          };

    const tags = snapshot.tags?.[actorId];
    const w = snapshot.weather;
    const weather = w ? { ...w.current, outdoor: w.outdoorLocationIds.includes(actor.locationId) } : undefined;
    const repScale = snapshot.state.publicRepScale?.[actor.locationId];
    const result = resolveAction(
      {
        state: { actor, npcs },
        proposal,
        ...(pvp ? { pvp } : {}),
        ...(tags ? { tags } : {}),
        ...(weather ? { weather } : {}),
        ...(repScale !== undefined ? { publicRepScale: repScale } : {}),
      },
      dice,
    );
    if (!result.ok) throw new Error(`action ${proposal.actionId} passed validation but was rejected: ${JSON.stringify(result.errors)}`);
    const { log } = result;
    let nextActor = result.state.actor as PlayerState;
    npcs = { ...result.state.npcs };
    const succeeded = log.degree === 'success' || log.degree === 'crit';

    let targetResult: TargetResult | null = null;
    if (targetPlayer !== null && target !== null) {
      const effects = succeeded ? targetPlayer.onSuccess : targetPlayer.onFail;
      let damage = 0;
      if (effects.damage !== null && target.hp > 0) {
        let d = SEVERITY_BASE[effects.damage] + Math.min(5, Math.floor(Math.max(0, log.check?.margin ?? 0) / 2));
        if (log.degree === 'crit') d = Math.floor(d * 1.5);
        damage = Math.max(0, d - target.damageReduction);
      }
      const heal = effects.heal === null ? 0 : SEVERITY_BASE[effects.heal];
      const hpAfter = clamp(target.hp - damage + heal, 0, target.hpMax ?? RULES.hpMax);
      let targetItems = [...target.items];
      let actorItems = [...nextActor.items];
      const itemsLost: string[] = [];
      const itemsGained: string[] = [];
      const moveItem = (id: string | null, from: OwnedRef[], to: OwnedRef[], record: string[]): [OwnedRef[], OwnedRef[]] => {
        const item = id === null ? undefined : from.find((i) => i.id === id);
        if (item === undefined) return [from, to];
        record.push(item.id);
        return [from.filter((i) => i !== item), [...to, item]];
      };
      [targetItems, actorItems] = moveItem(effects.takeItem, targetItems, actorItems, itemsLost);
      [actorItems, targetItems] = moveItem(effects.giveItem, actorItems, targetItems, itemsGained);
      nextActor = { ...nextActor, items: actorItems };
      players[target.id] = { ...target, hp: hpAfter, items: targetItems };

      const noticed = log.targetObservation?.noticed === true;
      targetResult = {
        playerId: target.id,
        hp: { before: target.hp, damage, heal, after: hpAfter },
        itemsLost,
        itemsGained,
        observation: log.targetObservation,
        knowsActor: proposal.visibility === 'public' || noticed || (log.degree === 'fumble' && target.hp > 0),
      };
    }

    let moved: { from: string; to: string } | null = null;
    if (action.moveTo !== null && succeeded && nextActor.hp > 0 && action.moveTo !== nextActor.locationId) {
      moved = { from: nextActor.locationId, to: action.moveTo };
      nextActor = { ...nextActor, locationId: action.moveTo };
    }
    players[actorId] = nextActor;
    outcomes.push({ status: 'resolved', ...base, log, target: targetResult, moved });
  }

  const log: PhaseActionsLog = { input: snapshot, rolls: dice.faces, order, outcomes };
  return { ok: true, state: { players, npcs }, log };
}

/** Re-runs a logged phase with the recorded dice. Equal to the original result when the log is intact. */
export function replayPhaseActions(log: PhaseActionsLog): PhaseActionsResult {
  return resolvePhaseActions(log.input, new ReplayRng(log.rolls));
}

/** Every problem with the phase's actions, checked against the phase-start snapshot before any die. */
export function validatePhaseActions(input: PhaseActionsInput): CrossPlayerError[] {
  const errors: CrossPlayerError[] = [];
  const { players, npcs } = input.state;
  const seen = new Set<string>();

  input.actions.forEach((action: PhaseAction, i) => {
    const fail = (code: CrossPlayerErrorCode, path: string, message: string) => errors.push({ code, path, message, action: i });
    const actor = players[action.actorId];
    if (actor === undefined) return void fail('unknown_actor', 'actorId', `player ${action.actorId} is not in the game`);
    if (seen.has(actor.id)) fail('duplicate_actor', 'actorId', `${actor.id} has more than one action this phase`);
    seen.add(actor.id);

    for (const e of validateProposal({ actor, npcs }, action.proposal, input.tags?.[actor.id])) errors.push({ ...e, path: `proposal.${e.path}`, action: i });
    if (action.moveTo !== null && (typeof action.moveTo !== 'string' || action.moveTo === '')) fail('invalid_field', 'moveTo', 'moveTo must be a location id or null');
    if (!(action.awareness in AWARENESS_MOD)) fail('invalid_field', 'awareness', 'awareness must be watch, asleep or normal');

    const t = action.targetPlayer;
    if (t === null) {
      if (action.proposal.check?.type === 'pvp') fail('pvp_without_target', 'proposal.check', 'a pvp check needs a player target');
      return;
    }
    if (action.proposal.target !== null) fail('player_target_with_npc_target', 'proposal.target', 'an action targets one player or one NPC, not both');
    if (!(PLAYER_INTENTS as readonly unknown[]).includes(t.intent)) fail('unknown_intent', 'targetPlayer.intent', `intent ${JSON.stringify(t.intent)} is not ${PLAYER_INTENTS.join('/')}`);
    const target = players[t.player];
    if (target === undefined) return void fail('unknown_target', 'targetPlayer.player', `player ${t.player} is not in the game`);
    if (target.id === actor.id) return void fail('target_is_actor', 'targetPlayer.player', 'an action cannot target its own actor');
    if (target.hp <= 0 && !UNCONSCIOUS_OK.has(t.intent)) fail('target_unconscious', 'targetPlayer.player', `${target.id} is unconscious (HP 0); only rescue or steal may target them`);

    const owns = (who: PlayerState, ref: string) => [...who.items, ...who.skills].find((o) => o.id === ref);
    if (t.reachRef !== null) {
      if (owns(actor, t.reachRef) === undefined) fail('ref_not_owned', 'targetPlayer.reachRef', `${actor.id} has no item or skill ${t.reachRef}`);
      else if (!actor.remoteReach.includes(t.reachRef)) fail('reach_not_remote', 'targetPlayer.reachRef', `${t.reachRef} does not have reach: remote`);
    }
    const gear = (path: string, ref: TargetGearRef | null) => {
      if (ref === null) return;
      const owned = owns(target, ref.ref);
      if (owned === undefined) return void fail('ref_not_owned', `${path}.ref`, `${target.id} has no item or skill ${ref.ref}`);
      if (!Number.isInteger(ref.value)) return void fail('not_integer', `${path}.value`, `${path}.value must be a whole number`);
      if (ref.value < RULES.judgedMin) fail('out_of_range', `${path}.value`, `${path}.value is below ${RULES.judgedMin}`);
      if (ref.value > TIER_CAP[owned.tier]) fail('value_over_cap', `${path}.value`, `${owned.tier} ${ref.ref} gives at most +${TIER_CAP[owned.tier]}`);
    };
    gear('targetPlayer.defenseRef', t.defenseRef);
    gear('targetPlayer.perceptionRef', t.perceptionRef);

    const effects = (path: string, e: PlayerEffects) => {
      for (const key of ['damage', 'heal'] as const) {
        if (e[key] !== null && !(SEVERITIES as readonly unknown[]).includes(e[key])) fail('unknown_severity' satisfies ProposalErrorCode, `${path}.${key}`, `severity ${JSON.stringify(e[key])} is not ${SEVERITIES.join('/')}`);
      }
      if (e.takeItem !== null && !target.items.some((o) => o.id === e.takeItem)) fail('ref_not_owned', `${path}.takeItem`, `${target.id} has no item ${e.takeItem}`);
      if (e.giveItem !== null && !actor.items.some((o) => o.id === e.giveItem)) fail('ref_not_owned', `${path}.giveItem`, `${actor.id} has no item ${e.giveItem}`);
    };
    effects('targetPlayer.onSuccess', t.onSuccess);
    effects('targetPlayer.onFail', t.onFail);
  });
  return errors;
}
