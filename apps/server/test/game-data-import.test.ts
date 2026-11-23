import { AdminSessionResponse, ApiError, GameDataAuditResponse, GameDataImportPreviewResponse, GameDataSetResponse } from '@isekai/protocol';
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_SET_FILES, DATA_SETS, DEFAULT_ASSETS_DIR, type DataSetName } from '../src/assets/load.ts';
import { hashPin } from '../src/auth/pin.ts';
import { loadAiConfig } from '../src/ai/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { caller, CLOCK, CREATE_CODE, type Call } from './visibility-fixture.ts';

// GEN-173: "นำเข้าจากไฟล์" — the admin takes a data set from the asset file (after `pnpm assets:import`) into an
// existing DB: a preview with the diff first, then the normal save (backup + audit + undo).

/** A throwaway admin code for this test only. */
const ADMIN_CODE = 'ทดสอบ-นำเข้า-173';

describe('import a data set from its asset file (GEN-173)', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;
  let token = '';
  const assetsDir = () => join(dir, 'assets');
  const backups = () => {
    try {
      return readdirSync(join(dir, 'backups', 'game-data'));
    } catch {
      return [];
    }
  };
  const readAsset = (name: DataSetName) => JSON.parse(readFileSync(join(assetsDir(), DATA_SET_FILES[name]), 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>[];
  const writeAsset = (name: DataSetName, value: unknown) => writeFileSync(join(assetsDir(), DATA_SET_FILES[name]), JSON.stringify(value, null, 2));

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    cpSync(DEFAULT_ASSETS_DIR, assetsDir(), { recursive: true });
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(dir, 'isekai.sqlite'), createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null, assetsDir: assetsDir() },
    );
    call = caller(server);
    const res = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    token = AdminSessionResponse.parse(res.body).token;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const getSet = async (name: DataSetName) => GameDataSetResponse.parse((await call('GET', `/api/admin/game-data/${name}`, { token })).body);
  const preview = (name: string) => call('GET', `/api/admin/game-data/${name}/asset-file`, { token });
  const audit = async () => GameDataAuditResponse.parse((await call('GET', '/api/admin/game-data-audit', { token })).body).entries;

  /** The sheet changed after the DB was seeded: Noa's first alias is new. */
  function newNpcFile() {
    const npcs = readAsset('NPC');
    const edited = npcs.map((n, i) => (i === 0 ? { ...n, aliases: [...(n.aliases as string[]), 'นก'] } : n));
    writeAsset('NPC', edited);
    return edited;
  }

  it('C1: a new NPC file shows the diff first; confirming saves it with a backup and one audit row', async () => {
    const before = (await getSet('NPC')).value;
    const edited = newNpcFile();

    const res = await preview('NPC');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const shown = GameDataImportPreviewResponse.parse(res.body);
    expect(shown.value).toEqual(edited);
    expect(shown.set.name).toBe('NPC');
    expect(shown.changes).toEqual([{ index: 0, old: (before as unknown[])[0], new: edited[0] }]);
    // The preview alone changes nothing.
    expect((await getSet('NPC')).value).toEqual(before);
    expect(backups()).toEqual([]);

    const saved = await call('PUT', '/api/admin/game-data/NPC', { token, body: { value: shown.value } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await getSet('NPC')).value).toEqual(edited);
    expect(server!.assets.npc('นก')?.name).toBe(edited[0]!.name);
    expect(backups()).toHaveLength(1);
    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'NPC', action: 'edit' });
  });

  it('C2: cancel (no confirm) leaves the DB, audit and backups as they were; the same file twice = no changes', async () => {
    const before = (await getSet('NPC')).value;
    expect(GameDataImportPreviewResponse.parse((await preview('NPC')).body).changes).toEqual([]);
    newNpcFile();
    expect((await preview('NPC')).status).toBe(200);
    expect((await getSet('NPC')).value).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it('C2: a file that breaks the schema is refused at the preview with the wrong fields; a missing set / no token too', async () => {
    writeAsset('NPC_Schedule', [{ npc: '', location: 'x', periods: ['LUNCHTIME'], weathers: [], condition: '', note: '' }]);
    const bad = await preview('NPC_Schedule');
    expect(bad.status).toBe(400);
    const error = ApiError.parse(bad.body);
    expect(error.code === 'invalid_input' ? Object.keys(error.fields) : []).toEqual(expect.arrayContaining(['[0].npc']));
    expect((await preview('Nope')).status).toBe(404);
    expect((await call('GET', '/api/admin/game-data/NPC/asset-file')).status).toBe(403);
    expect(await audit()).toEqual([]);
  });

  it('C3: undo after an import brings the old value back', async () => {
    const before = (await getSet('NPC')).value;
    const shown = GameDataImportPreviewResponse.parse((newNpcFile(), (await preview('NPC')).body));
    expect((await call('PUT', '/api/admin/game-data/NPC', { token, body: { value: shown.value } })).status).toBe(200);
    const undo = await call('POST', '/api/admin/game-data/NPC/undo', { token });
    expect(undo.status).toBe(200);
    expect((await getSet('NPC')).value).toEqual(before);
    expect(server!.assets.npc('นก')).toBeUndefined();
  });

  it('C4: importing NPC leaves every other data set as it was, even when its file changed too', async () => {
    const others = DATA_SETS.filter((n) => n !== 'NPC');
    const before = Object.fromEntries(await Promise.all(others.map(async (n) => [n, (await getSet(n)).value] as const)));
    writeAsset('Item', readAsset('Item').slice(1));
    const shown = GameDataImportPreviewResponse.parse((newNpcFile(), (await preview('NPC')).body));
    expect((await call('PUT', '/api/admin/game-data/NPC', { token, body: { value: shown.value } })).status).toBe(200);
    for (const n of others) expect((await getSet(n)).value, n).toEqual(before[n]);
    expect((await audit()).map((e) => e.name)).toEqual(['NPC']);
  });
});
