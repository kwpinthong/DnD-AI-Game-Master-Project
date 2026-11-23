import type { OtherCharacterView } from '@isekai/protocol';
import {
  DROWSY_STATUS,
  NPC_HP_MAX,
  RANK_TIER,
  resolvePhaseActions,
  validatePhaseActions,
  type ActionOutcome,
  type CrossPlayerError,
  type CrossPlayerState,
  type Degree,
  type NoTargetReason,
  type NpcState,
  type OwnedRef,
  type PhaseAction,
  type PhaseActionsLog,
  type PhaseState,
  type PlayerState,
  type Rng,
  type StatusEffect,
} from '@isekai/rules';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { character, characterPresence, member } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { ASTRAL_PLANE, moveCharacter, namesVisibleTo, npcBondsOf, presencesInGame } from '../visibility/store.ts';
import { otherCharacterView, witnessesOf } from '../visibility/views.ts';
import { isLegacyOption, type StoredOption } from '../game/loot.ts';
import type { GameAssets } from '../assets/load.ts';
import { chosenLootInGame, itemsInGame, skillsInGame, transferItem } from './items.ts';
import { outdoorLocationIds, recordTagUses, tagContexts, type TaggingOptions } from './tags.ts';
import { originEffects, treatChronicIllness } from '../game/origin.ts';
import { TREATMENT_VERBS } from '../game/start-rules.ts';
import { publicRepScaleOf, startStaminaCut } from '../game/location-actions.ts';
import { activeCurses, recordCurses } from '../statuses/curses.ts';
import { changeNpcAffinity } from '../companions/store.ts';

/** Who a successful HEAL / CLEANSE action treated: its player target, else the actor (self-treatment). */
export function patientsTreated(outcomes: readonly ActionOutcome[]): string[] {
  return outcomes.flatMap((o) => {
    if (o.status !== 'resolved' || (o.log.degree !== 'success' && o.log.degree !== 'crit')) return [];
    if (!(o.log.tagging?.verbTags ?? []).some((v) => TREATMENT_VERBS.includes(v))) return [];
    return [o.target?.playerId ?? o.actorId];
  });
}

/**
 * Cross-player phase actions on the server (GEN-060, Rules Spec §10). The AI GM phase loop (GEN-057)
 * calls, once every action of a phase has its proposal:
 * 1. `applyPhaseActions(db, gameId, actions, new CryptoRng(), now)`: reads the game, orders and
 *    resolves the actions with `resolvePhaseActions` (@isekai/rules) and writes HP, Stamina,
 *    Reputation, Karma, places and item holders in one transaction. Any invalid action → nothing is
 *    rolled or written (Q-049: all-or-nothing; the caller asks the AI to repair once). Keep `log`
 *    with the phase: it holds every die and replays with `replayPhaseActions`.
 *    Pass `tagging` (GEN-064, `./tags.ts`) to match verb / target tags against the players' skills,
 *    items, place, weather and start passives; Active uses are counted per game day in the same transaction.
 * 2. `noticesFor(db, gameId, viewer, events)`: what one player may know of those events, for their
 *    narration and the socket (GEN-056). Other players appear as `OtherCharacterView` (appearance;
 *    the real name only once the viewer knows it), never by member id, so AI prompts stay free of names (Q-045).
 *
 * NPC Affinity from the actions is stored with `tagging` (GEN-182, `changeNpcAffinity`). Not stored here yet: event
 * statuses, NPC HP (NPCs start each call at their grade's max). Players identify targets by member id.
 */

export interface PhaseEventRecord {
  outcome: ActionOutcome;
  /** Members who learn something of this action (GEN-050 `witnessesOf` + the affected target). */
  witnesses: string[];
}

export type ServerErrorCode = CrossPlayerError['code'] | 'unknown_location';
export type PhaseApplyError = Omit<CrossPlayerError, 'code'> & { code: ServerErrorCode };

export type ApplyPhaseResult =
  | { ok: true; log: PhaseActionsLog; events: PhaseEventRecord[] }
  | { ok: false; errors: PhaseApplyError[] };

export interface ItemView {
  id: string;
  name: string;
}

/** What one player learns of one action. */
export type CrossPlayerNotice =
  | {
      kind: 'own_action';
      actionId: string;
      status: 'resolved';
      degree: Degree;
      /** The target noticed a Secret and stopped it. */
      interrupted: boolean;
      moved: { from: string; to: string } | null;
      target: OtherCharacterView | null;
      itemsTaken: ItemView[];
      itemsGiven: ItemView[];
    }
  | { kind: 'own_action'; actionId: string; status: 'no_target'; reason: NoTargetReason }
  | { kind: 'own_action'; actionId: string; status: 'skipped' }
  | {
      kind: 'affected';
      actionId: string;
      /** Who did it, as the target sees them; null = the target does not know (an unnoticed Secret). */
      by: OtherCharacterView | null;
      /** The target noticed a Secret action. */
      noticed: boolean;
      hp: { damage: number; heal: number; after: number };
      itemsLost: ItemView[];
      itemsGained: ItemView[];
    }
  | {
      kind: 'witnessed';
      actionId: string;
      actor: OtherCharacterView;
      target: OtherCharacterView | null;
      moved: { from: string; to: string } | null;
    };

type CharacterRow = typeof character.$inferSelect;

/** Characters of the game's active, placed members in seat (join) order; an Astral Spirit is out of the world (GEN-070). */
function seatedCharacters(db: DbOrTx, gameId: string) {
  return db
    .select({ character, locationId: characterPresence.locationId })
    .from(character)
    .innerJoin(member, eq(member.id, character.memberId))
    .innerJoin(characterPresence, eq(characterPresence.memberId, character.memberId))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt), ne(characterPresence.locationId, ASTRAL_PLANE)))
    .orderBy(asc(member.createdAt), sql`member.rowid`)
    .all();
}

/** GEN-175: the karma of every seated player (the players `crossPlayerState` has), for where the schedule puts NPCs. */
export const seatedKarmas = (db: DbOrTx, gameId: string): number[] => seatedCharacters(db, gameId).map((r) => r.character.karma);

/**
 * The game as the cross-player rules read it. Loot maps onto the state as GEN-048 describes: traits →
 * permanent statuses, held items and the chosen skill → OwnedRef plus their Quantitative effect.
 * No loot carries `reach: remote` yet (GEN-055), so `remoteReach` is empty.
 */
export function crossPlayerState(
  db: DbOrTx,
  gameId: string,
  drowsy: ReadonlySet<string> = new Set(),
  assets?: GameAssets,
  /** GEN-070: who is in a forced REST or at the clinic this turn (`crisesOf` of the engine state). */
  crises: ReadonlyMap<string, NonNullable<PlayerState['crisis']>> = new Map(),
  /** GEN-175: where each NPC is now (`npcPlacesNow`: schedule + linger); an NPC not in it is at its scenario place. */
  npcPlaces: ReadonlyMap<string, string> = new Map(),
): CrossPlayerState {
  const loot = new Map(chosenLootInGame(db, gameId).map((l) => [l.memberId, l.chosen]));
  const items = [...itemsInGame(db, gameId).values()];
  const skills = skillsInGame(db, gameId);
  // GEN-055: a sheet row is capped by its Rank (B +2, A +3, S / SS +5); an old GEN-048 option and a row the
  // data does not know stay Common.
  const rankOf = (o: StoredOption) => {
    if (isLegacyOption(o)) return undefined;
    const record = o.kind === 'skill' ? assets?.ability(o.name) : assets?.item(o.name);
    return record?.rank ?? o.rank ?? undefined;
  };
  const tierOf = (o: StoredOption): OwnedRef['tier'] => {
    const rank = rankOf(o);
    return rank === undefined || rank === 'F' ? 'Common' : RANK_TIER[rank];
  };
  const players: Record<string, PlayerState> = {};
  const curses = activeCurses(db, gameId);

  seatedCharacters(db, gameId).forEach(({ character: c, locationId }, seat) => {
    const chosen = loot.get(c.memberId) ?? null;
    const statuses: StatusEffect[] = [];
    let damageReduction = 0;
    let afterActionStamina = 0;
    // Only an old GEN-048 Common option has its own effect; sheet rows give their numbers through tag matching.
    const apply = (option: StoredOption) => {
      const e = isLegacyOption(option) ? option.effect : null;
      if (e?.type === 'check_bonus') {
        statuses.push({ id: `gear:${option.id}`, label: option.name, polarity: 'buff', origin: 'gear', visible: false, mods: [{ scope: e.scope, value: e.value }], phasesLeft: null, ref: option.id });
      } else if (e?.type === 'damage_reduction') damageReduction += e.value;
      else if (e?.type === 'stamina_refund') afterActionStamina += e.value;
    };
    if (chosen) {
      for (const [i, t] of [chosen.strength, chosen.weakness].entries()) {
        statuses.push({ id: `trait:${i}`, label: t.label, polarity: t.value > 0 ? 'buff' : 'debuff', origin: 'trait', visible: true, mods: [{ scope: t.scope, value: t.value }], phasesLeft: null });
      }
      apply(chosen.skill);
    }
    const held = items.filter((i) => i.holderMemberId === c.memberId);
    held.forEach(apply);
    const owned = (o: StoredOption): OwnedRef => ({ id: o.id, tier: tierOf(o) });

    // The start scenario's lasting debuff (the chronic illness, GEN-065) with the sheet's penalty (Q-208), and a cheaper action where a start passive holds (Q-209).
    const origin = originEffects(db, c.memberId, assets);
    statuses.push(...origin.statuses);
    afterActionStamina += origin.afterActionStamina;
    if (assets) afterActionStamina += startStaminaCut(db, assets, c.memberId, locationId, gameId);
    // Timed curses on the player this turn (GEN-095, Venom of Despair).
    statuses.push(...(curses.players.get(c.memberId) ?? []));

    players[c.memberId] = {
      id: c.memberId,
      seat,
      locationId,
      hp: c.hp,
      // Q-210: the engine caps HP at the character's own Max HP (the start scenario's).
      hpMax: c.hpMax,
      stamina: c.stamina,
      rep: c.reputation,
      karma: c.karma,
      affinity: Object.fromEntries(npcBondsOf(db, c.memberId).map((b) => [b.npcId, b.affinity])),
      items: held.map(owned),
      skills: (skills.get(c.memberId) ?? []).map(owned),
      statuses: drowsy.has(c.memberId) ? [...statuses, DROWSY_STATUS] : statuses,
      afterActionStamina,
      damageReduction,
      remoteReach: [],
      ...(crises.has(c.memberId) ? { crisis: crises.get(c.memberId)! } : {}),
    };
  });

  const npcs: Record<string, NpcState> = {};
  for (const n of getGameScenario(db, gameId)?.npcs ?? []) {
    const statuses = curses.npcs.get(n.id);
    npcs[n.id] = { id: n.id, grade: n.rank, hp: NPC_HP_MAX[n.rank], locationId: npcPlaces.get(n.id) ?? n.locationId, obsTrait: 0, damageReduction: 0, ...(statuses ? { statuses } : {}) };
  }
  // GEN-069: a Public action at the fountain moves Reputation ×1.5.
  const publicRepScale = assets ? publicRepScaleOf(db, gameId, assets) : {};
  return { players, npcs, ...(Object.keys(publicRepScale).length > 0 ? { publicRepScale } : {}) };
}

/**
 * GEN-070: the players the cross-player rules treat apart this turn: a forced REST after Stamina 0 (hits ×1.3)
 * or recovering at the clinic (out of reach). An Astral Spirit is at `ASTRAL_PLANE`, so not in the state at all.
 */
export function crisesOf(state: PhaseState): Map<string, NonNullable<PlayerState['crisis']>> {
  const out = new Map<string, NonNullable<PlayerState['crisis']>>();
  for (const id of state.order) {
    const condition = state.players[id]!.condition;
    if (condition === 'exhausted' || condition === 'recovering') out.set(id, condition);
  }
  return out;
}

/** Who learns something of an action: everyone `witnessesOf` gives, plus a target it changed or who knows who did it. */
function witnessesOfOutcome(outcome: ActionOutcome): string[] {
  if (outcome.status === 'skipped') return [outcome.actorId];
  const seen = new Set(
    witnessesOf(
      { locationId: outcome.locationId, actorMemberId: outcome.actorId, visibility: outcome.visibility },
      new Map(Object.entries(outcome.locations)),
    ),
  );
  if (outcome.status === 'resolved' && outcome.target !== null) {
    const t = outcome.target;
    if (t.knowsActor || t.executed || t.hp.damage > 0 || t.hp.heal > 0 || t.itemsLost.length > 0 || t.itemsGained.length > 0) seen.add(t.playerId);
  }
  return [...seen];
}

/** Resolves and writes one phase's actions (see the module comment). */
export function applyPhaseActions(
  db: DbOrTx,
  gameId: string,
  actions: readonly PhaseAction[],
  rng: Rng,
  now: number,
  tagging?: TaggingOptions,
  /** Members who are Drowsy today (GEN-063): they roll with `DROWSY_STATUS`. */
  drowsy: ReadonlySet<string> = new Set(),
  /** GEN-070: `crisesOf` the engine state at the turn's close. */
  crises: ReadonlyMap<string, NonNullable<PlayerState['crisis']>> = new Map(),
  /** GEN-175: the turn's `npcPlacesNow`, the same the proposal was checked with. */
  npcPlaces: ReadonlyMap<string, string> = new Map(),
): ApplyPhaseResult {
  return db.transaction((tx) => {
    const state = crossPlayerState(tx, gameId, drowsy, tagging?.assets, crises, npcPlaces);
    const tags = tagging === undefined ? undefined : tagContexts(tx, gameId, state, tagging);
    const current = tagging?.periodWeather;
    const weather = current ? { current, outdoorLocationIds: outdoorLocationIds(tx, gameId, tagging.assets) } : undefined;
    const places = new Set((getGameScenario(tx, gameId)?.locations ?? []).map((l) => l.id));
    const errors: PhaseApplyError[] = [
      ...actions.flatMap((a, i) =>
        a.moveTo !== null && !places.has(a.moveTo)
          ? [{ code: 'unknown_location' as const, path: 'moveTo', action: i, message: `the scenario has no place ${a.moveTo}` }]
          : [],
      ),
      ...validatePhaseActions({ state, actions, ...(tags ? { tags } : {}) }),
    ];
    if (errors.length > 0) return { ok: false, errors };

    const result = resolvePhaseActions({ state, actions, ...(tags ? { tags } : {}), ...(weather ? { weather } : {}) }, rng);
    if (!result.ok) return { ok: false, errors: [...result.errors] };
    if (tagging !== undefined) recordTagUses(tx, gameId, result.log, tagging.day, now);
    // A successful HEAL / CLEANSE on a chronically ill player counts as one treatment (GEN-065).
    for (const memberId of patientsTreated(result.log.outcomes)) treatChronicIllness(tx, memberId);
    // A successful curse (Venom of Despair) puts its timed status on the target from the next turn (GEN-095).
    if (tagging !== undefined) recordCurses(tx, gameId, result.log, tagging.assets, now);

    for (const after of Object.values(result.state.players)) {
      const before = state.players[after.id]!;
      if (after.hp !== before.hp || after.stamina !== before.stamina || after.rep !== before.rep || after.karma !== before.karma) {
        // HP stays within the character's own Max HP (the start scenario's, GEN-065).
        tx.update(character)
          .set({ hp: sql`min(${after.hp}, ${character.hpMax})`, stamina: after.stamina, reputation: after.rep, karma: after.karma, updatedAt: now })
          .where(eq(character.memberId, after.id))
          .run();
      }
      if (after.locationId !== before.locationId) moveCharacter(tx, after.id, after.locationId, now);
      for (const item of after.items) {
        if (!before.items.some((i) => i.id === item.id)) transferItem(tx, gameId, item.id, after.id, now);
      }
    }
    // GEN-182: the engine's affinity change (already ±10 / -100..100) goes to npc_bond with the reveal / evolution rules,
    // after the karma write so evolution reads this turn's karma.
    if (tagging !== undefined) {
      for (const o of result.log.outcomes) {
        if (o.status !== 'resolved') continue;
        for (const a of o.log.affinity) if (a.after !== a.before) changeNpcAffinity(tx, tagging.assets, o.actorId, a.npcId, a.after - a.before, { day: tagging.day, now });
      }
    }
    const events = result.log.outcomes.map((outcome) => ({ outcome, witnesses: witnessesOfOutcome(outcome) }));
    return { ok: true, log: result.log, events };
  });
}

/** What `viewer` may know of the phase's events, in resolve order. Nothing for events they did not witness. */
export function noticesFor(db: DbOrTx, gameId: string, viewerMemberId: string, events: readonly PhaseEventRecord[]): CrossPlayerNotice[] {
  const relevant = events.filter((e) => e.witnesses.includes(viewerMemberId));
  if (relevant.length === 0) return [];

  const characters = new Map<string, CharacterRow>(
    db
      .select()
      .from(character)
      .innerJoin(member, eq(member.id, character.memberId))
      .where(eq(member.gameId, gameId))
      .all()
      .map((r) => [r.character.memberId, r.character]),
  );
  const presences = new Map(presencesInGame(db, gameId).map((p) => [p.memberId, p]));
  const known = namesVisibleTo(db, viewerMemberId);
  const items = itemsInGame(db, gameId);
  const person = (memberId: string): OtherCharacterView | null => {
    const c = characters.get(memberId);
    const p = presences.get(memberId);
    return c && p ? otherCharacterView(c, p, known.has(memberId)) : null;
  };
  const itemViews = (ids: readonly string[]): ItemView[] => ids.map((id) => ({ id, name: items.get(id)?.name ?? '' }));

  return relevant.flatMap(({ outcome: o }): CrossPlayerNotice[] => {
    if (o.actorId === viewerMemberId) {
      if (o.status === 'skipped') return [{ kind: 'own_action', actionId: o.actionId, status: 'skipped' }];
      if (o.status === 'no_target') return [{ kind: 'own_action', actionId: o.actionId, status: 'no_target', reason: o.reason }];
      return [
        {
          kind: 'own_action',
          actionId: o.actionId,
          status: 'resolved',
          degree: o.log.degree,
          interrupted: o.log.interrupted,
          moved: o.moved,
          target: o.target === null ? null : person(o.target.playerId),
          itemsTaken: itemViews(o.target?.itemsLost ?? []),
          itemsGiven: itemViews(o.target?.itemsGained ?? []),
        },
      ];
    }
    if (o.status === 'resolved' && o.target?.playerId === viewerMemberId) {
      const t = o.target;
      return [
        {
          kind: 'affected',
          actionId: o.actionId,
          by: t.knowsActor ? person(o.actorId) : null,
          noticed: o.visibility === 'secret' && t.knowsActor,
          hp: { damage: t.hp.damage, heal: t.hp.heal, after: t.hp.after },
          itemsLost: itemViews(t.itemsLost),
          itemsGained: itemViews(t.itemsGained),
        },
      ];
    }
    if (o.status === 'skipped') return [];
    const actor = person(o.actorId);
    if (actor === null) return [];
    const target = o.status === 'resolved' && o.target !== null ? person(o.target.playerId) : null;
    return [{ kind: 'witnessed', actionId: o.actionId, actor, target, moved: o.status === 'resolved' ? o.moved : null }];
  });
}
