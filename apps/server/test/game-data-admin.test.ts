import {
  AdminSessionResponse,
  ApiError,
  GameDataAuditResponse,
  GameDataExportResponse,
  GameDataListResponse,
  GameDataSetResponse,
} from '@isekai/protocol';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_SET_FILES, DATA_SETS, DEFAULT_ASSETS_DIR, loadGameAssets, type DataSetName, type GameAssets } from '../src/assets/load.ts';
import { hashPin } from '../src/auth/pin.ts';
import { CREATE_CODE_LIMIT } from '../src/game/create-code.ts';
import { loadAiConfig } from '../src/ai/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { npcsMetBy } from '../src/travel/service.ts';
import { makeTempDir } from './helpers.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, type Call } from './visibility-fixture.ts';

// GEN-147: all game data lives in the DB (seeded once from apps/server/assets), editable by the server owner at /admin.

/** A throwaway admin code for this test only. */
const ADMIN_CODE = 'ทดสอบ-ข้อมูลเกม-147';

const readFile = (name: DataSetName): unknown => JSON.parse(readFileSync(join(DEFAULT_ASSETS_DIR, DATA_SET_FILES[name]), 'utf8').replace(/\r\n/g, '\n'));

/** The data part of a GameAssets (arrays only, no lookups), to compare two loads. */
const dataOf = (a: GameAssets) => ({
  abilities: a.abilities,
  items: a.items,
  npcs: a.npcs,
  locations: a.locations,
  startScenarios: a.startScenarios,
  systemRules: a.systemRules,
  worldTimeline: a.worldTimeline,
  npcSchedule: a.npcSchedule,
  day10Strategies: a.day10Strategies,
  karmaTiers: a.karmaTiers,
  serverLines: a.serverLines,
  voice: a.voice,
  appearanceOptions: a.appearanceOptions,
});

const ASSET_KEY: Record<DataSetName, keyof ReturnType<typeof dataOf>> = {
  Ability: 'abilities',
  Item: 'items',
  NPC: 'npcs',
  Location: 'locations',
  Start_Scenarios: 'startScenarios',
  System_Rules: 'systemRules',
  World_Timeline: 'worldTimeline',
  NPC_Schedule: 'npcSchedule',
  Day10_Strategies: 'day10Strategies',
  Server_Lines: 'serverLines',
  Voice: 'voice',
  Appearance_Options: 'appearanceOptions',
};

describe('game data in the DB + admin editor (GEN-147)', { timeout: 120_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function boot() {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(dataDir, 'isekai.sqlite'), createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null },
    );
    call = caller(server);
    return server;
  }

  async function restart() {
    await server!.close();
    server = undefined;
    return boot();
  }

  async function adminToken(): Promise<string> {
    const res = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AdminSessionResponse.parse(res.body).token;
  }

  async function getSet(token: string, name: DataSetName) {
    const res = await call('GET', `/api/admin/game-data/${name}`, { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return GameDataSetResponse.parse(res.body);
  }

  async function save(token: string, name: DataSetName, value: unknown) {
    return call('PUT', `/api/admin/game-data/${name}`, { token, body: { value } });
  }

  async function audit(token: string) {
    const res = await call('GET', '/api/admin/game-data-audit', { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return GameDataAuditResponse.parse(res.body).entries;
  }

  const backupsDir = () => join(dataDir, 'backups', 'game-data');
  const backups = () => {
    try {
      return readdirSync(backupsDir());
    } catch {
      return [];
    }
  };

  /** One more NPC_Schedule row: โนอา at the inn in every period and weather. */
  const scheduleWithNoaAtInn = (value: unknown) => [
    ...(value as unknown[]),
    { npc: 'โนอา', location: 'โรงเตี๊ยมและกิลด์นักเดินทาง', periods: [], weathers: [], condition: '', note: 'GEN-147 test' },
  ];

  it('C1: no token, a player token or a wrong code gets no data; too many wrong codes lock the code for a while', async () => {
    await boot();
    for (const [method, path] of [
      ['GET', '/api/admin/game-data'],
      ['GET', '/api/admin/game-data/NPC'],
      ['PUT', '/api/admin/game-data/NPC'],
      ['POST', '/api/admin/game-data/NPC/undo'],
      ['GET', '/api/admin/game-data-audit'],
      ['GET', '/api/admin/game-data-export'],
    ] as const) {
      const res = await call(method, path, method === 'PUT' ? { body: { value: [] } } : {});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(ApiError.parse(res.body).code).toBe('forbidden');
    }
    const t = await startedTable(server!, false);
    expect((await call('GET', '/api/admin/game-data', { token: t.a.token })).status).toBe(403);
    expect((await call('GET', '/api/admin/game-data', { token: 'not-a-token' })).status).toBe(403);

    for (let i = 0; i < CREATE_CODE_LIMIT.maxFailures; i++) {
      const wrong = await call('POST', '/api/admin/session', { body: { code: `ผิด-${i}` } });
      expect(wrong.status).toBe(403);
    }
    const locked = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    expect(locked.status).toBe(429);
    expect(ApiError.parse(locked.body).code).toBe('too_many_attempts');
    // The data is untouched by any of this.
    expect(server!.assets.npcs).toEqual(loadGameAssets().npcs);
  });

  it('C2: an empty DB is seeded from every asset file and equals the files', async () => {
    await boot();
    const token = await adminToken();
    const list = GameDataListResponse.parse((await call('GET', '/api/admin/game-data', { token })).body);
    expect(list.sets.map((s) => s.name).sort()).toEqual([...DATA_SETS].sort());
    for (const name of DATA_SETS) {
      const set = await getSet(token, name);
      expect(set.value, name).toEqual(readFile(name));
      expect(set.set.file).toBe(DATA_SET_FILES[name]);
      // GEN-176: Voice is one object, not a list of records.
      const file = readFile(name);
      expect(set.set.records).toBe(Array.isArray(file) ? file.length : 0);
      expect(set.set.canUndo).toBe(false);
    }
    expect(dataOf(server!.assets)).toEqual(dataOf(loadGameAssets()));
    const rows = server!.db.prepare('select count(*) as n from game_data_set').get() as { n: number };
    expect(rows.n).toBe(DATA_SETS.length);
  });

  it('C3: edited data survives a restart / new deploy; the seed never overwrites it and the files stay as they were', async () => {
    await boot();
    const token = await adminToken();
    const before = await getSet(token, 'NPC_Schedule');
    const edited = scheduleWithNoaAtInn(before.value);
    expect((await save(token, 'NPC_Schedule', edited)).status).toBe(200);

    await restart();
    const after = await getSet(await adminToken(), 'NPC_Schedule');
    expect(after.value).toEqual(edited);
    expect(server!.assets.npcSchedule).toHaveLength((before.value as unknown[]).length + 1);
    // The asset file is the first-time seed only: unchanged.
    expect(readFile('NPC_Schedule')).toEqual(before.value);
  });

  it('C3: migration 0037 only adds tables / indexes (never drops, alters or deletes data)', () => {
    const dir = join(DEFAULT_ASSETS_DIR, '..', 'drizzle');
    const files = readdirSync(dir).filter((f) => /^0037_game_data\.sql$/.test(f));
    expect(files).toHaveLength(1);
    const sql = readFileSync(join(dir, files[0]!), 'utf8').replace(/\r\n/g, '\n');
    expect(sql).toMatch(/CREATE TABLE `game_data_set`/);
    expect(sql).toMatch(/CREATE TABLE `game_data_audit`/);
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|ALTER)\b/i);
  });

  it('C4: a valid NPC_Schedule edit is saved and a running game sees it from its next read; a new game too', async () => {
    await boot();
    const token = await adminToken();
    const t = await startedTable(server!, false);
    const gameId = (server!.db.prepare('select game_id as g from member where id = ?').get(t.b.memberId) as { g: string }).g;
    // B starts at the inn in EOSORIA: nobody is scheduled there then.
    expect(npcsMetBy(server!.orm, server!.assets, gameId, t.b.memberId)).not.toContain('โนอา');

    const res = await save(token, 'NPC_Schedule', scheduleWithNoaAtInn((await getSet(token, 'NPC_Schedule')).value));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Same assets object the room and the GM loop hold: the next turn reads the new schedule.
    expect(npcsMetBy(server!.orm, server!.assets, gameId, t.b.memberId)).toContain('โนอา');

    const t2 = await startedTable(server!, false);
    const game2 = (server!.db.prepare('select game_id as g from member where id = ?').get(t2.b.memberId) as { g: string }).g;
    expect(npcsMetBy(server!.orm, server!.assets, game2, t2.b.memberId)).toContain('โนอา');
  });

  it('C5: data that breaks the schema is refused with the wrong fields; the old value, audit log and backups stay', async () => {
    await boot();
    const token = await adminToken();
    const before = await getSet(token, 'NPC_Schedule');
    const broken = (before.value as Record<string, unknown>[]).map((row, i) => (i === 1 ? { ...row, periods: ['LUNCHTIME'], npc: '' } : row));

    const res = await save(token, 'NPC_Schedule', broken);
    expect(res.status).toBe(400);
    const error = ApiError.parse(res.body);
    expect(error.code).toBe('invalid_input');
    const fields = error.code === 'invalid_input' ? Object.keys(error.fields) : [];
    expect(fields).toEqual(expect.arrayContaining(['[1].npc', '[1].periods[0]']));

    // Not an array at all; and a set that does not exist.
    expect((await save(token, 'NPC_Schedule', { not: 'a list' })).status).toBe(400);
    expect((await save(token, 'Ability', [{ name: 'ไม่มีฟิลด์อื่น' }])).status).toBe(400);
    const missing = await save(token, 'Nope' as DataSetName, []);
    expect(missing.status).toBe(404);
    expect(ApiError.parse(missing.body).code).toBe('data_set_not_found');

    expect((await getSet(token, 'NPC_Schedule')).value).toEqual(before.value);
    expect(server!.assets.npcSchedule).toEqual(loadGameAssets().npcSchedule);
    expect(await audit(token)).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it('C6: a save writes a backup of the old value first and one audit row (what, old, new, time)', async () => {
    await boot();
    const token = await adminToken();
    const before = await getSet(token, 'NPC_Schedule');
    const edited = scheduleWithNoaAtInn(before.value);
    const res = await save(token, 'NPC_Schedule', edited);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(GameDataSetResponse.parse(res.body).set.canUndo).toBe(true);

    const files = backups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^NPC_Schedule-/);
    expect(JSON.parse(readFileSync(join(backupsDir(), files[0]!), 'utf8'))).toEqual(before.value);

    const entries = await audit(token);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'NPC_Schedule', action: 'edit', at: new Date(CLOCK).toISOString(), backupFile: files[0] });
    expect(entries[0]!.changes).toEqual([{ index: (before.value as unknown[]).length, old: null, new: edited.at(-1) }]);
  });

  it('C7: undo brings the value back (also to the running server) and adds a log row; nothing left = 409', async () => {
    await boot();
    const token = await adminToken();
    const original = (await getSet(token, 'NPC_Schedule')).value;
    const first = scheduleWithNoaAtInn(original);
    const second = (first as Record<string, unknown>[]).slice(1);
    expect((await save(token, 'NPC_Schedule', first)).status).toBe(200);
    expect((await save(token, 'NPC_Schedule', second)).status).toBe(200);

    const undo1 = await call('POST', '/api/admin/game-data/NPC_Schedule/undo', { token });
    expect(undo1.status, JSON.stringify(undo1.body)).toBe(200);
    expect(GameDataSetResponse.parse(undo1.body).value).toEqual(first);
    expect(server!.assets.npcSchedule).toHaveLength(first.length);

    const undo2 = await call('POST', '/api/admin/game-data/NPC_Schedule/undo', { token });
    expect(GameDataSetResponse.parse(undo2.body).value).toEqual(original);
    expect(GameDataSetResponse.parse(undo2.body).set.canUndo).toBe(false);
    expect(server!.assets.npcSchedule).toEqual(loadGameAssets().npcSchedule);

    const none = await call('POST', '/api/admin/game-data/NPC_Schedule/undo', { token });
    expect(none.status).toBe(409);
    expect(ApiError.parse(none.body).code).toBe('not_allowed');

    const entries = await audit(token);
    expect(entries.map((e) => e.action)).toEqual(['undo', 'undo', 'edit', 'edit']);
    expect(backups()).toHaveLength(4);
  });

  it('C8: the export loads back with the existing loader and equals the DB', async () => {
    await boot();
    const token = await adminToken();
    expect((await save(token, 'NPC_Schedule', scheduleWithNoaAtInn((await getSet(token, 'NPC_Schedule')).value))).status).toBe(200);

    const res = await call('GET', '/api/admin/game-data-export', { token });
    expect(res.status).toBe(200);
    const exported = GameDataExportResponse.parse(res.body);
    expect(Object.keys(exported.files).sort()).toEqual(DATA_SETS.map((n) => DATA_SET_FILES[n]).sort());
    const dir = join(dataDir, 'export');
    mkdirSync(dir);
    for (const [file, value] of Object.entries(exported.files)) writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
    expect(dataOf(loadGameAssets(dir))).toEqual(dataOf(server!.assets));
    for (const name of DATA_SETS) expect(exported.files[DATA_SET_FILES[name]], name).toEqual((await getSet(token, name)).value);
  });

  it.each([...DATA_SETS])('C9: %s is editable through the server and takes effect', async (name) => {
    await boot();
    const token = await adminToken();
    if (name === 'Voice') {
      const voice = (await getSet(token, name)).value as { guide: Record<string, unknown> };
      const editedVoice = { ...voice, guide: { ...voice.guide, voice: 'ผู้เล่าเรื่อง (แก้จาก admin)' } };
      expect((await save(token, name, editedVoice)).status).toBe(200);
      expect(server!.assets.voice.guide.voice).toBe('ผู้เล่าเรื่อง (แก้จาก admin)');
      return;
    }
    const value = (await getSet(token, name)).value as Record<string, unknown>[];
    const edited =
      name === 'Server_Lines'
        ? value.map((row, i) => (i === 0 ? { ...row, text: `${String(row.text)} (แก้จาก admin)` } : row))
        : name === 'Appearance_Options'
          ? value.map((row, i) => (i === 0 ? { ...row, label: `${String(row.label)} (แก้จาก admin)` } : row))
          : value.map((row, i) => (i === 0 ? { ...row, extra: { ...((row.extra as Record<string, string>) ?? {}), admin_note: 'แก้จาก admin' } } : row));
    const res = await save(token, name, edited);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getSet(token, name)).value).toEqual(edited);
    const live = server!.assets[ASSET_KEY[name]] as readonly Record<string, unknown>[];
    if (name === 'Server_Lines') expect(live[0]!.text).toMatch(/\(แก้จาก admin\)$/);
    else if (name === 'Appearance_Options') expect(live[0]!.label).toMatch(/\(แก้จาก admin\)$/);
    else expect(live[0]!.extra).toMatchObject({ admin_note: 'แก้จาก admin' });
  });

  describe('GEN-192: the Voice form edits through the same API', () => {
    type Voice = { forbidden: { match: { type: string; value?: string } }[]; npcs: Record<string, { self: string[]; forms?: Record<string, unknown> }> };

    it('C1: the list counts the Voice rules and NPC profiles (not 0 rows); list sets have no parts', async () => {
      await boot();
      const token = await adminToken();
      const file = readFile('Voice') as Voice;
      const list = GameDataListResponse.parse((await call('GET', '/api/admin/game-data', { token })).body);
      expect(list.sets.find((s) => s.name === 'Voice')!.parts).toEqual({ forbidden: file.forbidden.length, npcs: Object.keys(file.npcs).length });
      expect(list.sets.find((s) => s.name === 'NPC')!.parts).toBeUndefined();
      expect((await getSet(token, 'Voice')).set.parts).toEqual({ forbidden: file.forbidden.length, npcs: Object.keys(file.npcs).length });
    });

    it('C2: a pronoun edit of one NPC profile is saved with a backup and an audit row; its SS forms stay', async () => {
      await boot();
      const token = await adminToken();
      const voice = (await getSet(token, 'Voice')).value as Voice;
      const edited = { ...voice, npcs: { ...voice.npcs, beggar: { ...voice.npcs.beggar!, self: ['หนู'] } } };
      const res = await save(token, 'Voice', edited);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(server!.assets.voice.npcs.beggar!.self).toEqual(['หนู']);
      expect(server!.assets.voice.npcs.beggar!.forms).toEqual(loadGameAssets().voice.npcs.beggar!.forms);
      expect(((await getSet(token, 'Voice')).value as Voice).npcs.beggar!.forms).toEqual(voice.npcs.beggar!.forms);
      const entries = await audit(token);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ name: 'Voice', action: 'edit' });
      expect(backups()).toHaveLength(1);
    });

    it('C3: a regex that does not compile is refused at its field; nothing is saved', async () => {
      await boot();
      const token = await adminToken();
      const voice = (await getSet(token, 'Voice')).value as Voice;
      const i = voice.forbidden.findIndex((r) => r.match.type === 'regex');
      const broken = { ...voice, forbidden: voice.forbidden.map((r, j) => (j === i ? { ...r, match: { type: 'regex', value: '(ทำการ' } } : r)) };
      const res = await save(token, 'Voice', broken);
      expect(res.status).toBe(400);
      const error = ApiError.parse(res.body);
      expect(error.code === 'invalid_input' ? Object.keys(error.fields) : []).toEqual([`forbidden[${i}].match.value`]);
      expect((await getSet(token, 'Voice')).value).toEqual(voice);
      expect(await audit(token)).toEqual([]);
    });
  });

  describe('GEN-179: a DB set that a new schema no longer accepts falls back to its asset file', () => {
    const npcRow = () => (server!.db.prepare("select json from game_data_set where name = 'NPC'").get() as { json: string }).json;
    /** Simulates a deploy whose schema change rejects the saved NPC edit: [0].grade is not a rank any more. */
    async function bootWithStaleNpc() {
      await boot();
      const npcs = JSON.parse(npcRow()) as Record<string, unknown>[];
      npcs[0] = { ...npcs[0], grade: 'Z' };
      server!.db.prepare("update game_data_set set json = ? where name = 'NPC'").run(JSON.stringify(npcs));
      const stale = npcRow();
      const warnings: string[] = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void warnings.push(String(line)));
      try {
        await restart();
      } finally {
        spy.mockRestore();
      }
      return { stale, warnings };
    }

    it('C1: the server starts on the NPC file; the DB row stays as it was; the log names the set', async () => {
      const { stale, warnings } = await bootWithStaleNpc();
      expect(server!.assets.npcs).toEqual(loadGameAssets().npcs);
      expect(npcRow()).toBe(stale);
      expect(warnings.join('\n')).toMatch(/NPC/);
      expect(warnings.join('\n')).toMatch(/\[0\]\.grade/);
      // Other sets still save while NPC is on its file.
      const token = await adminToken();
      expect((await save(token, 'NPC_Schedule', scheduleWithNoaAtInn((await getSet(token, 'NPC_Schedule')).value))).status).toBe(200);
      expect(npcRow()).toBe(stale);
    });

    it('C2 / C3: /admin names the set + wrong fields; a fixed save uses the DB again and clears the warning', async () => {
      await bootWithStaleNpc();
      const token = await adminToken();
      const listed = async () => {
        const res = await call('GET', '/api/admin/game-data', { token });
        expect(res.status).toBe(200);
        return GameDataListResponse.parse(res.body).sets.find((s) => s.name === 'NPC')!;
      };
      const npc = await listed();
      expect(npc.fallback?.fields).toHaveProperty(['[0].grade']);
      expect((await getSet(token, 'NPC')).set.fallback).toBeDefined();
      expect((await getSet(token, 'NPC_Schedule')).set.fallback).toBeUndefined();

      const fixed = (JSON.parse(npcRow()) as Record<string, unknown>[]).map((row, i) => (i === 0 ? { ...row, grade: 'S', extra: { admin_note: 'แก้แล้ว' } } : row));
      const res = await save(token, 'NPC', fixed);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await listed()).fallback).toBeUndefined();
      expect(server!.assets.npcs[0]).toMatchObject({ grade: 'S', extra: { admin_note: 'แก้แล้ว' } });
      await restart();
      expect(server!.assets.npcs[0]).toMatchObject({ grade: 'S' });
    });
  });
});
