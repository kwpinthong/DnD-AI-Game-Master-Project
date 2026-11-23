import { CharacterResponse, SurroundingsResponse } from '@isekai/protocol';
import { ReplayRng, type Period, type PhaseAction, type ResolutionProposal, type Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGameAssets } from '../src/assets/load.ts';
import { applyPhaseActions, crossPlayerState } from '../src/crossplayer/phase.ts';
import type { TaggingOptions } from '../src/crossplayer/tags.ts';
import { buildTurnContext, loadWorld } from '../src/gm/context.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { curseOf, turnIndex } from '../src/statuses/curses.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-095 (Q-142, Q-212): Venom of Despair that succeeds puts "หวาดกลัว" on its target (player or NPC): d20 -3 on
 * every roll for 2 periods = 4 turns (the sheet's Duration {period, 2}; 2 turns per period, GEN-063), from the turn
 * after the cast. Casting it again while it lasts resets the 4 turns and stays -3.
 */

const assets = loadGameAssets();
const VENOM = 'Venom of Despair';
const noEffects = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };
const none = { damage: null, heal: null, takeItem: null, giveItem: null };

function proposal(actionId: string, patch: Partial<ResolutionProposal> = {}): ResolutionProposal {
  return {
    actionId,
    kind: 'complex',
    tags: [],
    opposed: false,
    staminaCost: 5,
    visibility: 'public',
    target: null,
    check: { type: 'dc', dc: 14 },
    modifiers: [],
    witnessNpcIds: [],
    repDeltaIfCaught: 0,
    onSuccess: noEffects,
    onFail: noEffects,
    reason: 'test action',
    ...patch,
  };
}

describe('Venom of Despair in the game data (GEN-095)', () => {
  it('the sheet row gives a -3 curse "หวาดกลัว" for 2 periods = 4 turns', () => {
    const venom = assets.ability(VENOM) ?? expect.fail('no Venom of Despair');
    expect(curseOf(venom, VENOM)).toEqual({ source: VENOM, label: 'หวาดกลัว', value: -3, turns: 4 });
    expect(curseOf(assets.ability('Feast of Malice')!, 'Feast of Malice')).toBeNull();
  });

  it('turns count over the game: 2 per period, 4 periods per day', () => {
    expect(turnIndex({ day: 1, phase: 'EOSORIA', turn: 1 })).toBe(0);
    expect(turnIndex({ day: 1, phase: 'EOSORIA', turn: 2 })).toBe(1);
    expect(turnIndex({ day: 1, phase: 'SOLARION', turn: 1 })).toBe(2);
    expect(turnIndex({ day: 2, phase: 'EOSORIA', turn: 1 })).toBe(8);
  });
});

describe('Venom of Despair on the server (GEN-095)', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function table(): Promise<Table & { gameId: string }> {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    server.db.prepare('delete from character_loot').run();
    giveLoot(t.a, VENOM);
    // The beggar NPC stands where the players start (locations[0], the inn).
    server.db.prepare("update game_scenario set data = json_set(data, '$.npcs[0].locationId', 'inn') where game_id = ?").run(gameId);
    at(gameId, 1, 'EOSORIA', 1);
    return { ...t, gameId };
  }

  function giveLoot(who: Seat, skillName: string) {
    const trait = (label: string, scope: string, value: number) => ({ label, description: label, scope, value });
    const option = (id: string, kind: 'item' | 'skill', name: string) => ({ id, kind, name, description: name, tier: 'Common', buffType: 'Qualitative', effect: null });
    const chosen = { strength: trait('ช่างฝีมือ', 'craft', 2), weakness: trait('ไม่ศรัทธา', 'faith', -2), skill: option(`skill-${who.name}`, 'skill', skillName), item: option(`item-${who.name}`, 'item', 'Mask of the Faceless') };
    server!.db
      .prepare('insert into character_loot (member_id, offer_json, chosen_json, rerolls_used, updated_at) values (?, null, ?, 0, ?)')
      .run(who.memberId, JSON.stringify(chosen), CLOCK);
  }

  /** Puts the game's day / period / turn at this point (what the room's engine state holds). */
  function at(gameId: string, day: number, phase: Period, turn: Turn) {
    const state = ensurePhaseState(server!.orm, gameId, CLOCK);
    savePhaseState(server!.orm, gameId, { ...state, day, phase, turn }, CLOCK);
  }

  const options = (day = 1): TaggingOptions => ({ assets, day });

  /** A curses player B with Venom (pvp). Dice: A's priority d20, then the action d20. */
  function venomOnPlayer(a: Seat, b: Seat, n: number): PhaseAction {
    return {
      actorId: a.memberId,
      proposal: proposal(`venom-${n}`, { check: { type: 'pvp' }, tagging: { verbTags: ['CURSE'], targetTags: ['PLAYER'], activate: [{ ref: `skill-${a.name}`, stamina: 4 }] } }),
      targetPlayer: { player: b.memberId, intent: 'harm', reachRef: null, defenseRef: null, perceptionRef: null, onSuccess: none, onFail: none },
      moveTo: null,
      awareness: 'normal',
    };
  }

  function venomOnNpc(a: Seat, n: number): PhaseAction {
    return {
      actorId: a.memberId,
      proposal: proposal(`venom-npc-${n}`, { target: { npc: 'beggar' }, check: { type: 'dc', dc: 11 }, tagging: { verbTags: ['CURSE'], targetTags: ['NPC'], activate: [{ ref: `skill-${a.name}`, stamina: 4 }] } }),
      targetPlayer: null,
      moveTo: null,
      awareness: 'normal',
    };
  }

  /** B acts alone at DC 11, no stat claim. */
  function plainAction(who: Seat, n: number, patch: Partial<ResolutionProposal> = {}): PhaseAction {
    return { actorId: who.memberId, proposal: proposal(`plain-${n}`, { check: { type: 'dc', dc: 11 }, ...patch }), targetPlayer: null, moveTo: null, awareness: 'normal' };
  }

  function apply(gameId: string, actions: PhaseAction[], dice: number[]) {
    const r = applyPhaseActions(server!.orm, gameId, actions, new ReplayRng(dice), CLOCK, options());
    if (!r.ok) return expect.fail(JSON.stringify(r.errors));
    return r;
  }

  const playerCurses = (gameId: string, who: Seat) => crossPlayerState(server!.orm, gameId).players[who.memberId]!.statuses.filter((s) => s.origin === 'curse');
  const npcCurses = (gameId: string) => crossPlayerState(server!.orm, gameId).npcs['beggar']?.statuses ?? [];

  function checkOf(r: ReturnType<typeof apply>, actionId: string) {
    const o = r.log.outcomes.find((x) => x.actionId === actionId)!;
    return o.status === 'resolved' ? o.log.check : null;
  }

  it('C1: Venom succeeds on B → from the next turn every roll of B is -3 (logged as a status modifier)', async () => {
    const t = await table();
    apply(t.gameId, [venomOnPlayer(t.a, t.b, 1)], [10, 15]);
    // Not in the cast turn itself.
    expect(playerCurses(t.gameId, t.b)).toEqual([]);

    at(t.gameId, 1, 'EOSORIA', 2);
    expect(playerCurses(t.gameId, t.b)).toEqual([expect.objectContaining({ label: 'หวาดกลัว', polarity: 'debuff', mods: [{ scope: 'all', value: -3 }], phasesLeft: 4 })]);
    const next = apply(t.gameId, [plainAction(t.b, 1)], [10, 12]);
    expect(checkOf(next, 'plain-1')).toMatchObject({ dc: 11, d20: 12, modifiers: [{ source: 'status', value: -3 }], total: 9 });
    // A is not cursed.
    expect(playerCurses(t.gameId, t.a)).toEqual([]);
  });

  it('C2: the curse lasts 4 turns (2 periods) after the cast and is gone by itself after', async () => {
    const t = await table();
    apply(t.gameId, [venomOnPlayer(t.a, t.b, 1)], [10, 15]); // cast at day 1 EOSORIA turn 1
    const left = (day: number, phase: Period, turn: Turn) => {
      at(t.gameId, day, phase, turn);
      return playerCurses(t.gameId, t.b).map((s) => s.phasesLeft);
    };
    expect(left(1, 'EOSORIA', 2)).toEqual([4]);
    expect(left(1, 'SOLARION', 1)).toEqual([3]);
    expect(left(1, 'SOLARION', 2)).toEqual([2]);
    expect(left(1, 'HESPERION', 1)).toEqual([1]);
    expect(left(1, 'HESPERION', 2)).toEqual([]);
    expect(left(2, 'EOSORIA', 1)).toEqual([]);
    const after = apply(t.gameId, [plainAction(t.b, 2)], [10, 12]);
    expect(checkOf(after, 'plain-2')?.modifiers).toEqual([]);
  });

  it('C3: Venom that fails puts no status on anyone', async () => {
    const t = await table();
    apply(t.gameId, [venomOnPlayer(t.a, t.b, 1)], [10, 2]);
    at(t.gameId, 1, 'EOSORIA', 2);
    expect(playerCurses(t.gameId, t.b)).toEqual([]);
    expect(server!.db.prepare('select count(*) as n from game_status').get()).toEqual({ n: 0 });
  });

  it('C4: Venom on an NPC → its resistance (the DC against it) and its witness roll are -3 for 4 turns', async () => {
    const t = await table();
    apply(t.gameId, [venomOnNpc(t.a, 1)], [10, 15]);
    at(t.gameId, 1, 'EOSORIA', 2);
    expect(npcCurses(t.gameId)).toEqual([expect.objectContaining({ label: 'หวาดกลัว', mods: [{ scope: 'all', value: -3 }] })]);

    // C persuades the beggar at DC 14 → 11; B steals in Secret with the beggar watching: its roll is -3.
    const persuade = apply(t.gameId, [plainAction(t.c, 1, { target: { npc: 'beggar' }, check: { type: 'dc', dc: 14 } })], [10, 12]);
    expect(checkOf(persuade, 'plain-1')).toMatchObject({ dc: 11, targetCurse: -3, total: 12 });
    const steal = apply(t.gameId, [plainAction(t.b, 2, { visibility: 'secret', witnessNpcIds: ['beggar'], check: { type: 'dc', dc: 8 } })], [10, 12, 10]);
    const secret = steal.log.outcomes.find((o) => o.actionId === 'plain-2')!;
    if (secret.status !== 'resolved') return expect.fail('expected resolved');
    const grade = { F: 0, B: 1, A: 3, S: 5, SS: 7 }[crossPlayerState(server!.orm, t.gameId).npcs['beggar']!.grade];
    expect(secret.log.observation).toEqual({ npcId: 'beggar', d20: 10, total: 10 + grade - 3 });

    at(t.gameId, 1, 'HESPERION', 2);
    expect(npcCurses(t.gameId)).toEqual([]);
  });

  it('C5 / Q-212: casting again while B is cursed resets the 4 turns and stays -3 (one status)', async () => {
    const t = await table();
    apply(t.gameId, [venomOnPlayer(t.a, t.b, 1)], [10, 15]); // day 1 EOSORIA 1: turns 1..4 after
    at(t.gameId, 1, 'SOLARION', 1);
    expect(playerCurses(t.gameId, t.b).map((s) => s.phasesLeft)).toEqual([3]);
    apply(t.gameId, [venomOnPlayer(t.a, t.b, 2)], [10, 15]); // again at SOLARION 1
    at(t.gameId, 1, 'SOLARION', 2);
    const curses = playerCurses(t.gameId, t.b);
    expect(curses.map((s) => [s.phasesLeft, s.mods])).toEqual([[4, [{ scope: 'all', value: -3 }]]]);
    expect(server!.db.prepare('select count(*) as n from game_status').get()).toEqual({ n: 1 });
    const roll = apply(t.gameId, [plainAction(t.b, 3)], [10, 12]);
    expect(checkOf(roll, 'plain-3')?.modifierSum).toBe(-3);
    at(t.gameId, 1, 'NOCTHERION', 1);
    expect(playerCurses(t.gameId, t.b).map((s) => s.phasesLeft)).toEqual([1]);
  });

  it('C6: B sees the status as a word with no number; the Human GM sees the number and the turns left', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, true);
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    server.db.prepare('delete from character_loot').run();
    giveLoot(t.a, VENOM);
    at(gameId, 1, 'EOSORIA', 1);
    apply(gameId, [venomOnPlayer(t.a, t.b, 1)], [10, 15]);
    at(gameId, 1, 'EOSORIA', 2);

    const mine = await t.call('GET', '/api/game/character', { token: t.b.token });
    const you = CharacterResponse.parse(mine.body).character!;
    expect(you.statuses).toEqual(['หวาดกลัว']);
    const text = JSON.stringify(mine.body);
    expect(text).not.toMatch(/-3|Venom|turnsLeft|phasesLeft/);
    const around = SurroundingsResponse.parse((await t.call('GET', '/api/game/surroundings', { token: t.b.token })).body);
    if (around.view !== 'player') return expect.fail('expected the player view');
    expect(around.you?.statuses).toEqual(['หวาดกลัว']);
    // A (the caster) has no status, and sees none on B.
    const aView = await t.call('GET', '/api/game/surroundings', { token: t.a.token });
    expect(JSON.stringify(aView.body)).not.toContain('หวาดกลัว');

    const gm = SurroundingsResponse.parse((await t.call('GET', '/api/game/surroundings', { token: t.gm!.token })).body);
    if (gm.view !== 'gm') return expect.fail('expected the GM view');
    expect(gm.characters.find((c) => c.memberId === t.b.memberId)?.curses).toEqual([{ label: 'หวาดกลัว', source: VENOM, value: -3, turnsLeft: 4 }]);
    expect(gm.characters.find((c) => c.memberId === t.a.memberId)?.curses).toEqual([]);
  });

  it('the AI GM is told who is cursed, with the sheet text (e.g. no Good skills while หวาดกลัว)', async () => {
    const t = await table();
    apply(t.gameId, [venomOnPlayer(t.a, t.b, 1)], [10, 15]);
    apply(t.gameId, [venomOnNpc(t.a, 2)], [10, 15]);
    at(t.gameId, 1, 'EOSORIA', 2);
    const world = loadWorld(server!.orm, t.gameId, assets);
    const ctx = buildTurnContext(server!.orm, {
      world,
      state: crossPlayerState(server!.orm, t.gameId),
      tags: {},
      vocabulary: [],
      drowsy: new Set(),
      at: { day: 1, phase: 'EOSORIA', turn: 2 },
      actions: [],
      resting: [],
      assets,
    });
    const b = ctx.players.find((p) => p.ref === world.players.get(t.b.memberId)!.ref)!;
    expect(b.curses).toEqual([{ label: 'หวาดกลัว', source: VENOM, effect: assets.ability(VENOM)!.descriptionEn }]);
    expect(ctx.players.find((p) => p.ref === world.players.get(t.a.memberId)!.ref)!.curses).toEqual([]);
    expect(ctx.npcs.find((n) => n.id === 'beggar')?.curses).toEqual(['หวาดกลัว']);
  });

  it('C7: after a restart the status and its turns left are the same', async () => {
    const t = await table();
    apply(t.gameId, [venomOnPlayer(t.a, t.b, 1)], [10, 15]);
    apply(t.gameId, [venomOnNpc(t.a, 2)], [10, 15]);
    at(t.gameId, 1, 'SOLARION', 1);
    const before = [playerCurses(t.gameId, t.b), npcCurses(t.gameId)];
    expect(before.map((l) => l.length)).toEqual([1, 1]);

    await server!.close();
    server = await startTestServer(dataDir);
    expect([playerCurses(t.gameId, t.b), npcCurses(t.gameId)]).toEqual(before);
    expect(playerCurses(t.gameId, t.b).map((s) => s.phasesLeft)).toEqual([3]);
  });
});
