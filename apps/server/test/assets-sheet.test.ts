import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REQUIRED_TABS, TAB_FILES, type TabName } from '../src/assets/model.ts';
import { AssetImportError, SheetUnreachableError, runAssetImport } from '../src/assets/sheet.ts';
import { fixtureCsv, setCell } from './assets-fixture.ts';
import { makeTempDir } from './helpers.ts';

const SHEET = 'test-sheet-id';

/**
 * A stand-in for docs.google.com: /htmlview lists the tabs (name + gid) the way the real page
 * does, and /export?format=csv&gid=<gid> answers each tab's CSV. No network.
 */
function fakeGoogle(csvByTab: Partial<Record<TabName, string>>, opts: { status?: number } = {}) {
  const tabs = Object.entries(csvByTab).map(([name, csv], i) => ({ name, csv: csv!, gid: String(1000 + i) }));
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (opts.status && opts.status !== 200) {
      return new Response('<html>Sign in</html>', { status: opts.status, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === `/spreadsheets/d/${SHEET}/htmlview`) {
      const items = tabs
        .map((t) => `items.push({name: "${t.name}", pageUrl: "https:\\/\\/docs.google.com\\/x?gid=${t.gid}", gid: "${t.gid}",initialSheet: false});`)
        .join('\n');
      return new Response(`<html><script>${items}</script></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === `/spreadsheets/d/${SHEET}/export` && url.searchParams.get('format') === 'csv') {
      const tab = tabs.find((t) => t.gid === url.searchParams.get('gid'));
      if (tab) return new Response(tab.csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } });
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  };
  return { fetchImpl, calls };
}

function requiredFixtures(): Partial<Record<TabName, string>> {
  const all = fixtureCsv();
  return Object.fromEntries(REQUIRED_TABS.map((tab) => [tab, all[tab]!]));
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
}

describe('runAssetImport: sheet → JSON files (GEN-062)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  it('C1: writes one JSON file per tab, each holding one record per sheet row', async () => {
    const { fetchImpl } = fakeGoogle(requiredFixtures());
    const report = await runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });

    expect(readdirSync(dir).sort()).toEqual(REQUIRED_TABS.map((t) => TAB_FILES[t]).sort());
    expect(report.importedTabs).toEqual([...REQUIRED_TABS]);
    expect(report.missingTabs).toEqual(['NPC_Schedule', 'Day10_Strategies']);
    const abilities = JSON.parse(readFileSync(join(dir, TAB_FILES.Ability), 'utf8')) as unknown[];
    expect(abilities).toHaveLength(3);
  });

  it('C1: an optional tab that exists is imported too', async () => {
    const { fetchImpl } = fakeGoogle({ ...requiredFixtures(), NPC_Schedule: fixtureCsv().NPC_Schedule! });
    const report = await runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });

    expect(report.importedTabs).toContain('NPC_Schedule');
    expect(readdirSync(dir)).toContain(TAB_FILES.NPC_Schedule);
  });

  it('reads each tab by its gid from the CSV export (no key, no login)', async () => {
    const { fetchImpl, calls } = fakeGoogle(requiredFixtures());
    await runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });

    expect(calls[0]).toBe(`https://docs.google.com/spreadsheets/d/${SHEET}/htmlview`);
    expect(calls.filter((c) => c.includes('/export?format=csv&gid='))).toHaveLength(7);
    expect(calls.join('\n')).not.toMatch(/key=|token=/);
  });

  // C6: importing again with an unchanged sheet gives no diff.
  it('C6: importing twice from an unchanged sheet gives byte-identical files', async () => {
    const { fetchImpl } = fakeGoogle({ ...requiredFixtures(), NPC_Schedule: fixtureCsv().NPC_Schedule! });
    await runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });
    const first = snapshot(dir);
    const report = await runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });

    expect(snapshot(dir)).toEqual(first);
    expect(report.changedFiles).toEqual([]);
  });

  it('C6: a checkout with CRLF line endings (Windows autocrlf) counts as unchanged', async () => {
    const { fetchImpl } = fakeGoogle(requiredFixtures());
    await runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });
    for (const file of readdirSync(dir)) {
      writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8').replace(/\n/g, '\r\n'));
    }

    const report = await runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });
    expect(report.changedFiles).toEqual([]);
  });

  // C8: the sheet cannot be reached / Then a clear error, and the old JSON is not overwritten.
  it('C8: a sheet that answers 401 (not shared) gives a clear error and leaves the old JSON alone', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, TAB_FILES.Ability), '["old"]\n');
    const { fetchImpl } = fakeGoogle(requiredFixtures(), { status: 401 });

    const attempt = runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });

    await expect(attempt).rejects.toBeInstanceOf(SheetUnreachableError);
    await expect(attempt).rejects.toThrow(/401/);
    await expect(attempt).rejects.toThrow(/ทุกคนที่มีลิงก์/);
    expect(snapshot(dir)).toEqual({ [TAB_FILES.Ability]: '["old"]\n' });
  });

  it('C8: a network failure gives a clear error and leaves the old JSON alone', async () => {
    writeFileSync(join(dir, TAB_FILES.Ability), '["old"]\n');
    const offline = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };

    await expect(runAssetImport({ sheetId: SHEET, outDir: dir, fetch: offline })).rejects.toBeInstanceOf(SheetUnreachableError);
    expect(snapshot(dir)).toEqual({ [TAB_FILES.Ability]: '["old"]\n' });
  });

  it('C3/C4: a sheet with errors writes nothing and the error lists every issue', async () => {
    writeFileSync(join(dir, TAB_FILES.Ability), '["old"]\n');
    const csv = requiredFixtures();
    const { fetchImpl } = fakeGoogle({
      ...csv,
      Ability: setCell(csv.Ability!, 3, 'Rank', 'C'),
      Start_Scenarios: setCell(csv.Start_Scenarios!, 2, 'Rate', '90.00%'),
    });

    const attempt = runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });

    await expect(attempt).rejects.toBeInstanceOf(AssetImportError);
    await expect(attempt).rejects.toThrow(/Ability แถว 3 คอลัมน์ "Rank"/);
    await expect(attempt).rejects.toThrow(/98\.25/);
    expect(snapshot(dir)).toEqual({ [TAB_FILES.Ability]: '["old"]\n' });
  });

  it('C5: reference warnings do not stop the import and come back in the report', async () => {
    const csv = requiredFixtures();
    const { fetchImpl } = fakeGoogle({ ...csv, NPC: setCell(csv.NPC!, 3, 'Rewards & Abilities', 'มอบ Missing Charm (B)') });

    const report = await runAssetImport({ sheetId: SHEET, outDir: dir, fetch: fetchImpl });

    expect(report.warnings.join('\n')).toMatch(/NPC แถว 3 คอลัมน์ "Rewards & Abilities".*Missing Charm/);
    expect(readdirSync(dir)).toHaveLength(7);
  });
});
