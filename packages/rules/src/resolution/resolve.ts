import { rollDice } from '../dice.ts';
import type { Rng } from '../rng.ts';
import {
  GRADE_OBS_MOD,
  NPC_HP_MAX,
  RULES,
  SEVERITY_BASE,
  affinityMod,
  clamp,
  computeStat,
  karmaBand,
  repTier,
} from './tables.ts';
import type {
  ActorState,
  CheckLog,
  Degree,
  Effects,
  LoggedModifier,
  NpcState,
  ResolutionInput,
  ResolutionLog,
  ResolutionProposal,
  ResolutionState,
  ResolveResult,
  StatusEffect,
} from './types.ts';
import { weatherEffects } from '../weather.ts';
import { applyTagging, chargeOnCrit, isQualitativeSource } from './tags.ts';
import { validateProposal } from './validate.ts';

/** Records every die drawn from an inner Rng so the log can replay it. */
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

/** Plays back recorded dice in order; throws when asked for a die that was not recorded or does not fit. */
export class ReplayRng implements Rng {
  readonly #faces: readonly number[];
  #next = 0;

  constructor(faces: readonly number[]) {
    this.#faces = faces;
  }

  nextInt(min: number, max: number): number {
    const face = this.#faces[this.#next];
    if (face === undefined) throw new Error(`Replay needs die #${this.#next + 1} but only ${this.#faces.length} were recorded`);
    if (!Number.isInteger(face) || face < min || face > max) throw new Error(`Recorded die #${this.#next + 1} is ${face}, outside ${min}..${max}`);
    this.#next++;
    return face;
  }
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Resolves one action: validate the whole proposal (all-or-nothing) -> roll d20 on the server ->
 * degree -> apply Stamina, HP, Reputation, Karma, Affinity, statuses -> return the new state and a replayable log.
 * Never mutates the input. On any validation error nothing is rolled and no state is returned.
 */
export function resolveAction(input: ResolutionInput, rng: Rng): ResolveResult {
  const errors = validateProposal(input.state, input.proposal, input.tags);
  if (input.proposal.check?.type === 'pvp' && input.pvp === undefined) {
    errors.push({ code: 'invalid_field', path: 'check', message: 'a pvp check is resolved per phase against a player target (GEN-060)' });
  }
  if (errors.length > 0) return { ok: false, errors };

  const snapshot = copy(input);
  const { state, proposal, pvp, tags } = copy(input);
  const { actor, npcs } = state;
  const dice = new RecordingRng(rng);
  // Tag-matched bonuses (GEN-064): the server's numbers, logged with their source.
  let tagging = proposal.tagging !== undefined && tags !== undefined ? applyTagging(tags, proposal.tagging) : undefined;
  // Q-130: a qualitative tag source the AI judged is logged as judged.
  const judgedSources = new Set((tags?.sources ?? []).filter(isQualitativeSource).map((s) => s.id));
  // Weather rules (GEN-068): the server's numbers, whatever the proposal says.
  const weather =
    input.weather === undefined
      ? undefined
      : weatherEffects(input.weather, { visibility: proposal.visibility, verbTags: proposal.tagging?.verbTags ?? [], actionTags: proposal.tags });

  // Roll.
  let check: CheckLog | null = null;
  let degree: Degree = 'success';
  if (proposal.check.type !== 'none') {
    const modifiers: LoggedModifier[] = [
      ...proposal.modifiers.map((m) => {
        const logged = loggedModifier(actor, proposal, m);
        return logged.ref !== undefined && (m.source === 'item' || m.source === 'skill') && judgedSources.has(logged.ref) ? { ...logged, judged: true as const } : logged;
      }),
      ...(tagging?.bonuses ?? []).map((b) => ({ source: b.kind, ref: b.ref, value: b.value })),
      ...(weather?.modifiers ?? []).map((m) => ({ source: 'weather' as const, ref: m.ref, value: m.value })),
    ];
    const modifierSum = modifiers.reduce((sum, m) => sum + m.value, 0);
    const modifierTotal = clamp(modifierSum, -RULES.modCapTotal, RULES.modCapTotal);
    const roll = rollDice('1d20', dice);
    const d20 = roll.faces[0]!;
    const total = d20 + modifierTotal;
    // Q-131: penalties put on a player target lower their defence, so DC_pvp.
    const targetPenalty = (tagging?.targetBonuses ?? []).reduce((sum, b) => sum + b.value, 0);
    const dc = proposal.check.type === 'pvp' ? pvp!.dc + targetPenalty : proposal.check.dc;
    check = { dc, d20, modifiers, modifierSum, modifierTotal, total, margin: total - dc };
    degree = roll.crit ? 'crit' : roll.fumble ? 'fumble' : total >= dc ? 'success' : 'fail';
  }

  // Secret: caught on a fumble, or when the target player (GEN-060) or the highest-grade witness
  // out-rolls the total (tie = unseen). A target who notices interrupts the action: success -> fail.
  let caught = false;
  let interrupted = false;
  let observation: ResolutionLog['observation'] = null;
  let targetObservation: ResolutionLog['targetObservation'] = null;
  if (proposal.visibility === 'secret' && check !== null && degree !== 'fumble' && pvp?.observeModifier != null) {
    const d20 = rollDice('1d20', dice).faces[0]!;
    const total = d20 + pvp.observeModifier;
    targetObservation = { d20, modifier: pvp.observeModifier, total, noticed: total > check.total };
    if (targetObservation.noticed) {
      caught = true;
      if (degree === 'success' || degree === 'crit') {
        degree = 'fail';
        interrupted = true;
      }
    }
  }
  if (proposal.visibility === 'secret' && check !== null && !caught) {
    if (degree === 'fumble') caught = true;
    else {
      const witness = highestGrade(proposal.witnessNpcIds.map((id) => npcs[id]!));
      if (witness !== undefined) {
        const d20 = rollDice('1d20', dice).faces[0]!;
        observation = { npcId: witness.id, d20, total: d20 + GRADE_OBS_MOD[witness.grade] + witness.obsTrait };
        caught = observation.total > check.total;
      }
    }
  }

  const succeeded = degree === 'success' || degree === 'crit';
  const effects: Effects = succeeded ? proposal.onSuccess : proposal.onFail;

  // Stamina (spec §3): crit half rounded up, fumble +2, refund after, net >= 1, floor 0.
  let cost = proposal.staminaCost;
  if (degree === 'crit') {
    cost = Math.ceil(cost / 2);
    if (tagging !== undefined) tagging = chargeOnCrit(tagging);
  }
  if (degree === 'fumble') cost += 2;
  const net = cost > 0 ? Math.max(RULES.minNetCost, cost - actor.afterActionStamina) : 0;
  const staminaAfter = clamp(actor.stamina - net - (tagging?.skillStamina ?? 0) - (weather?.stamina ?? 0), 0, RULES.staminaMax);

  // Reputation only for Public, or Secret that was caught. Karma always.
  const repDelta = proposal.visibility === 'public' ? effects.repDelta : caught ? proposal.repDeltaIfCaught : 0;
  const rep = change(actor.rep, repDelta);
  const karma = change(actor.karma, effects.karmaDelta);

  // Affinity: crit +2 on positive deltas, fumble -2 on all, capped +/-10 per action, then -100..100.
  const affinity = effects.affinity.map(({ npcId, delta }) => {
    let d = delta;
    if (degree === 'crit' && d > 0) d += 2;
    if (degree === 'fumble') d -= 2;
    d = clamp(d, -RULES.affinityPerAction, RULES.affinityPerAction);
    return { npcId, ...change(actor.affinity[npcId] ?? 0, d) };
  });

  // HP: damage to the NPC target, self-damage to the actor, heal the target (or the actor without one).
  const targetNpc = proposal.target === null ? null : npcs[proposal.target.npc]!;
  const margin = check?.margin ?? 0;
  let targetDamage = 0;
  if (effects.damage !== null && targetNpc !== null && targetNpc.hp > 0) {
    let d = SEVERITY_BASE[effects.damage] + Math.min(5, Math.floor(Math.max(0, margin) / 2));
    if (degree === 'crit') d = Math.floor(d * 1.5);
    targetDamage = Math.max(0, d - targetNpc.damageReduction);
  }
  let selfDamage = 0;
  if (effects.selfDamage !== null) {
    let d = SEVERITY_BASE[effects.selfDamage];
    if (degree === 'fumble') d = Math.floor(d * 1.5);
    selfDamage = Math.max(0, d - actor.damageReduction);
  }
  const heal = effects.heal === null ? 0 : SEVERITY_BASE[effects.heal];
  const actorHp = hpChange(actor.hp, selfDamage, targetNpc === null ? heal : 0, RULES.hpMax);
  const targetHp =
    targetNpc === null ? null : { npcId: targetNpc.id, ...hpChange(targetNpc.hp, targetDamage, heal, NPC_HP_MAX[targetNpc.grade]) };

  // Event statuses (Q-052): remove, then add; beyond 4 active the oldest event status drops.
  const statusesAdded: StatusEffect[] = effects.addStatus.map((s, i) => ({
    id: `${proposal.actionId}:status:${i}`,
    label: s.label,
    polarity: s.polarity,
    origin: 'event',
    visible: s.visible,
    mods: s.mods,
    phasesLeft: s.phases,
  }));
  let statuses = [...actor.statuses.filter((s) => !effects.removeStatus.includes(s.id)), ...statusesAdded];
  let events = statuses.filter((s) => s.origin === 'event').length;
  statuses = statuses.filter((s) => !(s.origin === 'event' && events-- > RULES.eventStatusMaxActive));

  const nextAffinity = { ...actor.affinity };
  for (const a of affinity) nextAffinity[a.npcId] = a.after;
  const nextActor: ActorState = {
    ...actor,
    stamina: staminaAfter,
    hp: actorHp.after,
    rep: rep.after,
    karma: karma.after,
    affinity: nextAffinity,
    statuses,
  };
  const nextNpcs: Record<string, NpcState> = { ...npcs };
  if (targetNpc !== null && targetHp !== null) nextNpcs[targetNpc.id] = { ...targetNpc, hp: targetHp.after };
  const nextState: ResolutionState = { actor: nextActor, npcs: nextNpcs };

  const log: ResolutionLog = {
    input: snapshot,
    rolls: dice.faces,
    check,
    degree,
    caught,
    observation,
    targetObservation,
    interrupted,
    stamina: { before: actor.stamina, cost, net, after: staminaAfter },
    ...(tagging !== undefined ? { tagging } : {}),
    ...(weather !== undefined ? { weather } : {}),
    rep,
    karma,
    affinity,
    hp: { actor: actorHp, target: targetHp },
    statusesAdded,
    statusesRemoved: [...effects.removeStatus],
    actorCondition: actorHp.after === 0 ? 'unconscious' : 'ok',
  };
  return { ok: true, state: nextState, log };
}

/** Re-runs a logged resolution with the recorded dice. Equal to the original result when the log is intact. */
export function replayResolution(log: ResolutionLog): ResolveResult {
  return resolveAction(log.input, new ReplayRng(log.rolls));
}

function loggedModifier(actor: ActorState, proposal: ResolutionProposal, m: ResolutionProposal['modifiers'][number]): LoggedModifier {
  switch (m.source) {
    case 'item':
    case 'skill':
      return { source: m.source, ref: m.ref, value: m.value };
    case 'stat':
      return { source: 'stat', value: computeStat(actor, proposal) };
    case 'rep': {
      const tierMod = repTier(actor.rep).mod;
      return { source: 'rep', mode: m.mode, value: m.mode === 'favor' ? tierMod : Math.max(0, -tierMod) };
    }
    case 'karma': {
      const band = karmaBand(actor.karma);
      return { source: 'karma', align: m.align, value: m.align === 'light' ? band : -band + 0 };
    }
    case 'affinity':
      return { source: 'affinity', ref: m.ref, value: affinityMod(actor.affinity[m.ref] ?? 0) };
  }
}

const GRADE_ORDER = ['F', 'B', 'A', 'S', 'SS'] as const;

function highestGrade(witnesses: readonly NpcState[]): NpcState | undefined {
  let best: NpcState | undefined;
  for (const npc of witnesses) {
    if (best === undefined || GRADE_ORDER.indexOf(npc.grade) > GRADE_ORDER.indexOf(best.grade)) best = npc;
  }
  return best;
}

function change(before: number, delta: number) {
  return { before, delta, after: clamp(before + delta, RULES.rangeMin, RULES.rangeMax) };
}

function hpChange(before: number, damage: number, heal: number, max: number) {
  return { before, damage, heal, after: clamp(before - damage + heal, 0, max) };
}
