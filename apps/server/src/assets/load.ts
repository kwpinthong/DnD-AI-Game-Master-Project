/**
 * Game data the server uses (GEN-062): one JSON array per data set, checked against its schema. The JSON files
 * in apps/server/assets are the first-time seed of the DB (GEN-147, see game-data.ts); after that the DB is
 * the source and this builder checks every edit too. A file that is missing, not JSON or off-schema stops
 * start-up with an AssetLoadError naming the file and the field.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aliasMatches,
  ALL_TABS,
  REQUIRED_TABS,
  TAB_FILES,
  TAB_SCHEMAS,
  type AbilityRecord,
  type Day10StrategyRecord,
  type ItemRecord,
  type LocationRecord,
  type NpcRecord,
  type NpcScheduleRecord,
  type StartScenarioRecord,
  type SystemRuleRecord,
  type TabName,
  type TabRecords,
  type WorldEventRecord,
} from './model.ts';
import type { KarmaTier } from '@isekai/rules';
import type { z } from 'zod';
import { KARMA_TIERS_CATEGORY, karmaTiersFrom } from './karma.ts';
import { SERVER_LINES_FILE, ServerLines, type ServerLineRecord } from './server-lines.ts';
import { defaultScenario } from '@isekai/protocol';
import { realNamesInProfiles, VOICE_FILE, VoiceAsset } from './voice.ts';

export const DEFAULT_ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

/** Hand-written data sets (not sheet tabs): a missing file stops start-up with no import hint. */
const HAND_WRITTEN = ['Server_Lines', 'Voice'] as const;
/** Every data set: the sheet tabs + GEN-150's server-line templates + GEN-176's voice. The DB keys its rows by these names. */
export const DATA_SETS = [...ALL_TABS, ...HAND_WRITTEN] as const;
export type DataSetName = (typeof DATA_SETS)[number];
export const DATA_SET_FILES: Readonly<Record<DataSetName, string>> = { ...TAB_FILES, Server_Lines: SERVER_LINES_FILE, Voice: VOICE_FILE };
/** Data set → its JSON value as stored (before the schema's defaults); a missing optional set is absent. */
export type RawDataSets = Partial<Record<DataSetName, unknown>>;

export class AssetLoadError extends Error {
  /** Field path → its first problem ("[1].periods[0]" → "Invalid option ..."), for the admin editor (GEN-147). */
  readonly fields: Readonly<Record<string, string>>;
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'AssetLoadError';
    this.fields = fields;
  }
}

export interface GameAssets {
  readonly abilities: readonly AbilityRecord[];
  readonly items: readonly ItemRecord[];
  readonly npcs: readonly NpcRecord[];
  readonly locations: readonly LocationRecord[];
  readonly startScenarios: readonly StartScenarioRecord[];
  readonly systemRules: readonly SystemRuleRecord[];
  readonly worldTimeline: readonly WorldEventRecord[];
  /** Absent when the sheet had no NPC_Schedule tab. */
  readonly npcSchedule?: readonly NpcScheduleRecord[];
  /** Absent when the sheet had no Day10_Strategies tab. */
  readonly day10Strategies?: readonly Day10StrategyRecord[];
  ability(name: string): AbilityRecord | undefined;
  /** By the full cell text or the English name before " (". */
  item(nameOrNameEn: string): ItemRecord | undefined;
  /** By the full name cell or a short name ("ซิสเตอร์เอเลน่า", "Noa"). */
  npc(nameOrAlias: string): NpcRecord | undefined;
  location(name: string): LocationRecord | undefined;
  /** Karma bands from the System_Rules "Karma Tiers" rows (GEN-067), checked to cover -100..+100. */
  readonly karmaTiers: readonly KarmaTier[];
  /** GEN-150: server message templates (server-lines.json), checked at load. */
  readonly serverLines: readonly ServerLineRecord[];
  /** GEN-176: style guide + NPC speech profiles (voice.json). */
  readonly voice: VoiceAsset;
}

function fieldPath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '');
}

const SCHEMAS: Readonly<Record<DataSetName, z.ZodType>> = { ...TAB_SCHEMAS, Server_Lines: ServerLines, Voice: VoiceAsset };
const SCHEMA_LABEL: Partial<Record<DataSetName, string>> = { Server_Lines: 'server lines', Voice: 'voice' };

/** `where`: how an error names the source ("asset file /…/npc.json", "game data set NPC"). */
function parseSet<T extends DataSetName>(raw: unknown, set: T, where: string): unknown {
  const parsed = SCHEMAS[set].safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues.slice(0, 20)) fields[fieldPath(issue.path) || '(root)'] ??= issue.message;
    const shown = Object.entries(fields).slice(0, 5).map(([field, message]) => `field ${field}: ${message}`);
    throw new AssetLoadError(`${where} does not match the ${SCHEMA_LABEL[set] ?? set} schema: ${shown.join('; ')}`, fields);
  }
  return parsed.data;
}

/** The JSON of every data set file in `dir`; a missing required file (or server-lines.json) stops here. */
export function readRawDataSets(dir: string = DEFAULT_ASSETS_DIR): RawDataSets {
  const raw: RawDataSets = {};
  for (const set of DATA_SETS) {
    const file = join(dir, DATA_SET_FILES[set]);
    if (!existsSync(file)) {
      // GEN-150 / GEN-176: hand-written files are not imported from the sheet, so they get no import hint.
      if ((HAND_WRITTEN as readonly string[]).includes(set)) throw new AssetLoadError(`asset file ${file} is missing`);
      if ((REQUIRED_TABS as readonly string[]).includes(set)) throw new AssetLoadError(`asset file ${file} is missing (run "pnpm assets:import")`);
      continue;
    }
    try {
      raw[set] = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new AssetLoadError(`asset file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return raw;
}

/** Checks every data set and builds the lookups. `where(set)` names the source in an error. */
export function buildGameAssets(raw: RawDataSets, where: (set: DataSetName) => string = (set) => `game data set ${set}`): GameAssets {
  const tab = <T extends TabName>(set: T): TabRecords[T] | undefined => {
    if (raw[set] === undefined) {
      if ((REQUIRED_TABS as readonly string[]).includes(set)) throw new AssetLoadError(`${where(set)} is missing`, { '(root)': 'ไม่มีข้อมูล' });
      return undefined;
    }
    return parseSet(raw[set], set, where(set)) as TabRecords[T];
  };
  const abilities = tab('Ability')!;
  const items = tab('Item')!;
  const npcs = tab('NPC')!;
  const locations = tab('Location')!;
  const npcSchedule = tab('NPC_Schedule');
  const day10Strategies = tab('Day10_Strategies');

  const systemRules = tab('System_Rules')!;
  const karma = karmaTiersFrom(systemRules);
  if (!karma.ok) {
    throw new AssetLoadError(`${where('System_Rules')} has unusable "${KARMA_TIERS_CATEGORY}" rows (field mechanics): ${karma.problems.join('; ')}`, {
      mechanics: karma.problems.join('; '),
    });
  }
  if (raw.Server_Lines === undefined) throw new AssetLoadError(`${where('Server_Lines')} is missing`, { '(root)': 'ไม่มีข้อมูล' });
  const serverLines = parseSet(raw.Server_Lines, 'Server_Lines', where('Server_Lines')) as ServerLineRecord[];

  if (raw.Voice === undefined) throw new AssetLoadError(`${where('Voice')} is missing`, { '(root)': 'ไม่มีข้อมูล' });
  const voice = parseSet(raw.Voice, 'Voice', where('Voice')) as VoiceAsset;
  // A Public_Alias is what anyone may see, so it is not a name here (GEN-121).
  const names = [
    ...npcs.flatMap((n) => n.aliases.filter((a) => a !== n.publicAlias)),
    ...defaultScenario().npcs.flatMap((n) => [n.name, ...(n.otherNames ?? [])]),
  ];
  const leaks = realNamesInProfiles(voice, names);
  if (Object.keys(leaks).length > 0) throw new AssetLoadError(`${where('Voice')} has a real NPC name in: ${Object.keys(leaks).join(', ')}`, leaks);

  return {
    abilities,
    items,
    npcs,
    locations,
    startScenarios: tab('Start_Scenarios')!,
    systemRules,
    karmaTiers: karma.tiers,
    serverLines,
    voice,
    worldTimeline: tab('World_Timeline')!,
    ...(npcSchedule ? { npcSchedule } : {}),
    ...(day10Strategies ? { day10Strategies } : {}),
    ability: (name) => abilities.find((a) => a.name === name),
    item: (name) => items.find((i) => i.name === name || i.nameEn === name),
    npc: (name) => npcs.find((n) => n.name === name || n.aliases.some((alias) => aliasMatches(alias, name))),
    location: (name) => locations.find((l) => l.name === name),
  };
}

export const assetFileLabel = (dir: string) => (set: DataSetName) => `asset file ${join(dir, DATA_SET_FILES[set])}`;

export function loadGameAssets(dir: string = DEFAULT_ASSETS_DIR): GameAssets {
  return buildGameAssets(readRawDataSets(dir), assetFileLabel(dir));
}
