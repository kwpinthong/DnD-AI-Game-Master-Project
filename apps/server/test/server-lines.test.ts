import { SeededRng } from '@isekai/rules';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertSheet, formatIssue } from '../src/assets/import.ts';
import { AssetLoadError, DEFAULT_ASSETS_DIR, loadGameAssets } from '../src/assets/load.ts';
import type { NpcRecord } from '../src/assets/model.ts';
import { farewellLine, SERVER_LINES_FILE, SITUATION_SLOTS, serverLine, type ServerLineRecord, type Situation } from '../src/assets/server-lines.ts';
import { npcSpeaker } from '../src/companions/store.ts';
import { npcFarewellFor } from '../src/gm/server-lines.ts';
import type { RunningServer } from '../src/server.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import { npcBondsOf } from '../src/visibility/store.ts';
import { addColumnBefore, fixtureCsv, setCell } from './assets-fixture.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer } from './visibility-fixture.ts';

const LEFTOVER = /\{[^}]*\}/;
const assets = loadGameAssets();

describe('server message templates without AI (GEN-150)', () => {
  it('C1: a farewell comes from a template with no {..} slot left over', () => {
    const text = farewellLine(assets.serverLines, 'เด็กขอทาน', 'ไว้เจอกันนะ', new SeededRng(1));
    expect(text).toContain('เด็กขอทาน');
    expect(text).toContain('ไว้เจอกันนะ');
    expect(text).not.toMatch(LEFTOVER);
  });

  it('C1: every committed template of every situation fills to text with no {..} left', () => {
    const values = { npc: 'น', place: 'ที่', phase: 'ช่วง', farewell: 'ลา' };
    for (const situation of Object.keys(SITUATION_SLOTS) as Situation[]) {
      const rows = assets.serverLines.filter((l) => l.situation === situation);
      expect(rows.length, situation).toBeGreaterThanOrEqual(2);
      const rng = new SeededRng(7);
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(serverLine(assets.serverLines, situation, values, rng));
      expect(seen.size, situation).toBe(rows.length);
      for (const text of seen) expect(text, situation).not.toMatch(LEFTOVER);
    }
  });

  it('C2: with 3 templates the random pick reaches all of them (fixed seed)', () => {
    const lines: ServerLineRecord[] = [
      { situation: 'npc_arrive', text: 'หนึ่ง {npc} ที่ {place}' },
      { situation: 'npc_arrive', text: 'สอง {npc} ที่ {place}' },
      { situation: 'npc_arrive', text: 'สาม {npc} ที่ {place}' },
    ];
    const rng = new SeededRng(42);
    const picked = new Set(Array.from({ length: 30 }, () => serverLine(lines, 'npc_arrive', { npc: 'ก', place: 'ข' }, rng)));
    expect([...picked].sort()).toEqual(['สอง ก ที่ ข', 'สาม ก ที่ ข', 'หนึ่ง ก ที่ ข']);
  });

  it('C4: an NPC without its own farewell line gets a generic one; one with a line keeps it', () => {
    const generic = assets.serverLines.filter((l) => l.situation === 'generic_farewell').map((l) => l.text);
    const text = farewellLine(assets.serverLines, 'ลูเซีย', '', new SeededRng(3));
    expect(generic.some((g) => text.includes(g)), text).toBe(true);
    expect(text).not.toMatch(LEFTOVER);
    expect(farewellLine(assets.serverLines, 'ลูเซีย', 'ขอพรจงอยู่กับเจ้า', new SeededRng(3))).toContain('ขอพรจงอยู่กับเจ้า');
  });

  it('NPC tab: the optional Farewell column is read; a sheet without it gives an empty line', () => {
    const csv = fixtureCsv();
    const withColumn = setCell(addColumnBefore(csv.NPC!, 'Public_Alias', 'Farewell'), 2, 'Farewell', 'ลาก่อนนะพี่');
    const result = convertSheet({ ...csv, NPC: withColumn });
    expect(result.errors.map(formatIssue)).toEqual([]);
    const [first, second] = result.files.NPC as NpcRecord[];
    expect(first!.farewell).toBe('ลาก่อนนะพี่');
    expect(second!.farewell).toBe('');
    expect((convertSheet(csv).files.NPC as NpcRecord[])[0]!.farewell).toBe('');
    for (const npc of assets.npcs) expect(typeof npc.farewell).toBe('string');
  });
});

describe('C5: a broken template file stops loading (GEN-150)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });
  afterEach(() => cleanup());

  function loadWith(edit: (rows: Array<Record<string, unknown>>) => void) {
    const assetsDir = join(dir, 'assets');
    cpSync(DEFAULT_ASSETS_DIR, assetsDir, { recursive: true });
    const file = join(assetsDir, SERVER_LINES_FILE);
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    edit(rows);
    writeFileSync(file, JSON.stringify(rows));
    return () => loadGameAssets(assetsDir);
  }

  it.each([
    ['an unknown slot', (rows: Array<Record<string, unknown>>) => rows.push({ situation: 'npc_leave', text: '{npc} หยิบ {weapon} แล้วจากไป' }), '{weapon}'],
    ['a slot the situation does not have', (rows: Array<Record<string, unknown>>) => rows.push({ situation: 'time_announce', text: '{npc} บอกว่าถึง {phase}' }), '{npc}'],
    ['an empty text', (rows: Array<Record<string, unknown>>) => rows.push({ situation: 'farewell', text: '  ' }), 'text'],
    ['an unknown situation', (rows: Array<Record<string, unknown>>) => rows.push({ situation: 'npc_dance', text: '{npc} เต้นรำ' }), 'situation'],
  ])('C5: %s is an AssetLoadError naming the file', (_name, edit, mention) => {
    const load = loadWith(edit);
    expect(load).toThrow(AssetLoadError);
    expect(load).toThrow(SERVER_LINES_FILE);
    expect(load).toThrow(mention);
  });

  it('C5: a situation left with no template is an AssetLoadError', () => {
    const load = loadWith((rows) => rows.splice(0, rows.length, ...rows.filter((r) => r.situation !== 'npc_arrive')));
    expect(load).toThrow(AssetLoadError);
    expect(load).toThrow('npc_arrive');
  });
});

describe('C3: NPC names in server lines follow acquaintance (GEN-150, GEN-121)', { timeout: 60_000 }, () => {
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

  it('C3: a viewer who does not know the NPC reads its alias, not its real name; once known, the name', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    const known = new Set(npcBondsOf(server.orm, t.a.memberId).filter((b) => b.nameRevealed).map((b) => b.npcId));
    const npc = getGameScenario(server.orm, gameId)!.npcs.find((n) => !known.has(n.id) && n.alias !== '' && !n.alias.includes(n.name) && !n.name.includes(n.alias))!;
    expect(npc).toBeDefined();

    const before = npcFarewellFor(server.orm, server.assets, t.a.memberId, npc, new SeededRng(5));
    expect(before).toContain(npc.alias);
    expect(before).not.toContain(npc.name);
    expect(before).not.toMatch(LEFTOVER);

    server.db
      .prepare('insert into npc_bond (member_id, npc_id, name_revealed, updated_at) values (?, ?, 1, ?) on conflict (member_id, npc_id) do update set name_revealed = 1')
      .run(t.a.memberId, npc.id, CLOCK);
    // Known: the name GEN-121 shows this player (the sheet's real name), never the alias.
    const shown = npcSpeaker(server.orm, server.assets, t.a.memberId, npc.id)!.name;
    expect(shown).not.toBe(npc.alias);
    const after = npcFarewellFor(server.orm, server.assets, t.a.memberId, npc, new SeededRng(5));
    expect(after).toContain(shown);
    expect(after).not.toContain(npc.alias);
  });
});
