import { InventoryResponse, type Scenario } from '@isekai/protocol';
import { PERIODS, type Period } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setNpcFlag } from '../src/companions/store.ts';
import { crossPlayerState } from '../src/crossplayer/phase.ts';
import { tagContexts } from '../src/crossplayer/tags.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import {
  checkSkillUnlocks,
  grantItem,
  grantSkill,
  recordSkillActivity,
  recordSkillFlag,
  revealAtLibrary,
  skillProgressOf,
} from '../src/skills/store.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/** GEN-055: skills / items of the Asset sheet, unlock conditions counted in the background, NPC gifts, the library. */
describe('GEN-055 skills and items from the Asset sheet', { timeout: 60_000 }, () => {
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

  const gameIdOf = (seat: Seat) => (server!.db.prepare('select game_id from member where id = ?').get(seat.memberId) as { game_id: string }).game_id;
  const at = (day: number, period: Period = 'EOSORIA') => ({ day, period, now: CLOCK });
  const setKarma = (seat: Seat, karma: number) => server!.db.prepare('update character set karma = ? where member_id = ?').run(karma, seat.memberId);
  const db = () => server!.orm;
  const assets = () => server!.assets;

  /** A started game whose scenario NPCs include the sheet's ออเรเลีย (S) and ลอร์ดจูเลียน (A), both at the inn. */
  async function table(): Promise<Table> {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    // The start needs a loot choice (Q-144); these cases count only what they give, so start from none.
    server.db.prepare('delete from character_loot').run();
    const gameId = gameIdOf(t.a);
    const scenario = getGameScenario(server.orm, gameId)!;
    const sheetNpc = (id: string, name: string, rank: 'A' | 'S'): Scenario['npcs'][number] => ({
      id,
      name,
      alias: name,
      rank,
      locationId: 'inn',
      personality: '',
      obsTrait: 0,
      otherNames: [],
      gmNote: '',
    });
    const npcs = [...scenario.npcs, sheetNpc('aurelia', 'ออเรเลีย', 'S'), sheetNpc('julian', 'ลอร์ดจูเลียน แวนเดอร์บิลต์', 'A')];
    const updated = updateGameScenario(server.orm, gameId, { ...scenario, npcs }, CLOCK);
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    return t;
  }

  async function inventory(t: Table, who: Seat) {
    const res = await t.call('GET', '/api/game/inventory', { token: who.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { raw: JSON.stringify(res.body), view: InventoryResponse.parse(res.body).inventory };
  }
  const skillNames = async (t: Table, who: Seat) => (await inventory(t, who)).view.skills.map((s) => s.name).sort();

  /** `activity` in the first `count` periods of `day`; returns everything that unlocked. */
  function doOn(who: Seat, activity: string, day: number, count = 3): string[] {
    return PERIODS.slice(0, count).flatMap((period) => recordSkillActivity(db(), assets(), who.memberId, activity, at(day, period)));
  }

  /** Every row of the GEN-055 / GEN-054 tables of one player, to show that a refusal changes nothing. */
  function stateOf(who: Seat): string {
    const rows = ['owned_skill', 'npc_reward', 'skill_flag', 'skill_activity', 'skill_reveal'].map((table) =>
      server!.db.prepare(`select * from ${table} where member_id = ? order by 1, 2, 3`).all(who.memberId),
    );
    return JSON.stringify(rows);
  }

  it('C1: PRAY in 3 distinct periods a day for 3 days in a row gives The First Light (SS) on the third day', async () => {
    const t = await table();
    expect(doOn(t.a, 'verb:PRAY', 1)).not.toContain('The First Light');
    expect(doOn(t.a, 'verb:PRAY', 2)).not.toContain('The First Light');
    expect(doOn(t.a, 'verb:PRAY', 3, 2)).not.toContain('The First Light');
    expect(doOn(t.a, 'verb:PRAY', 3)).toContain('The First Light');
    const inv = (await inventory(t, t.a)).view;
    expect(inv.skills.find((s) => s.name === 'The First Light')).toMatchObject({ rank: 'SS', alignment: 'Good', triggerType: 'Active', dailyLimit: 1 });
    // The first prayer also met Ward of Light ("สวดภาวนา"); nobody else got anything.
    expect(await skillNames(t, t.a)).toEqual(['The First Light', 'Ward of Light']);
    expect(await skillNames(t, t.b)).toEqual([]);
  });

  it('C1: a missed day starts the count again', async () => {
    const t = await table();
    doOn(t.a, 'verb:PRAY', 1);
    doOn(t.a, 'verb:PRAY', 2);
    doOn(t.a, 'verb:PRAY', 3, 2);
    doOn(t.a, 'verb:PRAY', 4);
    expect(doOn(t.a, 'verb:PRAY', 5)).toEqual([]);
    expect(await skillNames(t, t.a)).not.toContain('The First Light');
    expect(doOn(t.a, 'verb:PRAY', 6)).toEqual(['The First Light']);
  });

  it('C2: the ORDO TENEBRIS streak is done but karma -89 is not below -90; at -91 it unlocks', async () => {
    const t = await table();
    setKarma(t.b, -89);
    for (const day of [1, 2, 3]) doOn(t.b, 'evil', day);
    expect(await skillNames(t, t.b)).not.toContain('ORDO TENEBRIS');
    setKarma(t.b, -91);
    expect(checkSkillUnlocks(db(), assets(), t.b.memberId, at(3, 'HESPERION'))).toContain('ORDO TENEBRIS');
    expect(await skillNames(t, t.b)).toContain('ORDO TENEBRIS');
  });

  it('C3: karma +60 without a Rank A Good skill gives no Grace of Dawn; with one it does', async () => {
    const t = await table();
    setKarma(t.c, 60);
    expect(checkSkillUnlocks(db(), assets(), t.c.memberId, at(1))).toEqual([]);
    expect(await skillNames(t, t.c)).toEqual([]);
    // One prayer: Ward of Light (B) → Aegis of Faith (A Good, karma +35) → Grace of Dawn (S), in one check.
    expect(doOn(t.c, 'verb:PRAY', 1, 1)).toEqual(['Ward of Light', 'Aegis of Faith', 'Grace of Dawn']);
    expect(await skillNames(t, t.c)).toEqual(['Aegis of Faith', 'Grace of Dawn', 'Ward of Light']);
  });

  it('C4: holding the Chalice, helping 3 times and praying cuts The First Light to 2 days', async () => {
    const t = await table();
    // ออเรเลีย does not give the Chalice; a reward row stands for any way of getting it (โนอา, the black market).
    server!.db.prepare("insert into npc_reward (member_id, npc_id, reward, kind, granted_at) values (?, 'noa', 'Chalice of the First Dawn', 'item', ?)").run(t.a.memberId, CLOCK);
    server!.db.prepare("insert into npc_reward (member_id, npc_id, reward, kind, granted_at) values (?, 'noa', 'Chalice of the First Dawn', 'item', ?)").run(t.b.memberId, CLOCK);
    for (let i = 0; i < 3; i++) expect(recordSkillFlag(db(), assets(), t.a.memberId, 'chalice_helped_others', at(1))).toMatchObject({ ok: true, count: i + 1 });
    for (let i = 0; i < 2; i++) recordSkillFlag(db(), assets(), t.b.memberId, 'chalice_helped_others', at(1));
    doOn(t.a, 'verb:PRAY', 1);
    doOn(t.b, 'verb:PRAY', 1);
    doOn(t.b, 'verb:PRAY', 2);
    expect(doOn(t.a, 'verb:PRAY', 2)).toContain('The First Light');
    // B helped only twice: 2 days are not enough without the full synergy.
    expect(await skillNames(t, t.b)).not.toContain('The First Light');
    expect((await inventory(t, t.a)).view.items.map((i) => i.name)).toEqual(['Chalice of the First Dawn']);
  });

  it('C5: an NPC whose Rewards hold Grace of Dawn gives it; a skill outside that NPC\'s Rewards with unmet conditions is refused', async () => {
    const t = await table();
    // Before ออเรเลีย awakens (A → S) her Grace of Dawn is not open, and A's conditions do not hold.
    const early = stateOf(t.a);
    expect(grantSkill(db(), assets(), t.a.memberId, 'Grace of Dawn', at(1), { npcId: 'aurelia' })).toMatchObject({ ok: false, error: { code: 'not_unlocked' } });
    expect(stateOf(t.a)).toBe(early);
    // "ค่ากรรม +50 ขึ้นไป และนำ ... ไปสวดภาวนาที่แท่นบูชาลับ": she awakens and gives Grace of Dawn.
    setKarma(t.a, 50);
    expect(setNpcFlag(db(), assets(), t.a.memberId, 'aurelia', 'prayed_at_secret_altar', { day: 1, now: CLOCK })).toMatchObject({ ok: true });
    expect(await skillNames(t, t.a)).toEqual(['Grace of Dawn']);
    // An item of an NPC's Rewards (Julian, grade A: "มอบ Censer of Purging Flame (A)").
    expect(grantItem(db(), assets(), t.a.memberId, 'Censer of Purging Flame', 'julian', at(1))).toEqual({ ok: true });
    expect((await inventory(t, t.a)).view.items).toEqual([expect.objectContaining({ name: 'Censer of Purging Flame', rank: 'A', alignment: 'Good' })]);

    // The AI names The First Light from ออเรเลีย: not in her Rewards, and B prayed on one day only.
    doOn(t.b, 'verb:PRAY', 1);
    const before = stateOf(t.b);
    const refused = grantSkill(db(), assets(), t.b.memberId, 'The First Light', at(1), { npcId: 'aurelia' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'not_in_rewards' } });
    expect(stateOf(t.b)).toBe(before);
    // Without an NPC the conditions decide: Aegis of Faith needs karma +35 on top of Ward of Light.
    expect(grantSkill(db(), assets(), t.b.memberId, 'Aegis of Faith', at(1))).toMatchObject({ ok: false, error: { code: 'not_unlocked' } });
    setKarma(t.b, 35);
    expect(grantSkill(db(), assets(), t.b.memberId, 'Aegis of Faith', at(1))).toMatchObject({ ok: true, source: 'unlock' });
  });

  it('Q-229 C5: usesLeftToday counts the limit down on use, resets on a new day, and is null without a limit', async () => {
    const t = await table();
    const gameId = gameIdOf(t.a);
    const insert = (name: string) => server!.db.prepare("insert into owned_skill (member_id, game_id, name, source, day, created_at) values (?, ?, ?, 'test', 1, ?)").run(t.a.memberId, gameId, name, CLOCK);
    insert('Grace of Dawn');
    const limited = async () => (await inventory(t, t.a)).view.skills.find((s) => s.name === 'Grace of Dawn')!;
    expect(await limited()).toMatchObject({ dailyLimit: 1, usesLeftToday: 1 });
    const id = (await limited()).id;
    server!.db.prepare("insert into tag_source_use (game_id, member_id, source_id, day, uses, updated_at) values (?, ?, ?, 1, 1, ?)").run(gameId, t.a.memberId, id, CLOCK);
    expect((await limited()).usesLeftToday).toBe(0);
    const state = ensurePhaseState(db(), gameId, CLOCK);
    savePhaseState(db(), gameId, { ...state, day: 2 }, CLOCK);
    expect((await limited()).usesLeftToday).toBe(1);
    insert('Ward of Light');
    const unlimited = (await inventory(t, t.a)).view.skills.find((s) => s.name === 'Ward of Light')!;
    expect(unlimited).toMatchObject({ dailyLimit: 0, usesLeftToday: null });
  });

  it('C7: the inventory API shows skills and items but no condition, flag or progress', async () => {
    const t = await table();
    doOn(t.a, 'verb:PRAY', 1);
    recordSkillFlag(db(), assets(), t.a.memberId, 'protected_others', at(1));
    setKarma(t.a, 40);
    checkSkillUnlocks(db(), assets(), t.a.memberId, at(1));
    const { raw, view } = await inventory(t, t.a);
    expect(view.skills.map((s) => s.name).sort()).toEqual(['Aegis of Faith', 'Ward of Light']);
    expect(view.discoveries).toEqual([]);
    for (const secret of ['protected_others', 'verb:PRAY', 'EOSORIA', 'condition', 'progress', 'สวดภาวนา', 'มีสกิล', 'karma']) {
      expect(raw, secret).not.toContain(secret);
    }
    // The GM side does have the progress (the scanner is not blind).
    expect(skillProgressOf(db(), assets(), t.a.memberId, 1).flags).toEqual({ protected_others: 1 });
  });

  it('C7: INVESTIGATE at the library with a tag of one skill reveals that skill\'s condition only', async () => {
    const t = await table();
    expect(revealAtLibrary(db(), assets(), t.a.memberId, ['MIRACLE'], at(2))).toEqual([{ kind: 'skill', name: 'The First Light' }]);
    // Every topic tag must be the row's: DEBATE + MIRACLE fits nothing.
    expect(revealAtLibrary(db(), assets(), t.a.memberId, ['DEBATE', 'MIRACLE'], at(2))).toEqual([]);
    expect(revealAtLibrary(db(), assets(), t.a.memberId, [], at(2))).toEqual([]);
    const { view } = await inventory(t, t.a);
    expect(view.discoveries).toEqual([{ kind: 'skill', name: 'The First Light', text: assets().ability('The First Light')!.condition }]);
    // Another player found nothing.
    expect((await inventory(t, t.b)).view.discoveries).toEqual([]);
    // An item: TRADE is only Scales of Fair Trade; its text is the Skill Synergy cell.
    revealAtLibrary(db(), assets(), t.b.memberId, ['TRADE'], at(2));
    expect((await inventory(t, t.b)).view.discoveries).toEqual([{ kind: 'item', name: 'Scales of Fair Trade', text: assets().item('Scales of Fair Trade')!.synergy }]);
  });

  it('C8: a skill already owned is not given twice, and names not in the data change nothing', async () => {
    const t = await table();
    doOn(t.a, 'verb:PRAY', 1, 1);
    expect(await skillNames(t, t.a)).toEqual(['Ward of Light']);
    const before = stateOf(t.a);
    expect(grantSkill(db(), assets(), t.a.memberId, 'Ward of Light', at(1))).toMatchObject({ ok: false, error: { code: 'already_owned' } });
    expect(grantSkill(db(), assets(), t.a.memberId, 'Holy Nuke', at(1))).toMatchObject({ ok: false, error: { code: 'unknown_skill' } });
    expect(grantSkill(db(), assets(), t.a.memberId, 'Holy Nuke', at(1), { npcId: 'aurelia' })).toMatchObject({ ok: false, error: { code: 'unknown_skill' } });
    expect(grantItem(db(), assets(), t.a.memberId, 'Excalibur', 'julian', at(1))).toMatchObject({ ok: false, error: { code: 'unknown_item' } });
    expect(recordSkillFlag(db(), assets(), t.a.memberId, 'slew_a_dragon', at(1))).toMatchObject({ ok: false, error: { code: 'unknown_flag' } });
    expect(stateOf(t.a)).toBe(before);
    expect(await skillNames(t, t.a)).toEqual(['Ward of Light']);
    // The same prayer period again counts once and gives nothing new.
    expect(doOn(t.a, 'verb:PRAY', 1, 1)).toEqual([]);
    // An item given twice by the same NPC: once.
    expect(grantItem(db(), assets(), t.a.memberId, 'Censer of Purging Flame', 'julian', at(1))).toEqual({ ok: true });
    expect(grantItem(db(), assets(), t.a.memberId, 'Censer of Purging Flame', 'julian', at(1))).toMatchObject({ ok: false });
    expect((await inventory(t, t.a)).view.items).toHaveLength(1);
  });

  it('numbers through tag matching: an unlocked skill is a tag source and an owned ref with its Rank cap', async () => {
    const t = await table();
    setKarma(t.a, 40);
    doOn(t.a, 'verb:PRAY', 1, 1);
    const state = crossPlayerState(db(), gameIdOf(t.a), new Set(), assets());
    const a = state.players[t.a.memberId]!;
    expect(a.skills).toHaveLength(2);
    expect(a.skills.map((s) => s.tier).sort()).toEqual(['Common', 'Rare']);
    const sources = tagContexts(db(), gameIdOf(t.a), state, { assets: assets(), day: 1 })[t.a.memberId]!.sources;
    expect(sources.filter((s) => s.kind === 'skill').map((s) => s.rank).sort()).toEqual(['A', 'B']);
    // The source ids are the owned ref ids (an activation names an owned skill).
    expect(sources.filter((s) => s.kind === 'skill').map((s) => s.id).sort()).toEqual(a.skills.map((s) => s.id).sort());
  });
});
