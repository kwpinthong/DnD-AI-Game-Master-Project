import type { EvolutionRule, NpcAlignment } from '@isekai/rules';
import type { GameAssets } from '../assets/load.ts';
import type { NpcRecord, Rank } from '../assets/model.ts';
import { EVOLUTION_RULES } from './evolution-rules.ts';

/** When a Rewards & Abilities segment opens: at the name reveal, for a quest (AI judged), at the base grade, after evolving. */
export type RewardStage = 'reveal' | 'quest' | 'base' | 'evolved';

export interface NpcRewardRef {
  /** Ability name or Item English name, as in the sheet. */
  readonly name: string;
  readonly kind: 'skill' | 'item';
}

export interface RewardSegment {
  readonly stage: RewardStage;
  /** "สาย Good: ..." segments open only on that evolution path. */
  readonly alignment: NpcAlignment | null;
  readonly rewards: readonly NpcRewardRef[];
}

/** One row of the NPC tab, read for companions (GEN-054). */
export interface SheetNpc {
  /** The first alias: the short name in the name cell. */
  readonly key: string;
  readonly record: NpcRecord;
  readonly grade: Rank;
  /** What players call a grade B NPC before the reveal. */
  readonly hiddenName: string;
  /** The real name (from the true-name cell for grade B; the short name otherwise). */
  readonly realName: string;
  /** Grade B: affinity that reveals the name ("ความสัมพันธ์ถึง +9"); null for the other grades. */
  readonly revealAffinity: number | null;
  readonly rewards: readonly RewardSegment[];
  readonly rule: EvolutionRule | null;
  /** The name after evolving on `alignment`'s path. */
  evolvedName(alignment: NpcAlignment | null): string;
}

const cache = new WeakMap<GameAssets, ReadonlyMap<string, SheetNpc>>();

/** Every NPC tab row by its key (first alias). Built once per loaded asset set. */
export function sheetNpcs(assets: GameAssets): ReadonlyMap<string, SheetNpc> {
  let built = cache.get(assets);
  if (!built) {
    built = new Map(assets.npcs.map((record) => [record.aliases[0]!, readNpc(assets, record)]));
    cache.set(assets, built);
  }
  return built;
}

/** The sheet NPC a scenario NPC stands for (by its name or alias), or undefined for a scenario-only NPC. */
export function sheetNpcFor(assets: GameAssets, npc: { readonly name: string; readonly alias: string }): SheetNpc | undefined {
  const record = assets.npc(npc.name) ?? assets.npc(npc.alias);
  return record ? sheetNpcs(assets).get(record.aliases[0]!) : undefined;
}

const ALIGNMENT_PREFIX = /^สาย (Good|Evil|Neutral)\s*:\s*/;
/** "Seraphiel, Herald of Dawn (SS)" → "Seraphiel, Herald of Dawn". */
const stripTrailingNote = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, '').trim();

function readNpc(assets: GameAssets, record: NpcRecord): SheetNpc {
  const key = record.aliases[0]!;
  const trueNames = record.trueName.split(' / ').map((segment) => {
    const m = ALIGNMENT_PREFIX.exec(segment);
    return { alignment: (m?.[1] as NpcAlignment | undefined) ?? null, name: stripTrailingNote(segment.slice(m?.[0].length ?? 0)) };
  });
  const reveal = record.grade === 'B' ? /ความสัมพันธ์ถึง \+(\d+)/.exec(record.unlockCondition) : null;
  return {
    key,
    record,
    grade: record.grade,
    hiddenName: key,
    realName: record.grade === 'B' ? (trueNames[0]?.name ?? key) : key,
    revealAffinity: reveal ? Number(reveal[1]) : null,
    rewards: record.rewards.split(' / ').map((segment) => rewardSegment(assets, record.grade, segment)),
    rule: EVOLUTION_RULES[key] ?? null,
    evolvedName: (alignment) => (trueNames.find((t) => t.alignment === alignment) ?? trueNames[0])?.name ?? key,
  };
}

function rewardSegment(assets: GameAssets, grade: Rank, segment: string): RewardSegment {
  const colon = segment.indexOf(':');
  const head = colon === -1 ? '' : segment.slice(0, colon);
  const alignment = (ALIGNMENT_PREFIX.exec(segment)?.[1] as NpcAlignment | undefined) ?? null;
  const stage: RewardStage =
    alignment !== null || colon === -1 || head.includes('เมื่อเลื่อน')
      ? 'evolved'
      : /ความสัมพันธ์ \+\d+/.test(head)
        ? 'reveal'
        : head.trim() === `เกรด ${grade}`
          ? 'base'
          : 'quest';
  // Every Ability / Item named in the segment, in the order they are written.
  const found = [
    ...assets.abilities.map((a) => ({ name: a.name, kind: 'skill' as const })),
    ...assets.items.map((i) => ({ name: i.nameEn, kind: 'item' as const })),
  ]
    .filter((r) => r.name !== '' && segment.includes(r.name))
    .sort((a, b) => segment.indexOf(a.name) - segment.indexOf(b.name));
  return { stage, alignment, rewards: found };
}
