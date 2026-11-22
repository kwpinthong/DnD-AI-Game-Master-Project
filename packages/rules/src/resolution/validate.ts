import { RULES, TIER_CAP, staminaCostRange } from './tables.ts';
import { validateTagging, type TagContext } from './tags.ts';
import {
  ACTION_KINDS,
  ACTION_TAGS,
  DC_LADDER,
  SEVERITIES,
  STATUS_SCOPES,
  type Effects,
  type ProposalError,
  type ProposalErrorCode,
  type ResolutionProposal,
  type ResolutionState,
  type StatusMod,
} from './types.ts';

const DERIVED = ['stat', 'rep', 'karma', 'affinity'] as const;
const JUDGED = ['item', 'skill'] as const;

/**
 * Checks a proposal against the state before any die is rolled (spec §1.6, §13).
 * Returns every error found; an empty list means the whole proposal may be applied (all-or-nothing, Q-049).
 */
export function validateProposal(state: ResolutionState, proposal: ResolutionProposal, tags?: TagContext): ProposalError[] {
  const errors: ProposalError[] = [];
  const fail = (code: ProposalErrorCode, path: string, message: string) => errors.push({ code, path, message });
  const int = (path: string, value: unknown, min: number, max: number): boolean => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      fail('not_integer', path, `${path} must be a whole number, got ${JSON.stringify(value)}`);
      return false;
    }
    if (value < min || value > max) {
      fail('out_of_range', path, `${path} is ${value}; allowed ${min}..${max}`);
      return false;
    }
    return true;
  };

  const { actor, npcs } = state;
  const present = (npcId: string) => npcs[npcId]?.locationId === actor.locationId;
  const p = proposal as ResolutionProposal & Record<string, unknown>;

  if (actor.hp <= 0) fail('actor_unconscious', 'actor', 'An unconscious character (HP 0) cannot act');
  if (typeof p.actionId !== 'string' || p.actionId === '') fail('invalid_field', 'actionId', 'actionId must be a non-empty string');
  if (typeof p.reason !== 'string' || p.reason.length < 1 || p.reason.length > 200) fail('invalid_field', 'reason', 'reason must be 1..200 characters');
  if (p.visibility !== 'public' && p.visibility !== 'secret') fail('invalid_field', 'visibility', 'visibility must be public or secret');
  if (typeof p.opposed !== 'boolean') fail('invalid_field', 'opposed', 'opposed must be true or false');

  // Kind and Stamina class (spec §3).
  if (!(ACTION_KINDS as readonly unknown[]).includes(p.kind)) {
    fail('unknown_kind', 'kind', `kind ${JSON.stringify(p.kind)} is not general, complex or exertion`);
  } else if (int('staminaCost', p.staminaCost, 0, RULES.staminaMax)) {
    const [min, max] = staminaCostRange(p.kind, p.opposed === true);
    if (p.staminaCost < min || p.staminaCost > max) {
      fail('stamina_cost_mismatch', 'staminaCost', `${p.kind}${p.opposed ? ' + opposed' : ''} costs ${min === max ? min : `${min}..${max}`}, got ${p.staminaCost}`);
    }
  }

  if (!Array.isArray(p.tags)) fail('invalid_field', 'tags', 'tags must be a list');
  else {
    if (p.tags.length > RULES.maxTags) fail('too_many', 'tags', `at most ${RULES.maxTags} tags`);
    p.tags.forEach((tag, i) => {
      if (!(ACTION_TAGS as readonly unknown[]).includes(tag)) fail('unknown_tag', `tags[${i}]`, `tag ${JSON.stringify(tag)} is not an action tag`);
    });
  }

  // Check (spec §2.1).
  const check = p.check as { type?: unknown; dc?: unknown } | null | undefined;
  if (check?.type === 'dc') {
    if (!(DC_LADDER as readonly unknown[]).includes(check.dc)) fail('dc_not_on_ladder', 'check.dc', `DC ${JSON.stringify(check.dc)} is not on the ladder ${DC_LADDER.join('/')}`);
  } else if (check?.type !== 'none' && check?.type !== 'pvp') {
    fail('unknown_check', 'check', 'check must be { type: "dc", dc }, { type: "pvp" } or { type: "none" }');
  }

  // Target.
  if (p.target !== null) {
    const npcId = (p.target as { npc?: unknown } | undefined)?.npc;
    if (typeof npcId !== 'string') fail('invalid_field', 'target', 'target must be { npc } or null (PvP is resolved per phase)');
    else if (npcs[npcId] === undefined) fail('unknown_npc', 'target.npc', `NPC ${npcId} does not exist`);
    else if (!present(npcId)) fail('npc_not_present', 'target.npc', `NPC ${npcId} is not at ${actor.locationId}`);
  }
  const targetNpc = typeof p.target?.npc === 'string' ? p.target.npc : null;

  // Modifiers: six sources only, each with what it needs (spec §1.3-1.4, §2.2).
  if (!Array.isArray(p.modifiers)) fail('invalid_field', 'modifiers', 'modifiers must be a list');
  else {
    if (p.modifiers.length > RULES.maxModifiers) fail('too_many', 'modifiers', `at most ${RULES.maxModifiers} modifiers`);
    const counts = new Map<string, number>();
    const refsUsed = new Set<string>();
    const gearRefs = new Set(actor.statuses.filter((s) => s.origin === 'gear' && s.ref !== undefined).map((s) => s.ref));
    p.modifiers.forEach((raw, i) => {
      const path = `modifiers[${i}]`;
      const mod = raw as unknown as Record<string, unknown>;
      const source = mod.source;
      if (source === undefined) return void fail('missing_source', path, 'every modifier needs a source');
      if (typeof source !== 'string' || ![...DERIVED, ...JUDGED].includes(source as never)) {
        return void fail('unknown_source', `${path}.source`, `source ${JSON.stringify(source)} is not one of ${[...DERIVED, ...JUDGED].join(', ')}`);
      }
      counts.set(source, (counts.get(source) ?? 0) + 1);

      if ((DERIVED as readonly string[]).includes(source)) {
        if ('value' in mod) fail('derived_value_given', `${path}.value`, `the server computes ${source}; the proposal may not give a value`);
        if (source === 'rep' && mod.mode !== 'favor' && mod.mode !== 'fear') fail('invalid_field', `${path}.mode`, 'rep needs mode favor or fear');
        if (source === 'karma' && mod.align !== 'light' && mod.align !== 'dark') fail('invalid_field', `${path}.align`, 'karma needs align light or dark');
        if (source === 'affinity') {
          if (typeof mod.ref !== 'string') fail('missing_ref', `${path}.ref`, 'affinity needs the NPC id as ref');
          else if (npcs[mod.ref] === undefined) fail('unknown_npc', `${path}.ref`, `NPC ${mod.ref} does not exist`);
        }
        return;
      }

      // Judged: item / skill.
      if (typeof mod.ref !== 'string' || mod.ref === '') return void fail('missing_ref', `${path}.ref`, `${source} needs the id of the ${source} as ref`);
      const owned = (source === 'item' ? actor.items : actor.skills).find((o) => o.id === mod.ref);
      if (owned === undefined) return void fail('ref_not_owned', `${path}.ref`, `${actor.id} has no ${source} ${mod.ref}`);
      if (refsUsed.has(mod.ref)) fail('duplicate', `${path}.ref`, `${mod.ref} is claimed twice`);
      refsUsed.add(mod.ref);
      if (gearRefs.has(mod.ref)) fail('gear_claimed_twice', `${path}.ref`, `${mod.ref} already gives a gear effect inside stat`);
      if (int(`${path}.value`, mod.value, RULES.judgedMin, Number.MAX_SAFE_INTEGER) && (mod.value as number) > TIER_CAP[owned.tier]) {
        fail('value_over_cap', `${path}.value`, `${owned.tier} ${source} ${mod.ref} gives at most +${TIER_CAP[owned.tier]}, got +${String(mod.value)}`);
      }
    });
    const limits: Record<string, number> = { item: RULES.maxItems, skill: RULES.maxSkills, stat: 1, rep: 1, karma: 1, affinity: 1 };
    for (const [source, count] of counts) {
      if (count > (limits[source] ?? 0)) fail('too_many', 'modifiers', `at most ${limits[source]} ${source} modifier(s), got ${count}`);
    }
  }

  // Secret witnesses.
  if (!Array.isArray(p.witnessNpcIds)) fail('invalid_field', 'witnessNpcIds', 'witnessNpcIds must be a list');
  else {
    if (p.witnessNpcIds.length > RULES.maxWitnesses) fail('too_many', 'witnessNpcIds', `at most ${RULES.maxWitnesses} witnesses`);
    p.witnessNpcIds.forEach((id, i) => {
      if (npcs[id] === undefined) fail('unknown_npc', `witnessNpcIds[${i}]`, `NPC ${id} does not exist`);
      else if (!present(id)) fail('npc_not_present', `witnessNpcIds[${i}]`, `witness ${id} is not at ${actor.locationId}`);
    });
  }
  int('repDeltaIfCaught', p.repDeltaIfCaught, RULES.repDeltaIfCaughtMin, 0);

  validateEffects('onSuccess', p.onSuccess);
  validateEffects('onFail', p.onFail);

  // Tag matching (GEN-064).
  const judgedRefs = (Array.isArray(p.modifiers) ? p.modifiers : []).flatMap((m, i) => {
    const mod = m as unknown as Record<string, unknown>;
    return (mod.source === 'item' || mod.source === 'skill') && typeof mod.ref === 'string' ? [{ ref: mod.ref, path: `modifiers[${i}].ref` }] : [];
  });
  errors.push(...validateTagging(tags, p.tagging, judgedRefs));
  return errors;

  function validateEffects(path: string, effects: Effects | undefined) {
    if (effects === null || typeof effects !== 'object') return void fail('invalid_field', path, `${path} is required`);
    int(`${path}.repDelta`, effects.repDelta, -RULES.deltaCap, RULES.deltaCap);
    int(`${path}.karmaDelta`, effects.karmaDelta, -RULES.deltaCap, RULES.deltaCap);

    for (const key of ['damage', 'selfDamage', 'heal'] as const) {
      const sev = effects[key];
      if (sev !== null && !(SEVERITIES as readonly unknown[]).includes(sev)) fail('unknown_severity', `${path}.${key}`, `severity ${JSON.stringify(sev)} is not ${SEVERITIES.join('/')}`);
    }
    if (effects.damage !== null && targetNpc === null) fail('invalid_field', `${path}.damage`, 'damage needs an NPC target');

    if (!Array.isArray(effects.affinity)) fail('invalid_field', `${path}.affinity`, 'affinity must be a list');
    else {
      if (effects.affinity.length > RULES.maxAffinityEntries) fail('too_many', `${path}.affinity`, `at most ${RULES.maxAffinityEntries} NPCs per action`);
      const seen = new Set<string>();
      effects.affinity.forEach(({ npcId, delta }, i) => {
        const at = `${path}.affinity[${i}]`;
        if (npcs[npcId] === undefined) fail('unknown_npc', `${at}.npcId`, `NPC ${npcId} does not exist`);
        else if (!present(npcId) && npcId !== targetNpc) fail('npc_not_present', `${at}.npcId`, `NPC ${npcId} is not in the scene`);
        if (seen.has(npcId)) fail('duplicate', `${at}.npcId`, `NPC ${npcId} is listed twice`);
        seen.add(npcId);
        int(`${at}.delta`, delta, -RULES.affinityPerAction, RULES.affinityPerAction);
      });
    }

    if (!Array.isArray(effects.addStatus)) fail('invalid_field', `${path}.addStatus`, 'addStatus must be a list');
    else {
      if (effects.addStatus.length > RULES.eventStatusPerAction) fail('too_many', `${path}.addStatus`, `at most ${RULES.eventStatusPerAction} statuses per action`);
      effects.addStatus.forEach((status, i) => {
        const at = `${path}.addStatus[${i}]`;
        if (typeof status.label !== 'string' || status.label.length < 1 || status.label.length > RULES.statusLabelMax) {
          fail('invalid_field', `${at}.label`, `label must be 1..${RULES.statusLabelMax} characters`);
        }
        if (status.polarity !== 'buff' && status.polarity !== 'debuff') fail('invalid_field', `${at}.polarity`, 'polarity must be buff or debuff');
        if (typeof status.visible !== 'boolean') fail('invalid_field', `${at}.visible`, 'visible must be true or false');
        int(`${at}.phases`, status.phases, 1, RULES.eventStatusPhases);
        if (!Array.isArray(status.mods) || status.mods.length < 1 || status.mods.length > RULES.maxStatusMods) {
          return void fail('invalid_field', `${at}.mods`, `mods must have 1..${RULES.maxStatusMods} entries`);
        }
        (status.mods as readonly StatusMod[]).forEach((mod, j) => {
          if (!(STATUS_SCOPES as readonly unknown[]).includes(mod.scope)) {
            fail('unknown_scope', `${at}.mods[${j}].scope`, `scope ${JSON.stringify(mod.scope)} is not allowed (no crit/fumble range, Q-053)`);
          }
          int(`${at}.mods[${j}].value`, mod.value, -RULES.eventStatusCap, RULES.eventStatusCap);
        });
      });
    }

    if (!Array.isArray(effects.removeStatus)) fail('invalid_field', `${path}.removeStatus`, 'removeStatus must be a list');
    else {
      if (effects.removeStatus.length > RULES.removeStatusPerAction) fail('too_many', `${path}.removeStatus`, `at most ${RULES.removeStatusPerAction} per action`);
      effects.removeStatus.forEach((id, i) => {
        if (!actor.statuses.some((s) => s.id === id && s.origin === 'event')) fail('unknown_status', `${path}.removeStatus[${i}]`, `${actor.id} has no event status ${id}`);
      });
    }
  }
}
