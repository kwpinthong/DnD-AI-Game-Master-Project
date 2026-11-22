import {
  LOOT_OPTION_MAX,
  LOOT_RANK,
  LOOT_REROLL_LIMIT,
  LOOT_SCOPES,
  TRAIT_VALUE,
  type BuffType,
  type LootChooseRequest,
  type LootEffect,
  type LootOption,
  type LootScope,
  type LootView,
  type TraitView,
} from '@isekai/protocol';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from '../auth/join.ts';
import { AiServiceError, type AiService } from '../ai/core/service.ts';
import type { PromptBlock } from '../ai/provider.ts';
import type { GameAssets } from '../assets/load.ts';
import type { AbilityRecord, ItemRecord } from '../assets/model.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { character, characterLoot, game } from '../db/schema.ts';
import type { MemberRow } from './service.ts';

/**
 * Personality-driven loot (GEN-048, GDD §4.1), from the Asset sheet since GEN-073. The AI reads the
 * personality and proposes one strength, one weakness (traits, Q-051) and the names of Rank B
 * Ability / Item rows whose tags fit it (Q-100). The server keeps only names that are Rank B rows of
 * the data, once each, at most 3 of each (C1-C3), and builds each option from its row, so the kept
 * skill / item carry the sheet's tags and numbers and tag matching (GEN-064) binds them by name (C4).
 * When the strength / weakness are unusable, or no skill or no item is left, the AI is asked to
 * repair once (Q-049); a second bad answer is an AI error and nothing changes.
 *
 * For the engine: `StoredChosen` maps onto ActorState as
 * - strength / weakness → StatusEffect { origin: 'trait', mods: [{ scope, value }], phasesLeft: null }
 * - every skill / item → OwnedRef { id, tier: 'Common' } (Rank B judged cap = 2, as Common)
 * - the sheet numbers → tag matching (`assets/tags.ts`); qualitative text is judged by the AI.
 * An old GEN-048 Common option (`LegacyOption`) keeps its `effect` (check_bonus → gear status,
 * damage_reduction, stamina_refund) so a game that started with one still works (GEN-073 C5).
 */

export interface StoredTrait extends TraitView {
  scope: LootScope;
  /** +2 strength, -2 weakness (Q-051). */
  value: number;
}
/** An option as GEN-048 stored it before the sheet: Common, with its own small effect. */
export interface LegacyOption {
  id: string;
  kind: LootOption['kind'];
  name: string;
  description: string;
  tier: 'Common';
  buffType: BuffType;
  effect: LootEffect | null;
}
/** What the loot JSON columns hold: a sheet-backed option (GEN-073) or an old one. */
export type StoredOption = LootOption | LegacyOption;
export const isLegacyOption = (o: StoredOption): o is LegacyOption => !('rank' in o);

export interface StoredOffer {
  strength: StoredTrait;
  weakness: StoredTrait;
  skills: StoredOption[];
  items: StoredOption[];
}
export interface StoredChosen {
  strength: StoredTrait;
  weakness: StoredTrait;
  skill: StoredOption;
  item: StoredOption;
}

/** An option as the player sees it; an old one shows as not in the sheet (rank null). */
export function optionView(o: StoredOption): LootOption {
  if (!isLegacyOption(o)) return o;
  return { id: o.id, kind: o.kind, name: o.name, description: o.description, rank: null, triggerType: null, dailyLimit: 0, verbTags: [], targetTags: [], effects: [] };
}

const LABEL_MAX = 30;
const DESCRIPTION_MAX = 200;

/** What the AI must answer: traits + row names. Loose on purpose: the rules are checked after. */
const RawTrait = z.object({ label: z.string(), scope: z.string(), description: z.string() });
export const LootProposal = z.object({
  strength: RawTrait,
  weakness: RawTrait,
  skills: z.array(z.string()),
  items: z.array(z.string()),
});
export type LootProposal = z.infer<typeof LootProposal>;

const fits = (text: string, max: number) => text.trim().length > 0 && [...text.trim()].length <= max;

function toTrait(raw: z.infer<typeof RawTrait>, value: number): StoredTrait | null {
  if (!fits(raw.label, LABEL_MAX) || !fits(raw.description, DESCRIPTION_MAX)) return null;
  if (!(LOOT_SCOPES as readonly string[]).includes(raw.scope)) return null;
  return { label: raw.label.trim(), description: raw.description.trim(), scope: raw.scope as LootScope, value };
}

const rankB = <T extends { rank: string }>(rows: readonly T[]) => rows.filter((r) => r.rank === LOOT_RANK);

function skillOption(row: AbilityRecord): LootOption {
  return {
    id: randomUUID(),
    kind: 'skill',
    name: row.name,
    description: row.description,
    rank: LOOT_RANK,
    triggerType: row.triggerType,
    dailyLimit: row.dailyLimit,
    verbTags: row.matchVerbTags,
    targetTags: row.matchTargetTags,
    effects: row.effects,
  };
}

function itemOption(row: ItemRecord): LootOption {
  return {
    id: randomUUID(),
    kind: 'item',
    name: row.nameEn,
    description: row.effect,
    rank: LOOT_RANK,
    triggerType: row.triggerType,
    dailyLimit: row.dailyLimit,
    verbTags: row.matchVerbTags,
    targetTags: row.matchTargetTags,
    effects: row.effects,
  };
}

/** The Rank B rows named in `names` (C1, C2), each once (C3), at most LOOT_OPTION_MAX. */
function keep<T>(names: readonly string[], find: (name: string) => T | undefined, make: (row: T) => LootOption): LootOption[] {
  const rows: T[] = [];
  for (const name of names) {
    const row = find(name.trim());
    if (row && !rows.includes(row)) rows.push(row);
  }
  return rows.slice(0, LOOT_OPTION_MAX).map(make);
}

/** The offer the rules allow from one AI answer, or what is missing (for the repair request). */
export function offerFrom(proposal: LootProposal, assets: GameAssets): { ok: true; offer: StoredOffer } | { ok: false; problems: string[] } {
  const strength = toTrait(proposal.strength, TRAIT_VALUE);
  const weakness = toTrait(proposal.weakness, -TRAIT_VALUE);
  const findSkill = (name: string) => {
    const row = assets.ability(name);
    return row?.rank === LOOT_RANK ? row : undefined;
  };
  const findItem = (name: string) => {
    const row = assets.item(name);
    return row?.rank === LOOT_RANK ? row : undefined;
  };
  const skills = keep(proposal.skills, findSkill, skillOption);
  const items = keep(proposal.items, findItem, itemOption);

  const problems: string[] = [];
  if (!strength) problems.push(`strength ใช้ไม่ได้ (label ≤ ${LABEL_MAX} ตัวอักษร, scope ต้องอยู่ในรายการ)`);
  if (!weakness) problems.push(`weakness ใช้ไม่ได้ (label ≤ ${LABEL_MAX} ตัวอักษร, scope ต้องอยู่ในรายการ)`);
  if (skills.length === 0) problems.push(`ไม่มี skill ที่ใช้ได้ (ต้องเป็นชื่อ skill Rank ${LOOT_RANK} ในรายการเท่านั้น สะกดตรงตัว)`);
  if (items.length === 0) problems.push(`ไม่มี item ที่ใช้ได้ (ต้องเป็นชื่อ item Rank ${LOOT_RANK} ในรายการเท่านั้น สะกดตรงตัว)`);
  if (!strength || !weakness || problems.length > 0) return { ok: false, problems };
  return { ok: true, offer: { strength, weakness, skills, items } };
}

const RULES_PROMPT = [
  'คุณคือ AI GM ของเกม Isekai Chronicles ขั้นสร้างตัวละคร: อ่านบุคลิกของผู้เล่น แล้ววิเคราะห์จุดแข็ง 1 ข้อ และจุดอ่อน 1 ข้อ',
  `จากนั้นเลือก skill และ item อย่างละไม่เกิน ${LOOT_OPTION_MAX} ชื่อ จากรายการ Rank ${LOOT_RANK} ข้างล่างเท่านั้น โดยเลือกตัวที่ tag เข้ากับบุคลิก`,
  'ตอบเป็นชื่อตามรายการตรงตัว (ภาษาอังกฤษ) ห้ามแต่งชื่อใหม่ ห้ามซ้ำ ชื่อที่ไม่อยู่ในรายการจะถูกตัดทิ้ง',
  `scope ที่ใช้ได้ของจุดแข็ง/จุดอ่อน: ${LOOT_SCOPES.join(', ')}`,
  `จุดแข็ง/จุดอ่อน: label สั้น ๆ ภาษาไทย ≤ ${LABEL_MAX} ตัวอักษร + scope 1 ตัว + description ≤ ${DESCRIPTION_MAX} ตัวอักษร ว่ามาจากบุคลิกส่วนไหน`,
  'ชื่อคนในข้อความเป็น token เช่น {{p:id}} ห้ามเดาหรือแต่งชื่อจริง',
].join('\n');

/**
 * The Rank B rows the AI may pick, one per line: `skill: <Name> | <verb tags> | <target tags> | <text>`
 * (items the same with `item:`). The default Mock reads these lines to answer offline.
 */
export function lootCatalogue(assets: GameAssets): string {
  const line = (kind: string, name: string, verbs: readonly string[], targets: readonly string[], text: string) =>
    `${kind}: ${name} | ${verbs.join(', ')} | ${targets.join(', ')} | ${text.replace(/\s+/g, ' ').trim()}`;
  return [
    `รายการ skill Rank ${LOOT_RANK} (ชื่อ | Verb tags | Target tags | คำอธิบาย):`,
    ...rankB(assets.abilities).map((a) => line('skill', a.name, a.matchVerbTags, a.matchTargetTags, a.description)),
    `รายการ item Rank ${LOOT_RANK} (ชื่อ | Verb tags | Target tags | ผล):`,
    ...rankB(assets.items).map((i) => line('item', i.nameEn, i.matchVerbTags, i.matchTargetTags, i.effect)),
  ].join('\n');
}

/** The personality with the character's and the player's names swapped for a token (Q-045). */
function tokenized(personality: string, names: string[], memberId: string): string {
  const token = `{{p:${memberId}}}`;
  return names
    .filter((n) => n.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((text, name) => text.split(name).join(token), personality);
}

export type LootOutcome =
  | { kind: 'ok'; loot: LootView }
  | { kind: 'gm_has_no_character' }
  | { kind: 'character_not_found' }
  | { kind: 'game_started' }
  | { kind: 'loot_closed' }
  | { kind: 'loot_no_offer' }
  | { kind: 'invalid'; fields: Partial<Record<keyof LootChooseRequest, string>> }
  | { kind: 'ai_error'; error: AiServiceError };

type LootRow = typeof characterLoot.$inferSelect;

function gameStarted(db: DbOrTx, gameId: string): boolean {
  const row = db.select({ startedAt: game.startedAt }).from(game).where(eq(game.id, gameId)).get();
  return (row?.startedAt ?? null) !== null;
}

const publicTrait = (t: StoredTrait): TraitView => ({ label: t.label, description: t.description });

/** The offer still on the table: an old GEN-048 Common one is gone (a new analysis is needed, C5). */
function currentOffer(row: LootRow | undefined): StoredOffer | null {
  const offer = row?.offerJson ? (JSON.parse(row.offerJson) as StoredOffer) : null;
  return offer && [...offer.skills, ...offer.items].some(isLegacyOption) ? null : offer;
}

function toView(row: LootRow | undefined, started: boolean): LootView {
  const offer = currentOffer(row);
  const kept = row?.chosenJson ? (JSON.parse(row.chosenJson) as StoredChosen) : null;
  // C5: an old Common set loads; before the start the player must choose again from the sheet.
  const needsNewChoice = !started && kept !== null && (isLegacyOption(kept.skill) || isLegacyOption(kept.item));
  const chosen = needsNewChoice ? null : kept;
  const rerollsUsed = row?.rerollsUsed ?? 0;
  const quotaLeft = LOOT_REROLL_LIMIT === null || rerollsUsed < LOOT_REROLL_LIMIT;
  return {
    offer: offer && {
      strength: publicTrait(offer.strength),
      weakness: publicTrait(offer.weakness),
      skills: offer.skills.map(optionView),
      items: offer.items.map(optionView),
    },
    chosen: chosen && {
      strength: publicTrait(chosen.strength),
      weakness: publicTrait(chosen.weakness),
      skill: optionView(chosen.skill),
      item: optionView(chosen.item),
    },
    rerollsUsed,
    rerollLimit: LOOT_REROLL_LIMIT,
    // Q-081: the choice stays changeable (reroll + choose again) until the game starts.
    canReroll: !started && (offer === null || quotaLeft),
    needsNewChoice,
  };
}

const lootRow = (db: DbOrTx, memberId: string) =>
  db.select().from(characterLoot).where(eq(characterLoot.memberId, memberId)).get();

/** Who may use the loot step: a player with a character. */
function precheck(db: DbOrTx, me: MemberRow): LootOutcome | typeof character.$inferSelect {
  if (me.role === 'gm') return { kind: 'gm_has_no_character' };
  const row = db.select().from(character).where(eq(character.memberId, me.id)).get();
  return row ?? { kind: 'character_not_found' };
}

const isOutcome = (value: unknown): value is LootOutcome => typeof value === 'object' && value !== null && 'kind' in value;

export function getLoot(db: Db, me: MemberRow): LootOutcome {
  const pre = precheck(db, me);
  if (isOutcome(pre)) return pre;
  return { kind: 'ok', loot: toView(lootRow(db, me.id), gameStarted(db, me.gameId)) };
}

/** Why a new set cannot be made now, if any. */
function closedReason(db: DbOrTx, me: MemberRow): LootOutcome | null {
  if (gameStarted(db, me.gameId)) return { kind: 'game_started' };
  const view = toView(lootRow(db, me.id), false);
  return view.canReroll ? null : { kind: 'loot_closed' };
}

/**
 * The first analysis or a reroll (unlimited, Q-029): asks the AI, then replaces the offer. A failed
 * AI call changes nothing and does not count as a reroll (C5).
 */
export async function rollLoot(db: Db, ai: AiService, assets: GameAssets, me: MemberRow, now: Clock): Promise<LootOutcome> {
  const pre = precheck(db, me);
  if (isOutcome(pre)) return pre;
  const closed = closedReason(db, me);
  if (closed) return closed;

  const personality = tokenized(pre.personality, [pre.name, me.name], me.id);
  const system: PromptBlock[] = [
    { id: 'rules', text: RULES_PROMPT, cache: false },
    { id: 'loot_catalogue', text: lootCatalogue(assets), cache: true },
  ];
  const messages: { role: 'user' | 'assistant'; text: string }[] = [
    { role: 'user', text: `ตัวละคร {{p:${me.id}}}\nบุคลิก:\n${personality}` },
  ];

  let result = await ai.call({
    gameId: me.gameId,
    purpose: 'character_analyze',
    system,
    messages,
    output: { name: 'loot_options', schema: LootProposal },
    maxOutputTokens: 2_000,
  });
  if (!result.ok) return { kind: 'ai_error', error: result.error };
  let checked = offerFrom(result.value, assets);

  if (!checked.ok) {
    // Repair once (Q-049): the same request plus the AI's answer and what was wrong with it.
    result = await ai.call({
      gameId: me.gameId,
      purpose: 'character_analyze',
      system,
      messages: [
        ...messages,
        { role: 'assistant', text: JSON.stringify(result.value) },
        { role: 'user', text: `คำตอบใช้ไม่ได้: ${checked.problems.join(' / ')}\nตอบใหม่ทั้งชุดตามกฎ` },
      ],
      output: { name: 'loot_options', schema: LootProposal },
      maxOutputTokens: 2_000,
    });
    if (!result.ok) return { kind: 'ai_error', error: result.error };
    checked = offerFrom(result.value, assets);
    if (!checked.ok) return { kind: 'ai_error', error: unusableAnswer() };
  }
  const offer = checked.offer;

  return db.transaction((tx) => {
    // Checked again: the AI call is slow and the game may have started meanwhile.
    const late = closedReason(tx, me);
    if (late) return late;
    // An answer for a personality edited meanwhile (Q-081) is dropped; a retry reads the new one.
    const current = tx.select({ personality: character.personality }).from(character).where(eq(character.memberId, me.id)).get();
    if (current?.personality !== pre.personality) return { kind: 'ai_error', error: staleAnswer() };
    const existing = lootRow(tx, me.id);
    const t = now();
    if (existing) {
      const rerollsUsed = existing.rerollsUsed + (currentOffer(existing) ? 1 : 0);
      tx.update(characterLoot)
        .set({ offerJson: JSON.stringify(offer), rerollsUsed, updatedAt: t })
        .where(eq(characterLoot.memberId, me.id))
        .run();
    } else {
      tx.insert(characterLoot).values({ memberId: me.id, offerJson: JSON.stringify(offer), chosenJson: null, rerollsUsed: 0, updatedAt: t }).run();
    }
    return { kind: 'ok', loot: toView(lootRow(tx, me.id), false) };
  });
}

/**
 * Keeps exactly one skill and one item from the current offer (C4), with the two traits. A new
 * choice before the start replaces the old one (Q-081).
 */
export function chooseLoot(db: Db, me: MemberRow, input: LootChooseRequest, now: Clock): LootOutcome {
  const pre = precheck(db, me);
  if (isOutcome(pre)) return pre;
  return db.transaction((tx) => {
    if (gameStarted(tx, me.gameId)) return { kind: 'game_started' };
    const offer = currentOffer(lootRow(tx, me.id));
    if (!offer) return { kind: 'loot_no_offer' };
    const skill = offer.skills.find((o) => o.id === input.skillIds[0]);
    const item = offer.items.find((o) => o.id === input.itemIds[0]);
    const fields: Partial<Record<keyof LootChooseRequest, string>> = {};
    if (!skill) fields.skillIds = 'skill ที่เลือกไม่อยู่ในตัวเลือก';
    if (!item) fields.itemIds = 'ไอเท็มที่เลือกไม่อยู่ในตัวเลือก';
    if (!skill || !item) return { kind: 'invalid', fields };

    const chosen: StoredChosen = { strength: offer.strength, weakness: offer.weakness, skill, item };
    tx.update(characterLoot)
      .set({ offerJson: null, chosenJson: JSON.stringify(chosen), updatedAt: now() })
      .where(eq(characterLoot.memberId, me.id))
      .run();
    return { kind: 'ok', loot: toView(lootRow(tx, me.id), false) };
  });
}

/** The AI answered twice but neither answer fits the rules. */
function unusableAnswer(): AiServiceError {
  return new AiServiceError('ai_unavailable', LOOT_AI_FAILED, 'room', 'loot answer unusable after repair');
}

/** The personality changed while the AI was answering. */
function staleAnswer(): AiServiceError {
  return new AiServiceError('ai_unavailable', LOOT_AI_FAILED, 'room', 'loot answer for an edited personality');
}

/** Q-081: editing the personality clears the offer and the choice (the reroll count stays). */
export function clearLoot(tx: DbOrTx, memberId: string, now: number): void {
  tx.update(characterLoot).set({ offerJson: null, chosenJson: null, updatedAt: now }).where(eq(characterLoot.memberId, memberId)).run();
}

export const LOOT_AI_FAILED = 'AI วิเคราะห์บุคลิกไม่สำเร็จ ลองใหม่อีกครั้ง (ไม่เสียโควต้าสุ่มใหม่)';
