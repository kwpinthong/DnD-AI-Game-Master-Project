import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLoadError, DEFAULT_ASSETS_DIR, loadGameAssets } from '../src/assets/load.ts';
import { REQUIRED_TABS, TAB_FILES } from '../src/assets/model.ts';
import { startServer } from '../src/server.ts';
import { freePort, isListening, makeTempDir } from './helpers.ts';

// C7: Given server start / Then it loads the data from the JSON in the repo with no network;
// JSON that breaks the schema / Then start fails and names the file and the field.
describe('game assets at server start (GEN-062)', { timeout: 30_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  const fetchSpy = vi.fn(async () => {
    throw new Error('network is not allowed here');
  });

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
    cleanup();
  });

  it('C7: loads every required tab from the JSON committed in the repo, without the network', () => {
    const assets = loadGameAssets();

    expect(assets.abilities.length).toBeGreaterThan(0);
    expect(assets.items.length).toBeGreaterThan(0);
    expect(assets.npcs.length).toBeGreaterThan(0);
    expect(assets.locations.length).toBeGreaterThan(0);
    expect(assets.startScenarios.length).toBeGreaterThan(0);
    expect(assets.systemRules.length).toBeGreaterThan(0);
    expect(assets.worldTimeline.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('C7: the committed start scenarios add up to 100 percent', () => {
    const total = loadGameAssets().startScenarios.reduce((sum, s) => sum + s.rate, 0);
    expect(Math.round(total * 100) / 100).toBe(100);
  });

  it('C7: gives typed lookups by name', () => {
    const assets = loadGameAssets();
    const first = assets.abilities[0]!;

    expect(assets.ability(first.name)).toBe(first);
    expect(assets.ability('no such skill')).toBeUndefined();
    expect(assets.item(assets.items[0]!.nameEn)).toBe(assets.items[0]);
    expect(assets.location(assets.locations[0]!.name)).toBe(assets.locations[0]);
  });

  it('C7: startServer exposes the loaded assets and makes no network call', async () => {
    const server = await startServer({ host: '127.0.0.1', port: 0, dbPath: join(dir, 'isekai.sqlite') });
    try {
      expect(server.assets.abilities.length).toBeGreaterThan(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('C7: a JSON file that breaks the schema stops start-up and names the file and the field', async () => {
    const assetsDir = join(dir, 'assets');
    cpSync(DEFAULT_ASSETS_DIR, assetsDir, { recursive: true });
    const file = join(assetsDir, TAB_FILES.Ability);
    const records = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    records[1]!.rank = 'C';
    writeFileSync(file, JSON.stringify(records));
    const port = await freePort();

    const attempt = startServer({ host: '127.0.0.1', port, dbPath: join(dir, 'isekai.sqlite') }, { assetsDir });

    await expect(attempt).rejects.toBeInstanceOf(AssetLoadError);
    await expect(attempt).rejects.toThrow(TAB_FILES.Ability);
    await expect(attempt).rejects.toThrow('[1].rank');
    expect(await isListening(port)).toBe(false);
  });

  it('C7: a file that is not JSON, or a missing required file, names the file', () => {
    const assetsDir = join(dir, 'assets');
    cpSync(DEFAULT_ASSETS_DIR, assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, TAB_FILES.Item), '{ not json');
    expect(() => loadGameAssets(assetsDir)).toThrow(TAB_FILES.Item);

    cpSync(DEFAULT_ASSETS_DIR, assetsDir, { recursive: true });
    rmSync(join(assetsDir, TAB_FILES.NPC));
    expect(() => loadGameAssets(assetsDir)).toThrow(TAB_FILES.NPC);
  });

  it('an optional tab file that is absent is simply not loaded', () => {
    const assetsDir = join(dir, 'assets');
    cpSync(DEFAULT_ASSETS_DIR, assetsDir, { recursive: true });
    rmSync(join(assetsDir, TAB_FILES.Day10_Strategies), { force: true });

    const assets = loadGameAssets(assetsDir);
    expect(assets.day10Strategies).toBeUndefined();
    expect(REQUIRED_TABS).not.toContain('Day10_Strategies');
  });
});
