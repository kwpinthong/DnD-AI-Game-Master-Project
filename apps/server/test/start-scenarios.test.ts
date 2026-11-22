import { CharacterResponse, defaultScenario, OriginResponse, SurroundingsResponse, type OriginView } from '@isekai/protocol';
import { applyTagging, ReplayRng, SeededRng, type PhaseAction, type Rng } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { loadGameAssets } from '../src/assets/load.ts';
import { applyPhaseActions, crossPlayerState } from '../src/crossplayer/phase.ts';
import { tagContexts } from '../src/crossplayer/tags.ts';
import { rollSpawn, spawnTable, treatChronicIllness } from '../src/game/origin.ts';
import { syncCharacterStats, ensurePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { travel } from '../src/travel/service.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { caller, CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-065: start scenarios from the sheet (Start_Scenarios) instead of GEN-045 / 049's origins.
 * The roll is one draw of nextInt(1, 10000) per player in seat order (A, B, C): the 15 rows in sheet order,
 * each Rate in 1/100 of a percent: rows 1-10 standard (700 each: 1..7000), 11-14 special (725 each:
 * 7001..9900), 15 the Astral Rift (9901..10000).
 */
const MUSICIAN = 1; // นักดนตรีพเนจรตกอับ @ fountain
const DISHWASHER = 701; // ลูกมือล้างจานประจำร้าน @ inn
const SLIME = 2101; // ผู้รอดชีวิตจากท้องสไลม์ @ forest (row 4)
const SICKLY = 7001; // คุณชาย/คุณหนูขี้โรค @ manor
const ASTRAL = 9901; // ผู้หลงทางเหนือกาลเวลา @ astral-rift

/** Hands out the given numbers in order (a "seed" that is read, not searched). */
class ScriptedRng implements Rng {
  readonly draws: [number, number][] = [];
  private readonly values: number[];
  constructor(values: number[]) {
    this.values = [...values];
  }
  nextInt(min: number, max: number): number {
    const value = this.values.shift();
    if (value === undefined) throw new Error(`ScriptedRng ran out at nextInt(${min}, ${max})`);
    if (value < min || value > max) throw new Error(`ScriptedRng value ${value} outside ${min}..${max}`);
    this.draws.push([min, max]);
    return value;
  }
}

const assets = loadGameAssets();
const promptOf = (r: AiCallRequest) => [...r.system.map((b) => b.text), ...r.messages.map((m) => m.text)].join('\n');
const isNarration = (r: AiCallRequest) => r.output.name === 'origin_narration';

describe('GEN-065 start scenarios', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let requests: AiCallRequest[] = [];
  /** When false, the origin narration call fails (the AI is down). */
  let narrationWorks = true;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    requests = [];
    narrationWorks = true;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const provider: AiProvider = {
    id: 'mock',
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req): Promise<AiCallResult> {
      requests.push(req);
      if (!isNarration(req)) return mockReply.fail('provider_error');
      if (!narrationWorks) return mockReply.fail('provider_error');
      const token = /\{\{p:[^}]+\}\}/.exec(req.messages.map((m) => m.text).join('\n'))?.[0] ?? '?';
      return mockReply.ok({ narration: `คืนนั้น ${token} ลืมตาขึ้นในโลกใหม่ [${requests.length}]` });
    },
  };

  async function boot(rng: Rng) {
    server = await startTestServer(dataDir, { aiProvider: provider, rng });
    return server;
  }

  async function myOrigin(t: Table, seat: Seat): Promise<OriginView> {
    const res = await t.call('GET', '/api/game/origin', { token: seat.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = OriginResponse.parse(res.body);
    if (body.view !== 'player' || body.origin === null) throw new Error(`expected the player's own origin: ${JSON.stringify(body)}`);
    return body.origin;
  }

  async function myCharacter(t: Table, seat: Seat) {
    const res = await t.call('GET', '/api/game/character', { token: seat.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return CharacterResponse.parse(res.body).character!;
  }

  const dbRow = <T>(sql: string, ...args: unknown[]) => server!.db.prepare(sql).get(...args) as T;
  const gameIdOf = (seat: Seat) => dbRow<{ game_id: string }>('select game_id from member where id = ?', seat.memberId).game_id;
  const presence = (seat: Seat) => dbRow<{ location_id: string } | undefined>('select location_id from character_presence where member_id = ?', seat.memberId)?.location_id;

  it('C1: "นักดนตรีพเนจรตกอับ" starts with HP 22/30, Stamina 26, Coins 15, Karma 5, its title, at the fountain', async () => {
    await boot(new ScriptedRng([MUSICIAN, DISHWASHER, DISHWASHER]));
    const t = await startedTable(server!, false);

    const me = await myCharacter(t, t.a);
    expect(me.hp).toEqual({ current: 22, max: 30 });
    expect(me.stamina.current).toBe(26);
    expect(me.coins).toBe(15);
    expect(me.socialTitle).toBe('นักดนตรีพเนจรถือพิณเก่า');
    expect(dbRow<{ karma: number }>('select karma from character where member_id = ?', t.a.memberId).karma).toBe(5);
    expect(presence(t.a)).toBe('fountain');
    expect(await myOrigin(t, t.a)).toMatchObject({
      kind: 'standard',
      spawnLabel: 'นักดนตรีพเนจรตกอับ',
      location: { id: 'fountain', name: 'น้ำพุกลางเมือง' },
      initialTitle: 'นักดนตรีพเนจรถือพิณเก่า',
      illness: null,
    });
    // The engine state the room plays with starts from the same numbers.
    const state = ensurePhaseState(server!.orm, gameIdOf(t.a), CLOCK);
    expect(state.players[t.a.memberId]).toMatchObject({ hp: 22, stamina: 26, hpMax: 30 });
    // Q-210: the engine caps at the character's Max HP, not RULES.hpMax.
    expect(crossPlayerState(server!.orm, gameIdOf(t.a), new Set(), assets).players[t.a.memberId]).toMatchObject({ hp: 22, hpMax: 30 });
    // B is the dishwasher at the inn: 26/30, Stamina 28, Coins 20.
    expect(await myCharacter(t, t.b)).toMatchObject({ hp: { current: 26, max: 30 }, stamina: { current: 28 }, coins: 20 });
    expect(presence(t.b)).toBe('inn');
    // Placed before day 1 begins (Q-104): A at the fountain witnessed the bread ceremony there, B at the inn did not.
    const seen = async (seat: Seat) => JSON.stringify((await t.call('GET', '/api/game/timeline', { token: seat.token })).body);
    expect(await seen(t.a)).toContain('พิธีแจกขนมปังแห่งความเมตตา');
    expect(await seen(t.b)).not.toContain('พิธีแจกขนมปังแห่งความเมตตา');
  });

  it('C1: HP above Max HP is not stored (the old 100 cap no longer holds)', async () => {
    await boot(new ScriptedRng([MUSICIAN, DISHWASHER, DISHWASHER]));
    const t = await startedTable(server!, false);
    const state = ensurePhaseState(server!.orm, gameIdOf(t.a), CLOCK);
    syncCharacterStats(server!.orm, { ...state, players: { ...state.players, [t.a.memberId]: { ...state.players[t.a.memberId]!, hp: 90 } } }, CLOCK);
    expect((await myCharacter(t, t.a)).hp).toEqual({ current: 30, max: 30 });
  });

  it('Q-210: a phase state saved before the per-player Max HP takes it from the character when it is read', async () => {
    await boot(new ScriptedRng([MUSICIAN, DISHWASHER, DISHWASHER]));
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t.a);
    const state = ensurePhaseState(server!.orm, gameId, CLOCK);
    const old = { ...state, players: Object.fromEntries(Object.entries(state.players).map(([id, p]) => [id, { ...p, hpMax: undefined }])) };
    server!.db.prepare('update game_phase set state = ? where game_id = ?').run(JSON.stringify(old), gameId);
    expect(ensurePhaseState(server!.orm, gameId, CLOCK).players[t.a.memberId]!.hpMax).toBe(30);
  });

  it('C2: 100,000 rolls land on each of the 15 rows within 0.5 points of its Rate', () => {
    const table = spawnTable(defaultScenario(), assets);
    expect(table).toHaveLength(15);
    expect(table.reduce((sum, c) => sum + c.weight, 0)).toBe(10_000);
    expect(new Set(table.map((c) => c.label))).toEqual(new Set(assets.startScenarios.map((s) => s.name)));

    const rng = new SeededRng(65);
    const counts = new Map<string, number>();
    const N = 100_000;
    for (let i = 0; i < N; i += 1) {
      const label = rollSpawn(table, rng).label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    for (const row of assets.startScenarios) {
      const percent = ((counts.get(row.name) ?? 0) / N) * 100;
      expect(Math.abs(percent - row.rate), `${row.name}: ${percent}% vs Rate ${row.rate}%`).toBeLessThanOrEqual(0.5);
    }
  });

  it('C3: the Astral Rift start: there, has met แอสทรา, knows the day 12 secret, resists curses up to B; nobody else sees it', async () => {
    await boot(new ScriptedRng([MUSICIAN, DISHWASHER, ASTRAL]));
    const t = await startedTable(server!, false);

    const mine = await myOrigin(t, t.c);
    expect(mine).toMatchObject({ kind: 'secret', spawnLabel: 'ผู้หลงทางเหนือกาลเวลา', location: { id: 'astral-rift' } });
    expect(presence(t.c)).toBe('astral-rift');
    const row = dbRow<{ knows_day12_secret: number; curse_resist_rank: string }>(
      'select knows_day12_secret, curse_resist_rank from character_origin where member_id = ?',
      t.c.memberId,
    );
    expect(row).toEqual({ knows_day12_secret: 1, curse_resist_rank: 'B' });
    // Met แอสทรา (scenario NPC horizon-watcher): the GEN-054 bond row exists for C only.
    expect(dbRow('select npc_id from npc_bond where member_id = ? and npc_id = ?', t.c.memberId, 'horizon-watcher')).toBeDefined();
    expect(dbRow('select npc_id from npc_bond where member_id = ? and npc_id = ?', t.a.memberId, 'horizon-watcher')).toBeUndefined();

    for (const other of [t.a, t.b]) {
      for (const path of ['/api/game/origin', '/api/game/surroundings', '/api/game/character']) {
        const text = JSON.stringify((await t.call('GET', path, { token: other.token })).body);
        expect(text, path).not.toContain('astral-rift');
        expect(text, path).not.toContain('มิติพิศวง');
        expect(text, path).not.toContain('ผู้หลงทางเหนือกาลเวลา');
      }
      const around = SurroundingsResponse.parse((await t.call('GET', '/api/game/surroundings', { token: other.token })).body);
      expect(JSON.stringify(around)).not.toContain(t.c.appearance);
    }
  });

  it('C4: the sickly noble is chronically ill; one treatment is not enough, the second cures; may enter restricted places', async () => {
    await boot(new ScriptedRng([SICKLY, MUSICIAN, MUSICIAN]));
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t.a);
    const ill = () => crossPlayerState(server!.orm, gameId, new Set(), assets).players[t.a.memberId]!.statuses.some((s) => s.label === 'โรคเรื้อรัง');

    expect((await myOrigin(t, t.a)).illness).toEqual({ treatmentsLeft: 2 });
    expect(ill()).toBe(true);
    expect(await myCharacter(t, t.a)).toMatchObject({ hp: { current: 12, max: 30 }, stamina: { current: 18 }, coins: 250 });

    expect(treatChronicIllness(server!.orm, t.a.memberId)).toEqual({ kind: 'treated', treatmentsLeft: 1 });
    expect(ill()).toBe(true);
    expect((await myOrigin(t, t.a)).illness).toEqual({ treatmentsLeft: 1 });

    expect(treatChronicIllness(server!.orm, t.a.memberId)).toEqual({ kind: 'treated', treatmentsLeft: 0 });
    expect(ill()).toBe(false);
    expect((await myOrigin(t, t.a)).illness).toEqual({ treatmentsLeft: 0 });
    expect(treatChronicIllness(server!.orm, t.a.memberId)).toEqual({ kind: 'not_ill' });
    expect(treatChronicIllness(server!.orm, t.b.memberId)).toEqual({ kind: 'not_ill' });

    // Restricted places: the barracks (not the noble's own spawn place) opens to A, not to B.
    const toBarracks = (seat: Seat) => travel(server!.orm, assets, gameId, seat.memberId, { to: 'ค่ายทหารป้องกันเมือง' }, CLOCK);
    expect(toBarracks(t.b)).toMatchObject({ ok: false, code: 'restricted' });
    expect(toBarracks(t.a)).toMatchObject({ ok: true, place: { id: 'barracks' } });
  });

  it('C4: in a phase, a successful HEAL counts as a treatment; a failed one does not', async () => {
    await boot(new ScriptedRng([SICKLY, MUSICIAN, MUSICIAN]));
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t.a);
    const noEffects = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };
    const heal = (actionId: string, dc: 5 | 23): PhaseAction => ({
      actorId: t.a.memberId,
      proposal: {
        actionId,
        kind: 'general',
        tags: [],
        opposed: false,
        staminaCost: 3,
        visibility: 'public',
        target: null,
        check: { type: 'dc', dc },
        modifiers: [],
        witnessNpcIds: [],
        repDeltaIfCaught: 0,
        onSuccess: noEffects,
        onFail: noEffects,
        reason: 'ดื่มยาสมุนไพร',
        tagging: { verbTags: ['HEAL'], targetTags: [], activate: [] },
      },
      targetPlayer: null,
      moveTo: null,
      awareness: 'normal',
    });
    const illnessLeft = () => dbRow<{ illness_left: number }>('select illness_left from character_origin where member_id = ?', t.a.memberId).illness_left;

    const failed = applyPhaseActions(server!.orm, gameId, [heal('fail', 23)], new ReplayRng([10, 2]), CLOCK, { assets, day: 1 });
    expect(failed.ok, JSON.stringify(!failed.ok && failed.errors)).toBe(true);
    expect(illnessLeft()).toBe(2);
    const healed = applyPhaseActions(server!.orm, gameId, [heal('ok', 5)], new ReplayRng([10, 15]), CLOCK, { assets, day: 1 });
    expect(healed.ok, JSON.stringify(!healed.ok && healed.errors)).toBe(true);
    expect(illnessLeft()).toBe(1);
  });

  it('C5: the start Passive is a d20 bonus through tag matching when its condition holds (PERSUADE in a PUBLIC place)', async () => {
    await boot(new ScriptedRng([MUSICIAN, DISHWASHER, DISHWASHER]));
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t.a);
    const bonusFor = (verb: string) => {
      const ctx = tagContexts(server!.orm, gameId, crossPlayerState(server!.orm, gameId, new Set(), assets), { assets, day: 1 })[t.a.memberId]!;
      return applyTagging(ctx, { verbTags: [verb], targetTags: [], activate: [] }).bonuses.filter((b) => b.kind === 'start_passive');
    };

    expect(bonusFor('PERSUADE')).toEqual([{ kind: 'start_passive', ref: 'start:นักดนตรีพเนจรตกอับ', trigger: 'passive', value: 2 }]);
    expect(bonusFor('OBSERVE')).toHaveLength(1);
    expect(bonusFor('ATTACK')).toEqual([]);
    // The inn is not PUBLIC: no bonus there.
    moveCharacter(server!.orm, t.a.memberId, 'inn', CLOCK);
    expect(bonusFor('PERSUADE')).toEqual([]);
    // B (the dishwasher) has no d20 passive at all.
    const ctxB = tagContexts(server!.orm, gameId, crossPlayerState(server!.orm, gameId, new Set(), assets), { assets, day: 1 })[t.b.memberId]!;
    expect(ctxB.sources.filter((s) => s.kind === 'start_passive')).toEqual([]);
  });

  it('C5: a Passive limited to days 1-3 (the slime survivor) stops on day 4', async () => {
    await boot(new ScriptedRng([SLIME, MUSICIAN, MUSICIAN]));
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t.a);
    const attackBonus = (day: number) => {
      const ctx = tagContexts(server!.orm, gameId, crossPlayerState(server!.orm, gameId, new Set(), assets), { assets, day })[t.a.memberId]!;
      return applyTagging(ctx, { verbTags: ['ATTACK'], targetTags: [], activate: [] }).bonuses.filter((b) => b.kind === 'start_passive');
    };
    expect(presence(t.a)).toBe('forest');
    expect(attackBonus(1)).toEqual([{ kind: 'start_passive', ref: 'start:ผู้รอดชีวิตจากท้องสไลม์', trigger: 'passive', value: 3 }]);
    expect(attackBonus(3)).toHaveLength(1);
    expect(attackBonus(4)).toEqual([]);
  });

  it('C6: after a restart the start scenario and its narration stay; nothing is rolled or narrated again', async () => {
    const first = new ScriptedRng([MUSICIAN, DISHWASHER, ASTRAL]);
    await boot(first);
    const t = await startedTable(server!, false);
    const before = await myOrigin(t, t.a);
    expect(before.narration).not.toBeNull();
    const narrations = requests.filter(isNarration).length;
    await server!.close();

    const second = new ScriptedRng([SICKLY, SICKLY, SICKLY]);
    await boot(second);
    const after = await myOrigin({ ...t, call: caller(server!) }, t.a);
    expect(after).toEqual(before);
    expect(second.draws).toEqual([]);
    expect(requests.filter(isNarration).length).toBe(narrations);
    expect(first.draws).toHaveLength(3);
  });

  it('C7: what the player gets has no Karma number', async () => {
    await boot(new ScriptedRng([MUSICIAN, DISHWASHER, ASTRAL]));
    const t = await startedTable(server!, false);
    for (const path of ['/api/game/origin', '/api/game/character']) {
      const res = await t.call('GET', path, { token: t.a.token });
      expect(forbiddenKeysIn(res.body), path).toEqual([]);
      expect(JSON.stringify(res.body), path).not.toMatch(/karma|กรรม/i);
    }
  });

  it('C8: A\'s crossing narration reaches only A, from A\'s personality, with no real name in the prompt', async () => {
    await boot(new ScriptedRng([MUSICIAN, DISHWASHER, ASTRAL]));
    const t = await startedTable(server!, false);
    const mine = await myOrigin(t, t.a);
    expect(mine.narration).toContain(t.a.name);

    const narrationsAsked = requests.filter(isNarration);
    expect(narrationsAsked).toHaveLength(3);
    const promptA = narrationsAsked.find((r) => promptOf(r).includes(t.a.personality))!;
    expect(promptA).toBeDefined();
    expect(promptOf(promptA)).toContain('น้ำพุกลางเมือง');
    for (const r of narrationsAsked) {
      for (const seat of [t.a, t.b, t.c]) expect(promptOf(r)).not.toContain(seat.name);
    }
    for (const other of [t.b, t.c]) {
      const theirs = await myOrigin(t, other);
      expect(theirs.narration).not.toBe(mine.narration);
      expect(theirs.narration).not.toContain(t.a.name);
    }
  });

  it('C8: the AI is down at the start: the start scenario is set anyway, the narration is written later without a new roll', async () => {
    narrationWorks = false;
    const rng = new ScriptedRng([MUSICIAN, DISHWASHER, ASTRAL]);
    await boot(rng);
    const t = await startedTable(server!, false);
    expect(presence(t.a)).toBe('fountain');
    expect(dbRow<{ narration: string | null }>('select narration from character_origin where member_id = ?', t.a.memberId).narration).toBeNull();

    narrationWorks = true;
    const mine = await myOrigin(t, t.a);
    expect(mine.narration).toContain(t.a.name);
    expect(mine.location.id).toBe('fountain');
    expect(rng.draws).toHaveLength(3);
    // Read again: the stored narration, no new call.
    const calls = requests.filter(isNarration).length;
    expect((await myOrigin(t, t.a)).narration).toBe(mine.narration);
    expect(requests.filter(isNarration).length).toBe(calls);
  });
});
