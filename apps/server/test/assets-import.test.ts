import { describe, expect, it } from 'vitest';
import { convertSheet, formatIssue } from '../src/assets/import.ts';
import { REQUIRED_TABS, type TabName, type AbilityRecord, type Day10StrategyRecord, type ItemRecord, type LocationRecord, type NpcRecord, type StartScenarioRecord } from '../src/assets/model.ts';
import { addColumnBefore, duplicateRow, fixtureCsv, keepColumnsBefore, setCell } from './assets-fixture.ts';

/** Data rows of a fixture CSV (lines after the header, blank lines left out). */
function dataRowCount(csv: string): number {
  return csv.trim().split('\n').length - 1;
}

function requiredOnly(): Partial<Record<TabName, string>> {
  const all = fixtureCsv();
  return Object.fromEntries(REQUIRED_TABS.map((tab) => [tab, all[tab]!]));
}

describe('convertSheet (GEN-062)', () => {
  // C1: Given the sheet / When import / Then 7 tabs, and each has as many records as data rows.
  it('C1: gives one record list per required tab with one record per sheet row', () => {
    const csv = requiredOnly();
    const result = convertSheet(csv);

    expect(result.errors.map(formatIssue)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.files).sort()).toEqual([...REQUIRED_TABS].sort());
    expect(result.importedTabs).toHaveLength(7);
    for (const tab of REQUIRED_TABS) {
      expect(result.files[tab], tab).toHaveLength(dataRowCount(csv[tab]!));
    }
  });

  it('C1: imports the optional tabs that exist and warns about the ones that do not', () => {
    const csv = { ...requiredOnly(), NPC_Schedule: fixtureCsv().NPC_Schedule! };
    const result = convertSheet(csv);

    expect(result.ok).toBe(true);
    expect(result.importedTabs).toContain('NPC_Schedule');
    expect(result.files.NPC_Schedule).toHaveLength(2);
    expect(result.missingTabs).toEqual(['Day10_Strategies']);
    expect(result.warnings.map(formatIssue).join('\n')).toContain('Day10_Strategies');
  });

  it('fails when a required tab is missing', () => {
    const { NPC: _npc, ...rest } = requiredOnly();
    const result = convertSheet(rest);

    expect(result.ok).toBe(false);
    expect(result.errors.map(formatIssue).join('\n')).toContain('NPC');
  });

  // C2: Given "[HEAL, CLEANSE]", "7.25%", "0" / Then ["HEAL","CLEANSE"], 7.25, 0.
  it('C2: converts tag lists, percent rates and daily limits to arrays and numbers', () => {
    const result = convertSheet(requiredOnly());
    const ability = result.files.Ability![0] as AbilityRecord;
    const scenario = (result.files.Start_Scenarios as StartScenarioRecord[]).find((s) => s.rate === 7.25);

    expect(ability.matchVerbTags).toEqual(['HEAL', 'CLEANSE']);
    expect(ability.dailyLimit).toBe(0);
    expect(scenario?.rate).toBe(7.25);
    expect(scenario?.passive).toEqual({ verbTags: ['TRADE'], stat: 'stamina_cost', value: -1, condition: '' });
  });

  it('C2 (Q-090): turns the structured effect columns into numbers the server can use', () => {
    const result = convertSheet(requiredOnly());
    const [dawn, shade, guard] = result.files.Ability as AbilityRecord[];
    const chalice = (result.files.Item as ItemRecord[])[0]!;

    expect(dawn!.effects).toEqual([
      { type: 'restore', stats: ['HP', 'Stamina'], value: 15, duration: { unit: 'instant' } },
      { type: 'dice_bonus', stats: ['d20'], value: 2, duration: { unit: 'period', count: 1 } },
    ]);
    expect(shade!.effects).toEqual([]);
    expect(guard!.effects).toEqual([
      { type: 'damage_reduce_pct', stats: ['HP'], value: 50, duration: { unit: 'period', count: 2 } },
    ]);
    expect(guard!.triggerType).toBe('Passive + Active');
    expect(chalice.name).toBe('Test Chalice (จอกทดสอบ)');
    expect(chalice.nameEn).toBe('Test Chalice');
    expect(result.tabsWithoutEffectColumns).toEqual([]);
  });

  it('Q-090: effect columns are optional; a tab without them is reported, not failed', () => {
    const csv = requiredOnly();
    // Keep Rank .. Match_Target_Tags; Effect_Type onwards (and the note) are gone.
    const result = convertSheet({ ...csv, Item: keepColumnsBefore(csv.Item!, 'Effect_Type') });

    expect(result.errors.map(formatIssue)).toEqual([]);
    expect(result.tabsWithoutEffectColumns).toEqual(['Item']);
    expect((result.files.Item as ItemRecord[])[0]!.effects).toEqual([]);
  });

  it('Q-116 / Q-113: Day10_Strategies imports approved and draft rows, D10-DRIFT included, with Effect_Type nullify', () => {
    const result = convertSheet({ ...requiredOnly(), Day10_Strategies: fixtureCsv().Day10_Strategies! });

    expect(result.errors.map(formatIssue)).toEqual([]);
    const strategies = result.files.Day10_Strategies as Day10StrategyRecord[];
    expect(strategies.map((s) => [s.id, s.status])).toEqual([
      ['D10-T1', 'approved'],
      ['D10-DRIFT', 'draft'],
    ]);
    expect(strategies[0]!.effects).toEqual([{ type: 'nullify', stats: ['d20'], value: 0, duration: { unit: 'period', count: 2 } }]);
    expect(result.warnings.filter((w) => w.tab === 'Day10_Strategies').map(formatIssue)).toEqual([]);
  });

  it('Q-116: nullify is an allowed Effect_Type on Ability too', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Ability: setCell(csv.Ability!, 4, 'Effect_Type', 'nullify') });

    expect(result.errors.map(formatIssue)).toEqual([]);
  });

  // Q-114: dice bonus cap per Rank (B 2, A 3, S / SS 5); over the cap = a warning, Q-119 exceptions none.
  it('Q-114: a d20 dice_bonus above the Rank cap is a warning with the row, not a failure', () => {
    const csv = requiredOnly();
    // Row 2 is SS (cap 5); row 3 is B (cap 2).
    const result = convertSheet({ ...csv, Ability: setCell(csv.Ability!, 2, 'Effect2_Value', '6') });
    const withShade = convertSheet({
      ...csv,
      Ability: setCell(setCell(setCell(setCell(csv.Ability!, 3, 'Effect_Type', 'dice_bonus'), 3, 'Stat', 'd20'), 3, 'Value', '3'), 3, 'Duration', '1 period'),
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ tab: 'Ability', row: 2, column: 'Effect2_Value' }));
    expect(withShade.ok).toBe(true);
    expect(withShade.warnings).toContainEqual(expect.objectContaining({ tab: 'Ability', row: 3, column: 'Value' }));
    expect(withShade.warnings.map(formatIssue).join('\n')).toMatch(/B.*2/);
  });

  it('Q-114: a dice_bonus at the cap gives no warning', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Ability: setCell(csv.Ability!, 2, 'Effect2_Value', '5') });

    expect(result.warnings.filter((w) => w.tab === 'Ability').map(formatIssue)).toEqual([]);
  });

  // Q-122: Rank F cap = +1.
  it('Q-122: a Rank F d20 dice_bonus above +1 is a warning; +1 is not', () => {
    const csv = requiredOnly();
    const rankF = (value: string) => {
      let ability = setCell(csv.Ability!, 3, 'Rank', 'F');
      for (const [header, cell] of [['Effect_Type', 'dice_bonus'], ['Stat', 'd20'], ['Value', value], ['Duration', '1 period']] as const) {
        ability = setCell(ability, 3, header, cell);
      }
      return convertSheet({ ...csv, Ability: ability });
    };

    const over = rankF('2');
    expect(over.ok).toBe(true);
    expect(over.warnings).toContainEqual(expect.objectContaining({ tab: 'Ability', row: 3, column: 'Value' }));
    expect(over.warnings.map(formatIssue).join('\n')).toMatch(/Rank F.*\+1/);
    expect(rankF('1').warnings.filter((w) => w.tab === 'Ability').map(formatIssue)).toEqual([]);
  });

  it('Q-119: Prism of Truth (B) +3 is an allowed exception to the cap', () => {
    const csv = requiredOnly();
    let item = setCell(csv.Item!, 3, 'Item Name', 'Prism of Truth (ปริซึมทดสอบ)');
    item = setCell(item, 3, 'Skill Synergy & Unlock Condition', '');
    for (const [header, value] of [['Effect_Type', 'dice_bonus'], ['Stat', 'd20'], ['Value', '3'], ['Duration', 'passive']] as const) {
      item = setCell(item, 3, header, value);
    }
    const result = convertSheet({ ...csv, Item: item });

    expect(result.ok).toBe(true);
    expect(result.warnings.filter((w) => w.tab === 'Item').map(formatIssue)).toEqual([]);
  });

  // C3: Given Start_Scenarios rates that do not add up to 100 / Then fail and give the sum.
  it('C3: fails when the Start_Scenarios rates do not add up to 100 and gives the sum', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Start_Scenarios: setCell(csv.Start_Scenarios!, 2, 'Rate', '90.00%') });

    expect(result.ok).toBe(false);
    const text = result.errors.map(formatIssue).join('\n');
    expect(text).toContain('Start_Scenarios');
    expect(text).toContain('98.25');
  });

  // C4: a Rank / Trigger_Type outside the allowed values or a repeated name fails with tab, row and column.
  it('C4: fails on a Rank outside F / B / A / S / SS with the tab, row and column', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Ability: setCell(csv.Ability!, 3, 'Rank', 'C') });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ tab: 'Ability', row: 3, column: 'Rank' }));
    const text = result.errors.map(formatIssue).join('\n');
    expect(text).toContain('Ability');
    expect(text).toContain('แถว 3');
    expect(text).toContain('Rank');
  });

  it('C4: fails on a Trigger_Type outside Active / Passive / Passive + Active', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Item: setCell(csv.Item!, 2, 'Trigger_Type', 'Reactive') });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ tab: 'Item', row: 2, column: 'Trigger_Type' }));
  });

  it('C4: fails on a name used twice in one tab and names the second row', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Ability: duplicateRow(csv.Ability!, 2) });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ tab: 'Ability', row: 5, column: 'Ability Name' }));
  });

  it('fails with tab, row and column on a broken tag list or number', () => {
    const csv = requiredOnly();
    const result = convertSheet({
      ...csv,
      Ability: setCell(csv.Ability!, 2, 'Match_Verb_Tags', 'HEAL, CLEANSE'),
      Item: setCell(csv.Item!, 3, 'Daily_Limit', 'สองครั้ง'),
    });

    expect(result.errors).toContainEqual(expect.objectContaining({ tab: 'Ability', row: 2, column: 'Match_Verb_Tags' }));
    expect(result.errors).toContainEqual(expect.objectContaining({ tab: 'Item', row: 3, column: 'Daily_Limit' }));
  });

  it('fails on an Effect_Type outside the known list', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Ability: setCell(csv.Ability!, 4, 'Effect_Type', 'teleport') });

    expect(result.errors).toContainEqual(expect.objectContaining({ tab: 'Ability', row: 4, column: 'Effect_Type' }));
  });

  // C5: an NPC or item that names a skill / item not in the tabs: import succeeds with a warning and the row.
  it('C5: warns with the row when an NPC or item names a skill / item that is not in the sheet', () => {
    const csv = requiredOnly();
    const result = convertSheet({
      ...csv,
      NPC: setCell(csv.NPC!, 3, 'Rewards & Abilities', 'ความสัมพันธ์ +9: มอบ Missing Charm (B)'),
      Item: setCell(csv.Item!, 2, 'Skill Synergy & Unlock Condition', 'เสริมสกิล: Ghost Skill (A)'),
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ tab: 'NPC', row: 3, column: 'Rewards & Abilities' }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ tab: 'Item', row: 2, column: 'Skill Synergy & Unlock Condition' }));
    const text = result.warnings.map(formatIssue).join('\n');
    expect(text).toContain('Missing Charm');
    expect(text).toContain('Ghost Skill');
  });

  it('C5: no reference warnings when every named skill / item / NPC / location exists', () => {
    const result = convertSheet({ ...requiredOnly(), NPC_Schedule: fixtureCsv().NPC_Schedule! });

    expect(result.warnings.filter((w) => w.tab !== 'Day10_Strategies').map(formatIssue)).toEqual([]);
  });

  it('C5: warns when a schedule or start scenario names an NPC / location that is not in the sheet', () => {
    const csv = { ...requiredOnly(), NPC_Schedule: fixtureCsv().NPC_Schedule! };
    const result = convertSheet({
      ...csv,
      NPC_Schedule: setCell(setCell(csv.NPC_Schedule, 2, 'NPC', 'คนแปลกหน้า'), 3, 'Location', 'ที่ลับ'),
      Start_Scenarios: setCell(csv.Start_Scenarios!, 2, 'Location', 'ที่ไม่มี'),
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ tab: 'NPC_Schedule', row: 2, column: 'NPC' }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ tab: 'NPC_Schedule', row: 3, column: 'Location' }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ tab: 'Start_Scenarios', row: 2, column: 'Location' }));
  });
});

describe('Q-161 Location Connects_To / Safety / Rest_Quality and NPC Public_Alias', () => {
  it('reads the new columns into arrays and allowed values; the note column is the note', () => {
    const result = convertSheet(requiredOnly());
    expect(result.errors.map(formatIssue)).toEqual([]);
    const [square, market, crypt, rule] = result.files.Location as LocationRecord[];
    expect(square).toMatchObject({ connectsTo: ['ตลาดทดสอบ'], safety: 'SAFE', restQuality: 'good', note: 'โน้ตลาน' });
    expect(market).toMatchObject({ connectsTo: ['ลานทดสอบ', 'ห้องลับ (ชั้นใต้ดิน)'], safety: 'RESTRICTED', restQuality: 'poor', note: '' });
    expect(crypt).toMatchObject({ safety: 'DANGER', restQuality: 'excellent' });
    // The weather-rules row is not a place: empty cells, no value.
    expect(rule).toMatchObject({ connectsTo: [], safety: null, restQuality: null, note: 'แถวกฎ' });
    expect(square!.extra).toBeUndefined();
    const [nova, merchant] = result.files.NPC as NpcRecord[];
    expect(nova).toMatchObject({ publicAlias: 'เด็กผู้มาเยือน', note: 'ตัดภูมิหลังออก' });
    expect(merchant).toMatchObject({ publicAlias: '', note: '' });
    expect(result.warnings.filter((w) => w.tab === 'Location' || w.tab === 'NPC').map(formatIssue)).toEqual([]);
  });

  it('refuses a Safety / Rest_Quality outside the allowed values, naming the cell', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Location: setCell(setCell(csv.Location!, 2, 'Safety', 'safe-ish'), 3, 'Rest_Quality', 'great') });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ tab: 'Location', row: 2, column: 'Safety', message: expect.stringContaining('SAFE / NORMAL / DANGER / RESTRICTED') }));
    expect(result.errors).toContainEqual(expect.objectContaining({ tab: 'Location', row: 3, column: 'Rest_Quality', message: expect.stringContaining('poor / normal / good / excellent') }));
  });

  it('warns (does not fail) when Connects_To names a place that is not in the tab, or is not a [list]', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Location: setCell(csv.Location!, 2, 'Connects_To', '[ตลาดทดสอบ, ถ้ำที่ไม่มี]') });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ tab: 'Location', row: 2, column: 'Connects_To', message: expect.stringContaining('ถ้ำที่ไม่มี') }));
    expect((result.files.Location as LocationRecord[])[0]!.connectsTo).toEqual(['ตลาดทดสอบ', 'ถ้ำที่ไม่มี']);

    const broken = convertSheet({ ...csv, Location: setCell(csv.Location!, 2, 'Connects_To', 'ตลาดทดสอบ') });
    expect(broken.ok).toBe(false);
    expect(broken.errors).toContainEqual(expect.objectContaining({ tab: 'Location', row: 2, column: 'Connects_To' }));
  });

  it('a sheet without the new columns still imports, with empty values', () => {
    const csv = requiredOnly();
    const result = convertSheet({ ...csv, Location: keepColumnsBefore(csv.Location!, 'Connects_To'), NPC: keepColumnsBefore(csv.NPC!, 'Public_Alias') });
    expect(result.errors.map(formatIssue)).toEqual([]);
    expect((result.files.Location as LocationRecord[])[0]).toMatchObject({ connectsTo: [], safety: null, restQuality: null, note: '' });
    expect((result.files.NPC as NpcRecord[])[0]).toMatchObject({ publicAlias: '', note: '' });
  });
});

describe('Q-208 Start_Scenarios Illness_Stat / Illness_Value (the chronic illness penalty)', () => {
  const NOTE = 'หมายเหตุ (ร่าง Claude — Nok ตรวจ)';
  /** The fixture tab with the two new columns (empty), then `cells` set on sheet row 3 (the 7.25% row). */
  function withIllness(cells: { stat: string; value: string }) {
    const csv = requiredOnly();
    let tab = addColumnBefore(addColumnBefore(csv.Start_Scenarios!, NOTE, 'Illness_Stat'), NOTE, 'Illness_Value');
    tab = setCell(setCell(tab, 3, 'Illness_Stat', cells.stat), 3, 'Illness_Value', cells.value);
    return convertSheet({ ...csv, Start_Scenarios: tab });
  }
  const rows = (result: ReturnType<typeof convertSheet>) => result.files.Start_Scenarios as StartScenarioRecord[];

  it('reads a d20 or Stamina penalty into numbers; the other rows have none', () => {
    const d20 = withIllness({ stat: 'd20', value: '-2' });
    expect(d20.errors.map(formatIssue)).toEqual([]);
    expect(rows(d20).find((s) => s.rate === 7.25)!.illness).toEqual({ stat: 'd20', value: -2 });
    expect(rows(d20).find((s) => s.rate !== 7.25)!.illness).toEqual({ stat: null, value: null });
    // The note column stays the note.
    expect(rows(d20).find((s) => s.rate === 7.25)!.extra).toBeUndefined();

    const stamina = withIllness({ stat: 'Stamina', value: '-1' });
    expect(stamina.errors.map(formatIssue)).toEqual([]);
    expect(rows(stamina).find((s) => s.rate === 7.25)!.illness).toEqual({ stat: 'Stamina', value: -1 });
  });

  it('a sheet without the columns imports with no penalty (default none)', () => {
    const result = convertSheet(requiredOnly());
    expect(result.errors.map(formatIssue)).toEqual([]);
    for (const s of rows(result)) expect(s.illness).toEqual({ stat: null, value: null });
  });

  it('refuses a stat other than d20 / Stamina, a value that is not a penalty, and half a pair, naming the cell', () => {
    const karma = withIllness({ stat: 'Karma', value: '-2' });
    expect(karma.ok).toBe(false);
    expect(karma.errors).toContainEqual(expect.objectContaining({ tab: 'Start_Scenarios', row: 3, column: 'Illness_Stat', message: expect.stringContaining('d20 / Stamina') }));

    const bonus = withIllness({ stat: 'd20', value: '2' });
    expect(bonus.ok).toBe(false);
    expect(bonus.errors).toContainEqual(expect.objectContaining({ tab: 'Start_Scenarios', row: 3, column: 'Illness_Value', message: expect.stringContaining('ไม่มากกว่า 0') }));

    const noValue = withIllness({ stat: 'd20', value: '' });
    expect(noValue.ok).toBe(false);
    expect(noValue.errors).toContainEqual(expect.objectContaining({ tab: 'Start_Scenarios', row: 3, column: 'Illness_Value', message: expect.stringContaining('ต้องมี') }));

    const noStat = withIllness({ stat: '', value: '-1' });
    expect(noStat.ok).toBe(false);
    expect(noStat.errors).toContainEqual(expect.objectContaining({ tab: 'Start_Scenarios', row: 3, column: 'Illness_Stat', message: expect.stringContaining('ต้องมี') }));
  });
});
