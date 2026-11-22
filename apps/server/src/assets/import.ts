/**
 * Sheet CSV → records (GEN-062). Pure: no network, no files. Every problem comes back with the
 * tab, the sheet row (header = row 1) and the column header, so Nok can find the cell.
 * Errors stop the import; warnings (missing optional tab, a name that points nowhere) do not.
 */
import { parseCsv } from './csv.ts';
import {
  ALIGNMENTS,
  ALL_TABS,
  EFFECT_TYPES,
  OPTIONAL_TABS,
  PERIODS,
  RANKS,
  STATS,
  TAB_SCHEMAS,
  TRIGGER_TYPES,
  WEATHERS,
  aliasMatches,
  type Duration,
  type Effect,
  type TabName,
  type TabRecords,
} from './model.ts';

export interface AssetIssue {
  tab: TabName;
  /** Sheet row number (the header is row 1). */
  row?: number;
  /** Column header as written in the sheet. */
  column?: string;
  message: string;
}

export interface ConvertResult {
  /** False when there is at least one error: nothing may be written. */
  ok: boolean;
  files: Partial<TabRecords>;
  errors: AssetIssue[];
  warnings: AssetIssue[];
  /** Tabs converted, in ALL_TABS order. */
  importedTabs: TabName[];
  /** Optional tabs the sheet does not have (or has empty). */
  missingTabs: TabName[];
  /** Tabs that could carry Q-090 effect columns but have none of them. */
  tabsWithoutEffectColumns: TabName[];
}

export function formatIssue(issue: AssetIssue): string {
  const where = [issue.tab, issue.row !== undefined ? `แถว ${issue.row}` : '', issue.column !== undefined ? `คอลัมน์ "${issue.column}"` : '']
    .filter(Boolean)
    .join(' ');
  return `${where}: ${issue.message}`;
}

// ---------------------------------------------------------------------------------------------
// Cell kinds: a cell string → a value, or a Thai message saying what is wrong.

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
type Kind<T = unknown> = (cell: string) => Parsed<T>;

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (message: string): Parsed<never> => ({ ok: false, message });

const text: Kind<string> = (cell) => ok(cell);
const name: Kind<string> = (cell) => (cell === '' ? bad('ต้องไม่ว่าง') : ok(cell));

function oneOf<const V extends readonly string[]>(values: V): Kind<V[number]> {
  return (cell) =>
    (values as readonly string[]).includes(cell)
      ? ok(cell as V[number])
      : bad(`ค่า "${cell}" ไม่อยู่ในค่าที่อนุญาต (${values.join(' / ')})`);
}

function listOf<const V extends readonly string[]>(values: V, separator: string, none: readonly string[] = ['']): Kind<V[number][]> {
  const one = oneOf(values);
  return (cell) => {
    if (none.includes(cell)) return ok([]);
    const out: V[number][] = [];
    for (const part of cell.split(separator).map((p) => p.trim())) {
      const parsed = one(part);
      if (!parsed.ok) return parsed;
      out.push(parsed.value);
    }
    return ok(out);
  };
}

/** "[HEAL, CLEANSE]" → ["HEAL", "CLEANSE"]; an empty cell → []. */
const tags: Kind<string[]> = (cell) => {
  if (cell === '') return ok([]);
  const match = /^\[(.*)\]$/s.exec(cell);
  if (!match) return bad(`tag ต้องอยู่ในรูป [A, B] แต่ได้ "${cell}"`);
  const list = match[1]!.split(',').map((t) => t.trim()).filter(Boolean);
  const wrong = list.find((t) => !/^[A-Z0-9_]+$/.test(t));
  if (wrong !== undefined) return bad(`tag "${wrong}" ต้องเป็นตัวพิมพ์ใหญ่ ตัวเลข หรือ _ เท่านั้น`);
  return ok(list);
};

const NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

function int(min?: number): Kind<number> {
  return (cell) => {
    if (!/^[+-]?\d+$/.test(cell)) return bad(`ต้องเป็นจำนวนเต็ม แต่ได้ "${cell}"`);
    const value = Number(cell);
    if (min !== undefined && value < min) return bad(`ต้องไม่น้อยกว่า ${min} แต่ได้ ${value}`);
    return ok(value);
  };
}

const numberOrNull: Kind<number | null> = (cell) => {
  if (cell === '') return ok(null);
  return NUMBER.test(cell) ? ok(Number(cell)) : bad(`ต้องเป็นตัวเลข แต่ได้ "${cell}"`);
};

/** "7.25%" → 7.25 */
const percent: Kind<number> = (cell) => {
  const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(cell);
  return match ? ok(Number(match[1])) : bad(`ต้องเป็นเปอร์เซ็นต์ เช่น 7.25% แต่ได้ "${cell}"`);
};

const effectTypeOrNull: Kind<Effect['type'] | null> = (cell) => (cell === '' ? ok(null) : oneOf(EFFECT_TYPES)(cell));

const passiveStat: Kind<(typeof STATS)[number] | (typeof EFFECT_TYPES)[number] | null> = (cell) => {
  if (cell === '') return ok(null);
  const all: readonly string[] = [...STATS, ...EFFECT_TYPES];
  return all.includes(cell) ? ok(cell as (typeof STATS)[number]) : bad(`ค่า "${cell}" ต้องเป็น stat (${STATS.join(' / ')}) หรือ Effect_Type`);
};

/** "instant" / "passive" / "end of period" / "1 hit" / "2 periods" / "1 day"; empty → null. */
const durationOrNull: Kind<Duration | null> = (cell) => {
  if (cell === '') return ok(null);
  const lower = cell.toLowerCase();
  if (lower === 'instant' || lower === 'passive') return ok({ unit: lower });
  if (lower === 'end of period') return ok({ unit: 'end_of_period' });
  const match = /^(\d+)\s+(hit|period|day)s?$/.exec(lower);
  if (match && Number(match[1]) > 0) return ok({ unit: match[2] as 'hit' | 'period' | 'day', count: Number(match[1]) });
  return bad(`Duration ต้องเป็น instant / passive / end of period / <n> hit / <n> period(s) / <n> day(s) แต่ได้ "${cell}"`);
};

// ---------------------------------------------------------------------------------------------
// Tab layouts: which header goes to which field (dotted keys nest), and what each tab checks.

interface Column {
  header: string;
  key: string;
  kind: Kind;
  /** Column may be missing from the sheet; its field then gets `fallback`. */
  optional?: { fallback: unknown };
}

interface TabLayout {
  columns: Column[];
  /** Header whose value must not repeat in the tab. */
  unique?: string;
  /** Q-090 effect column groups: [type, stat, value, duration] headers. All optional. */
  effects?: Array<readonly [string, string, string, string]>;
  /** Fields computed from others; may report a problem on one column. */
  derive?: (record: Record<string, unknown>) => { column: string; message: string } | undefined;
}

const col = (header: string, key: string, kind: Kind): Column => ({ header, key, kind });
const optionalCol = (header: string, key: string, kind: Kind, fallback: unknown): Column => ({ header, key, kind, optional: { fallback } });

const EFFECT_GROUPS = [
  ['Effect_Type', 'Stat', 'Value', 'Duration'],
  ['Effect2_Type', 'Effect2_Stat', 'Effect2_Value', 'Effect2_Duration'],
] as const;

const LAYOUTS: Record<TabName, TabLayout> = {
  Ability: {
    unique: 'Ability Name',
    columns: [
      col('Rank', 'rank', oneOf(RANKS)),
      col('Type', 'alignment', oneOf(ALIGNMENTS)),
      col('Ability Name', 'name', name),
      col('Category', 'category', text),
      col('Ability', 'description', text),
      col('Condition', 'condition', text),
      col('บทพูด/คำบรรยาย', 'quote', text),
      col('Trigger_Type', 'triggerType', oneOf(TRIGGER_TYPES)),
      col('Daily_Limit', 'dailyLimit', int(0)),
      col('Match_Verb_Tags', 'matchVerbTags', tags),
      col('Match_Target_Tags', 'matchTargetTags', tags),
    ],
    effects: [...EFFECT_GROUPS],
  },
  Item: {
    unique: 'Item Name',
    columns: [
      col('Rank', 'rank', oneOf(RANKS)),
      col('Alignment', 'alignment', oneOf(ALIGNMENTS)),
      col('Category', 'category', text),
      col('Item Name', 'name', name),
      col('Buff Type', 'buffType', text),
      col('Effect', 'effect', text),
      col('Skill Synergy & Unlock Condition', 'synergy', text),
      col('คำบรรยายไอเทม', 'description', text),
      col('Trigger_Type', 'triggerType', oneOf(TRIGGER_TYPES)),
      col('Daily_Limit', 'dailyLimit', int(0)),
      col('Match_Verb_Tags', 'matchVerbTags', tags),
      col('Match_Target_Tags', 'matchTargetTags', tags),
    ],
    effects: [...EFFECT_GROUPS],
    derive: (r) => {
      r.nameEn = englishName(r.name as string);
      return undefined;
    },
  },
  NPC: {
    unique: 'Name / Initial Status',
    columns: [
      col('Grade', 'grade', oneOf(RANKS)),
      col('Alignment', 'alignments', listOf(ALIGNMENTS, '/')),
      col('Name / Initial Status', 'name', name),
      col('True Name / Evolved Form', 'trueName', text),
      col('Lore & Background', 'lore', text),
      col('Evolution / Unlock Condition', 'unlockCondition', text),
      col('Rewards & Abilities', 'rewards', text),
      col('Match_Verb_Tags', 'matchVerbTags', tags),
      col('Match_Target_Tags', 'matchTargetTags', tags),
    ],
    derive: (r) => {
      r.aliases = npcAliases(r.name as string, r.trueName as string);
      return undefined;
    },
  },
  Location: {
    unique: 'Location',
    columns: [
      col('Zone', 'zone', text),
      col('Location', 'name', name),
      col('Characteristics & Spawn', 'characteristics', text),
      col('Time & Weather Dynamics', 'timeAndWeather', text),
      col('NPCs & Behavior', 'npcsAndBehavior', text),
      col('Special Mechanics', 'specialMechanics', text),
      col('Location_Tags', 'tags', tags),
      col('Weather_Verb_Boost', 'weatherVerbBoost', text),
    ],
  },
  Start_Scenarios: {
    unique: 'Scenario_Name',
    columns: [
      col('Tier', 'tier', text),
      col('Rate', 'rate', percent),
      col('Zone', 'zone', text),
      col('Location', 'location', name),
      col('Scenario_Name', 'name', name),
      col('Scenario_Tags', 'tags', tags),
      col('Start_HP', 'startHp', int()),
      col('Max_HP', 'maxHp', int(1)),
      col('Start_Stamina', 'startStamina', int()),
      col('Start_Coins', 'startCoins', int(0)),
      col('Start_Karma', 'startKarma', int()),
      col('Initial_Title', 'initialTitle', text),
      col('Passive_Bonus_&_Clues', 'passiveText', text),
      optionalCol('Passive_Verb_Tags', 'passive.verbTags', tags, []),
      optionalCol('Passive_Stat', 'passive.stat', passiveStat, null),
      optionalCol('Passive_Value', 'passive.value', numberOrNull, null),
      optionalCol('Passive_Condition', 'passive.condition', text, ''),
    ],
  },
  System_Rules: {
    unique: 'Sub_Rule_Name',
    columns: [
      col('Category', 'category', text),
      col('Sub_Rule_Name', 'name', name),
      col('Parameters_&_Values', 'parameters', text),
      col('Mechanics_&_Effects', 'mechanics', text),
    ],
  },
  World_Timeline: {
    unique: 'Event_Name',
    columns: [
      col('Day_&_Period', 'when', name),
      col('Event_Name', 'name', name),
      col('Location', 'location', text),
      col('Player_Intervention_Effects', 'interventionEffects', text),
      col('World_Drift_If_Ignored', 'driftIfIgnored', text),
      col('Foreshadowing_Trigger', 'foreshadowing', text),
    ],
    derive: (r) => {
      const when = r.when as string;
      const day = /(?:วันที่|day)\s*(\d+)/i.exec(when);
      if (!day) return { column: 'Day_&_Period', message: `ต้องมีเลขวัน เช่น "วันที่ 5 — ช่วง EOSORIA" แต่ได้ "${when}"` };
      r.day = Number(day[1]);
      r.periods = periodsIn(when);
      return undefined;
    },
  },
  NPC_Schedule: {
    columns: [
      col('NPC', 'npc', name),
      col('Location', 'location', name),
      col('Period', 'periods', listOf(PERIODS, ',')),
      col('Weather', 'weathers', listOf(WEATHERS, ',')),
      optionalCol('Condition', 'condition', text, ''),
    ],
  },
  Day10_Strategies: {
    unique: 'Strategy_ID',
    columns: [
      optionalCol('Status', 'status', text, ''),
      col('Strategy_ID', 'id', name),
      col('Name', 'name', name),
      optionalCol('Karma_Alignment', 'karmaAlignments', listOf(ALIGNMENTS, '/', ['', '-']), []),
      ...(
        [
          ['Karma_Condition', 'karmaCondition'],
          ['Required_Skills', 'requiredSkills'],
          ['Required_Items', 'requiredItems'],
          ['Required_NPCs', 'requiredNpcs'],
          ['Day1_Modifier', 'day1Modifier'],
          ['Day5_Modifier', 'day5Modifier'],
          ['Day7_Condition', 'day7Condition'],
          ['Location', 'location'],
          ['Night10_Actions', 'night10Actions'],
          ['DC', 'dc'],
          ['Bonus', 'bonus'],
        ] as const
      ).map(([header, key]) => optionalCol(header, key, text, '')),
      optionalCol('Match_Verb_Tags', 'matchVerbTags', tags, []),
      optionalCol('Match_Target_Tags', 'matchTargetTags', tags, []),
      optionalCol('Success_Effect_Day11_12', 'successEffect', text, ''),
      optionalCol('Failure_Effect', 'failureEffect', text, ''),
      optionalCol('Ending_Link', 'endingLink', text, ''),
    ],
    effects: [EFFECT_GROUPS[0]],
  },
};

/** Tabs whose schema has a `note` field (the "หมายเหตุ ..." column; empty when absent). */
const NOTE_TABS: ReadonlySet<TabName> = new Set(['Ability', 'Item', 'Start_Scenarios', 'NPC_Schedule', 'Day10_Strategies']);
const isNoteHeader = (header: string) => header.startsWith('หมายเหตุ');

/** "Chalice of the First Dawn (จอก...)" → "Chalice of the First Dawn". */
export function englishName(full: string): string {
  const cut = full.indexOf(' (');
  return (cut > 0 ? full.slice(0, cut) : full).trim();
}

/** Short names of an NPC: the part before " (" / " —" of both name cells, plus an English name in brackets. */
export function npcAliases(nameCell: string, trueNameCell: string): string[] {
  const out: string[] = [];
  for (const cell of [nameCell, trueNameCell]) {
    if (cell === '' || cell.includes(':')) continue;
    const head = cell.split(/ \(| —| -/)[0]!.trim();
    if (head) out.push(head);
    const english = /\(([A-Za-z][A-Za-z' -]*)\)/.exec(cell)?.[1]?.trim();
    if (english) out.push(english);
  }
  return [...new Set(out)];
}

function periodsIn(when: string): Array<(typeof PERIODS)[number]> {
  const found = PERIODS.filter((p) => when.includes(p)).sort((a, b) => when.indexOf(a) - when.indexOf(b));
  if (found.length === 2 && when.includes('ถึง')) {
    const from = PERIODS.indexOf(found[0]!);
    const to = PERIODS.indexOf(found[1]!);
    if (from < to) return PERIODS.slice(from, to + 1);
  }
  return found;
}

function setPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    node[part] ??= {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}

// ---------------------------------------------------------------------------------------------

interface TabOutcome {
  records: Array<{ row: number; record: Record<string, unknown> }>;
  hasEffectColumns: boolean;
}

function convertTab(tab: TabName, csv: string, errors: AssetIssue[], warnings: AssetIssue[]): TabOutcome | 'empty' {
  const layout = LAYOUTS[tab];
  const rows = parseCsv(csv).map((r) => r.map((cell) => cell.normalize('NFC').replace(/\r\n?/g, '\n').trim()));
  const header = rows[0];
  if (!header || header.every((h) => h === '')) return 'empty';

  const index = new Map<string, number>();
  header.forEach((h, i) => {
    if (h !== '' && !index.has(h)) index.set(h, i);
  });

  const missing = layout.columns.filter((c) => !c.optional && !index.has(c.header));
  for (const c of missing) errors.push({ tab, column: c.header, message: 'ไม่มีคอลัมน์นี้ในแท็บ (ต้องมี)' });
  if (missing.length > 0) return { records: [], hasEffectColumns: false };

  const known = new Set<string>([...layout.columns.map((c) => c.header), ...(layout.effects ?? []).flat()]);
  const noteIndex = header.findIndex(isNoteHeader);
  const unknown = header
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => h !== '' && !known.has(h) && !(NOTE_TABS.has(tab) && i === noteIndex));
  if (unknown.length > 0) {
    warnings.push({ tab, message: `คอลัมน์ที่ schema ยังไม่รู้จัก เก็บเป็นข้อความใน extra: ${unknown.map((u) => `"${u.h}"`).join(', ')}` });
  }
  const unnamed = header.map((h, i) => ({ h, i })).filter(({ h, i }) => h === '' && rows.slice(1).some((r) => (r[i] ?? '') !== ''));
  for (const { i } of unnamed) warnings.push({ tab, message: `คอลัมน์ที่ ${i + 1} ไม่มีหัวตารางแต่มีข้อมูล (ไม่ได้นำเข้า)` });

  const groups = (layout.effects ?? []).filter((g) => g.some((h) => index.has(h)));
  const seen = new Map<string, number>();
  const records: TabOutcome['records'] = [];

  rows.slice(1).forEach((cells, i) => {
    const row = i + 2;
    if (cells.every((c) => c === '')) return;
    const cell = (h: string) => cells[index.get(h)!] ?? '';
    const record: Record<string, unknown> = {};
    let rowOk = true;
    const fail = (column: string, message: string) => {
      errors.push({ tab, row, column, message });
      rowOk = false;
    };

    for (const c of layout.columns) {
      if (!index.has(c.header)) {
        setPath(record, c.key, c.optional!.fallback);
        continue;
      }
      const parsed = c.kind(cell(c.header));
      if (parsed.ok) setPath(record, c.key, parsed.value);
      else fail(c.header, parsed.message);
    }

    if (layout.effects) {
      const effects: Effect[] = [];
      for (const [typeH, statH, valueH, durationH] of groups) {
        const read = <T>(h: string, kind: Kind<T>): T | null | undefined => {
          if (!index.has(h)) return null;
          const parsed = kind(cell(h));
          if (parsed.ok) return parsed.value;
          fail(h, parsed.message);
          return undefined;
        };
        const type = read(typeH, effectTypeOrNull);
        const stats = read(statH, listOf(STATS, ',')) ?? [];
        const value = read(valueH, numberOrNull);
        const duration = read(durationH, durationOrNull);
        if (type === undefined || value === undefined || duration === undefined) continue;
        if (type === null && value === null && duration === null && stats.length === 0) continue;
        if (type === null) fail(typeH, 'มีค่าผลเชิงตัวเลขในกลุ่มนี้แต่ไม่มี Effect_Type');
        else if (value === null) fail(valueH, `Effect_Type "${type}" ต้องมี Value`);
        else if (duration === null) fail(durationH, `Effect_Type "${type}" ต้องมี Duration`);
        else effects.push({ type, stats, value, duration });
      }
      record.effects = effects;
    }

    if (NOTE_TABS.has(tab)) record.note = noteIndex >= 0 ? (cells[noteIndex] ?? '') : '';
    const extra = Object.fromEntries(unknown.map(({ h, i: at }) => [h, cells[at] ?? '']).filter(([, v]) => v !== ''));
    if (Object.keys(extra).length > 0) record.extra = extra;

    if (layout.unique) {
      const key = cell(layout.unique);
      const first = seen.get(key);
      if (key !== '' && first !== undefined) fail(layout.unique, `ชื่อ "${key}" ซ้ำกับแถว ${first}`);
      else if (key !== '') seen.set(key, row);
    }

    if (rowOk && layout.derive) {
      const problem = layout.derive(record);
      if (problem) fail(problem.column, problem.message);
    }
    if (!rowOk) return;

    const checked = TAB_SCHEMAS[tab].element.safeParse(record);
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        errors.push({ tab, row, message: `field ${issue.path.join('.')}: ${issue.message}` });
      }
      return;
    }
    records.push({ row, record: checked.data as Record<string, unknown> });
  });

  return { records, hasEffectColumns: groups.length > 0 };
}

/** "Name (R)" mentions in free text, e.g. "ปลดล็อกสกิล The First Light (SS)". */
const RANKED_MENTION = /([A-Z][A-Za-z0-9’'-]*(?: [A-Za-z0-9’'-]+)*) \((F|B|A|S|SS)\)/g;

export function convertSheet(csvByTab: Partial<Record<TabName, string>>): ConvertResult {
  const errors: AssetIssue[] = [];
  const warnings: AssetIssue[] = [];
  const outcomes = new Map<TabName, TabOutcome>();
  const missingTabs: TabName[] = [];

  for (const tab of ALL_TABS) {
    const csv = csvByTab[tab];
    const optional = (OPTIONAL_TABS as readonly string[]).includes(tab);
    const outcome = csv === undefined ? 'empty' : convertTab(tab, csv, errors, warnings);
    if (outcome === 'empty') {
      if (optional) {
        missingTabs.push(tab);
        warnings.push({ tab, message: csv === undefined ? 'ไม่มีแท็บนี้ในชีท (แท็บเสริม ข้ามไป)' : 'แท็บนี้ว่าง (แท็บเสริม ข้ามไป)' });
      } else {
        errors.push({ tab, message: csv === undefined ? 'ไม่มีแท็บนี้ในชีท (ต้องมี)' : 'แท็บนี้ว่าง ไม่มีหัวตาราง (ต้องมี)' });
      }
      continue;
    }
    outcomes.set(tab, outcome);
  }

  checkRates(outcomes.get('Start_Scenarios'), errors);
  checkReferences(outcomes, warnings);

  const files: Partial<Record<TabName, unknown[]>> = {};
  for (const [tab, outcome] of outcomes) files[tab] = outcome.records.map((r) => r.record);

  return {
    ok: errors.length === 0,
    files: files as Partial<TabRecords>,
    errors,
    warnings,
    importedTabs: ALL_TABS.filter((t) => outcomes.has(t)),
    missingTabs,
    tabsWithoutEffectColumns: ALL_TABS.filter((t) => LAYOUTS[t].effects && outcomes.has(t) && !outcomes.get(t)!.hasEffectColumns),
  };
}

function checkRates(outcome: TabOutcome | undefined, errors: AssetIssue[]): void {
  if (!outcome || outcome.records.length === 0) return;
  const sum = outcome.records.reduce((total, r) => total + (r.record.rate as number), 0);
  const rounded = Math.round(sum * 10_000) / 10_000;
  if (Math.abs(rounded - 100) > 1e-9) {
    errors.push({ tab: 'Start_Scenarios', column: 'Rate', message: `Rate ทุกแถวรวมกันได้ ${rounded}% ต้องเท่ากับ 100%` });
  }
}

function checkReferences(outcomes: Map<TabName, TabOutcome>, warnings: AssetIssue[]): void {
  const records = (tab: TabName) => outcomes.get(tab)?.records ?? [];
  const skills = new Map(records('Ability').map(({ record }) => [record.name as string, record.rank as string]));
  const items = new Map(records('Item').map(({ record }) => [record.nameEn as string, record.rank as string]));
  const locations = new Set(records('Location').map(({ record }) => record.name as string));
  const npcAliasList = records('NPC').flatMap(({ record }) => record.aliases as string[]);

  const scanMentions = (tab: TabName, column: string, key: string) => {
    if (!outcomes.has('Ability') || !outcomes.has('Item')) return;
    for (const { row, record } of records(tab)) {
      for (const match of (record[key] as string).matchAll(RANKED_MENTION)) {
        const [, mention, rank] = match as unknown as [string, string, string];
        const knownRank = skills.get(mention) ?? items.get(mention);
        if (knownRank === undefined) {
          warnings.push({ tab, row, column, message: `อ้างถึง "${mention}" (${rank}) ที่ไม่มีในแท็บ Ability หรือ Item` });
        } else if (knownRank !== rank) {
          warnings.push({ tab, row, column, message: `อ้างถึง "${mention}" เป็น rank ${rank} แต่ในชีทเป็น ${knownRank}` });
        }
      }
    }
  };
  scanMentions('NPC', 'Rewards & Abilities', 'rewards');
  scanMentions('Item', 'Skill Synergy & Unlock Condition', 'synergy');
  scanMentions('Day10_Strategies', 'Required_Skills', 'requiredSkills');
  scanMentions('Day10_Strategies', 'Required_Items', 'requiredItems');

  if (outcomes.has('Location')) {
    const checkLocation = (tab: TabName, column: string, key: string) => {
      for (const { row, record } of records(tab)) {
        const value = record[key] as string;
        if (!locations.has(value)) warnings.push({ tab, row, column, message: `สถานที่ "${value}" ไม่มีในแท็บ Location` });
      }
    };
    checkLocation('Start_Scenarios', 'Location', 'location');
    checkLocation('NPC_Schedule', 'Location', 'location');
  }
  if (outcomes.has('NPC')) {
    for (const { row, record } of records('NPC_Schedule')) {
      const npc = record.npc as string;
      if (!npcAliasList.some((alias) => aliasMatches(alias, npc))) {
        warnings.push({ tab: 'NPC_Schedule', row, column: 'NPC', message: `NPC "${npc}" ไม่มีในแท็บ NPC` });
      }
    }
  }
}
