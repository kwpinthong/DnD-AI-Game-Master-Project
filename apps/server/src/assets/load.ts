/**
 * Game data the server uses (GEN-062): read from the JSON files in apps/server/assets at start,
 * never from Google while running. A file that is missing, not JSON or off-schema stops start-up
 * with an AssetLoadError naming the file and the field.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aliasMatches,
  OPTIONAL_TABS,
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
import { KARMA_TIERS_CATEGORY, karmaTiersFrom } from './karma.ts';

export const DEFAULT_ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

export class AssetLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetLoadError';
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
}

function fieldPath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '');
}

function readTab<T extends TabName>(dir: string, tab: T): TabRecords[T] | undefined {
  const file = join(dir, TAB_FILES[tab]);
  if (!existsSync(file)) {
    if ((REQUIRED_TABS as readonly string[]).includes(tab)) {
      throw new AssetLoadError(`asset file ${file} is missing (run "pnpm assets:import")`);
    }
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AssetLoadError(`asset file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = TAB_SCHEMAS[tab].safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.slice(0, 5).map((i) => `field ${fieldPath(i.path) || '(root)'}: ${i.message}`);
    throw new AssetLoadError(`asset file ${file} does not match the ${tab} schema: ${fields.join('; ')}`);
  }
  return parsed.data as TabRecords[T];
}

export function loadGameAssets(dir: string = DEFAULT_ASSETS_DIR): GameAssets {
  const abilities = readTab(dir, 'Ability')!;
  const items = readTab(dir, 'Item')!;
  const npcs = readTab(dir, 'NPC')!;
  const locations = readTab(dir, 'Location')!;
  const optional = Object.fromEntries(OPTIONAL_TABS.map((tab) => [tab, readTab(dir, tab)])) as {
    NPC_Schedule?: NpcScheduleRecord[];
    Day10_Strategies?: Day10StrategyRecord[];
  };

  const systemRules = readTab(dir, 'System_Rules')!;
  const karma = karmaTiersFrom(systemRules);
  if (!karma.ok) {
    throw new AssetLoadError(
      `asset file ${join(dir, TAB_FILES.System_Rules)} has unusable "${KARMA_TIERS_CATEGORY}" rows (field mechanics): ${karma.problems.join('; ')}`,
    );
  }

  return {
    abilities,
    items,
    npcs,
    locations,
    startScenarios: readTab(dir, 'Start_Scenarios')!,
    systemRules,
    karmaTiers: karma.tiers,
    worldTimeline: readTab(dir, 'World_Timeline')!,
    ...(optional.NPC_Schedule ? { npcSchedule: optional.NPC_Schedule } : {}),
    ...(optional.Day10_Strategies ? { day10Strategies: optional.Day10_Strategies } : {}),
    ability: (name) => abilities.find((a) => a.name === name),
    item: (name) => items.find((i) => i.name === name || i.nameEn === name),
    npc: (name) => npcs.find((n) => n.name === name || n.aliases.some((alias) => aliasMatches(alias, name))),
    location: (name) => locations.find((l) => l.name === name),
  };
}
