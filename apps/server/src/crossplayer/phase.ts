import type { LootOption, OtherCharacterView } from '@isekai/protocol';
import {
  NPC_HP_MAX,
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
  type PlayerState,
  type Rng,
  type StatusEffect,
} from '@isekai/rules';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { character, characterPresence, member } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { moveCharacter, namesKnownBy, npcBondsOf, presencesInGame } from '../visibility/store.ts';
import { otherCharacterView, witnessesOf } from '../visibility/views.ts';
import { chosenLootInGame, itemsInGame, transferItem } from './items.ts';

/**
 * Cross-player phase actions on the server (GEN-060, Rules Spec §10). The AI GM phase loop (GEN-057)
 * calls, once every action of a phase has its proposal:
 * 1. `applyPhaseActions(db, gameId, actions, new CryptoRng(), now)`: reads the game, orders and
 *    resolves the actions with `resolvePhaseActions` (@isekai/rules) and writes HP, Stamina,
 *    Reputation, Karma, places and item holders in one transaction. Any invalid action → nothing is
 *    rolled or written (Q-049: all-or-nothing; the caller asks the AI to repair once). Keep `log`
 *    with the phase: it holds every die and replays with `replayPhaseActions`.
 * 2. `noticesFor(db, gameId, viewer, events)`: what one player may know of those events, for their
 *    narration and the socket (GEN-056). Other players appear as `OtherCharacterView` (appearance;
 *    the real name only once the viewer knows it), never by member id, so AI prompts stay free of names (Q-045).
 *
 * Not stored here yet: event statuses and NPC Affinity from the actions (no store before GEN-054),
 * NPC HP (NPCs start each call at their grade's max). Players identify targets by member id.
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

/** Characters of the game's active, placed members in seat (join) order. */
function seatedCharacters(db: DbOrTx, gameId: string) {
  return db
    .select({ character, locationId: characterPresence.locationId })
    .from(character)
    .innerJoin(member, eq(member.id, character.memberId))
    .innerJoin(characterPresence, eq(characterPresence.memberId, character.memberId))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt)))
    .orderBy(asc(member.createdAt), sql`member.rowid`)
    .all();
}

/**
 * The game as the cross-player rules read it. Loot maps onto the state as GEN-048 describes: traits →
 * permanent statuses, held items and the chosen skill → OwnedRef plus their Quantitative effect.
 * No loot carries `reach: remote` yet (GEN-055), so `remoteReach` is empty.
 */
export function crossPlayerState(db: DbOrTx, gameId: string): CrossPlayerState {
  const loot = new Map(chosenLootInGame(db, gameId).map((l) => [l.memberId, l.chosen]));
  const items = [...itemsInGame(db, gameId).values()];
  const players: Record<string, PlayerState> = {};

  seatedCharacters(db, gameId).forEach(({ character: c, locationId }, seat) => {
    const chosen = loot.get(c.memberId) ?? null;
    const statuses: StatusEffect[] = [];
    let damageReduction = 0;
    let afterActionStamina = 0;
    const apply = (option: LootOption) => {
      const e = option.effect;
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
    const owned = (o: LootOption): OwnedRef => ({ id: o.id, tier: o.tier });

    players[c.memberId] = {
      id: c.memberId,
      seat,
      locationId,
      hp: c.hp,
      stamina: c.stamina,
      rep: c.reputation,
      karma: c.karma,
      affinity: Object.fromEntries(npcBondsOf(db, c.memberId).map((b) => [b.npcId, b.affinity])),
      items: held.map(owned),
      skills: chosen ? [owned(chosen.skill)] : [],
      statuses,
      afterActionStamina,
      damageReduction,
      remoteReach: [],
    };
  });

  const npcs: Record<string, NpcState> = {};
  for (const n of getGameScenario(db, gameId)?.npcs ?? []) {
    npcs[n.id] = { id: n.id, grade: n.rank, hp: NPC_HP_MAX[n.rank], locationId: n.locationId, obsTrait: 0, damageReduction: 0 };
  }
  return { players, npcs };
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
    if (t.knowsActor || t.hp.damage > 0 || t.hp.heal > 0 || t.itemsLost.length > 0 || t.itemsGained.length > 0) seen.add(t.playerId);
  }
  return [...seen];
}

/** Resolves and writes one phase's actions (see the module comment). */
export function applyPhaseActions(db: Db, gameId: string, actions: readonly PhaseAction[], rng: Rng, now: number): ApplyPhaseResult {
  return db.transaction((tx) => {
    const state = crossPlayerState(tx, gameId);
    const places = new Set((getGameScenario(tx, gameId)?.locations ?? []).map((l) => l.id));
    const errors: PhaseApplyError[] = [
      ...actions.flatMap((a, i) =>
        a.moveTo !== null && !places.has(a.moveTo)
          ? [{ code: 'unknown_location' as const, path: 'moveTo', action: i, message: `the scenario has no place ${a.moveTo}` }]
          : [],
      ),
      ...validatePhaseActions({ state, actions }),
    ];
    if (errors.length > 0) return { ok: false, errors };

    const result = resolvePhaseActions({ state, actions }, rng);
    if (!result.ok) return { ok: false, errors: [...result.errors] };

    for (const after of Object.values(result.state.players)) {
      const before = state.players[after.id]!;
      if (after.hp !== before.hp || after.stamina !== before.stamina || after.rep !== before.rep || after.karma !== before.karma) {
        tx.update(character)
          .set({ hp: after.hp, stamina: after.stamina, reputation: after.rep, karma: after.karma, updatedAt: now })
          .where(eq(character.memberId, after.id))
          .run();
      }
      if (after.locationId !== before.locationId) moveCharacter(tx, after.id, after.locationId, now);
      for (const item of after.items) {
        if (!before.items.some((i) => i.id === item.id)) transferItem(tx, gameId, item.id, after.id, now);
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
  const known = namesKnownBy(db, viewerMemberId);
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
