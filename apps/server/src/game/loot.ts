import {
  BUFF_TYPES,
  LOOT_EFFECT_TYPES,
  LOOT_OPTION_MAX,
  LOOT_REROLL_LIMIT,
  LOOT_SCOPES,
  LOOT_TIER,
  LootEffect,
  TRAIT_VALUE,
  type LootChooseRequest,
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
import type { Db, DbOrTx } from '../db/client.ts';
import { character, characterLoot, game } from '../db/schema.ts';
import type { MemberRow } from './service.ts';

/**
 * Personality-driven loot (GEN-048, GDD §4.1). The AI reads the personality and proposes one
 * strength, one weakness (traits, Q-051) and Common skills / items. The server keeps only what the
 * rules allow: Common tier, at most 3 of each, Quantitative effects the engine can apply (C2, C3).
 * When the strength / weakness are unusable, or no skill or no item is left, the AI is asked to
 * repair once (Q-049); a second bad answer is an AI error and nothing changes (C5).
 *
 * For GEN-057 / the engine: `StoredChosen` maps onto ActorState as
 * - strength / weakness → StatusEffect { origin: 'trait', mods: [{ scope, value }], phasesLeft: null }
 * - check_bonus → StatusEffect { origin: 'gear', ref: option id, mods: [{ scope, value }] }
 * - damage_reduction → ActorState.damageReduction, stamina_refund → ActorState.afterActionStamina
 * - every skill / item → OwnedRef { id, tier: 'Common' } (Qualitative ones are judged by the AI).
 */

export interface StoredTrait extends TraitView {
  scope: LootScope;
  /** +2 strength, -2 weakness (Q-051). */
  value: number;
}
export interface StoredOffer {
  strength: StoredTrait;
  weakness: StoredTrait;
  skills: LootOption[];
  items: LootOption[];
}
export interface StoredChosen {
  strength: StoredTrait;
  weakness: StoredTrait;
  skill: LootOption;
  item: LootOption;
}

const LABEL_MAX = 30;
const NAME_MAX = 40;
const DESCRIPTION_MAX = 200;

/** What the AI must answer. Loose on purpose: the rules are checked after, option by option. */
const RawTrait = z.object({ label: z.string(), scope: z.string(), description: z.string() });
const RawOption = z.object({
  name: z.string(),
  description: z.string(),
  tier: z.string(),
  buffType: z.string(),
  effect: z
    .object({ type: z.string(), scope: z.string().optional(), value: z.number().optional() })
    .nullable()
    .optional(),
});
export const LootProposal = z.object({
  strength: RawTrait,
  weakness: RawTrait,
  skills: z.array(RawOption),
  items: z.array(RawOption),
});
export type LootProposal = z.infer<typeof LootProposal>;

const fits = (text: string, max: number) => text.trim().length > 0 && [...text.trim()].length <= max;

function toTrait(raw: z.infer<typeof RawTrait>, value: number): StoredTrait | null {
  if (!fits(raw.label, LABEL_MAX) || !fits(raw.description, DESCRIPTION_MAX)) return null;
  if (!(LOOT_SCOPES as readonly string[]).includes(raw.scope)) return null;
  return { label: raw.label.trim(), description: raw.description.trim(), scope: raw.scope as LootScope, value };
}

/** One offered option, or null when the rules do not allow it (C2 tier, C3 effect). */
function toOption(raw: z.infer<typeof RawOption>, kind: LootOption['kind']): LootOption | null {
  if (raw.tier !== LOOT_TIER) return null;
  if (!(BUFF_TYPES as readonly string[]).includes(raw.buffType)) return null;
  if (!fits(raw.name, NAME_MAX) || !fits(raw.description, DESCRIPTION_MAX)) return null;
  let effect: LootEffect | null = null;
  if (raw.buffType === 'Quantitative') {
    const parsed = LootEffect.safeParse(raw.effect);
    if (!parsed.success) return null;
    effect = parsed.data;
  }
  return {
    id: randomUUID(),
    kind,
    name: raw.name.trim(),
    description: raw.description.trim(),
    tier: LOOT_TIER,
    buffType: raw.buffType as LootOption['buffType'],
    effect,
  };
}

/** The offer the rules allow from one AI answer, or what is missing (for the repair request). */
export function offerFrom(proposal: LootProposal): { ok: true; offer: StoredOffer } | { ok: false; problems: string[] } {
  const strength = toTrait(proposal.strength, TRAIT_VALUE);
  const weakness = toTrait(proposal.weakness, -TRAIT_VALUE);
  const keep = (list: z.infer<typeof RawOption>[], kind: LootOption['kind']) =>
    list.map((raw) => toOption(raw, kind)).filter((o): o is LootOption => o !== null).slice(0, LOOT_OPTION_MAX);
  const skills = keep(proposal.skills, 'skill');
  const items = keep(proposal.items, 'item');

  const problems: string[] = [];
  if (!strength) problems.push(`strength ใช้ไม่ได้ (label ≤ ${LABEL_MAX} ตัวอักษร, scope ต้องอยู่ในรายการ)`);
  if (!weakness) problems.push(`weakness ใช้ไม่ได้ (label ≤ ${LABEL_MAX} ตัวอักษร, scope ต้องอยู่ในรายการ)`);
  if (skills.length === 0) problems.push('ไม่มี skill ที่ใช้ได้ (ต้องเป็น tier Common และ effect ตามรายการ)');
  if (items.length === 0) problems.push('ไม่มี item ที่ใช้ได้ (ต้องเป็น tier Common และ effect ตามรายการ)');
  if (!strength || !weakness || problems.length > 0) return { ok: false, problems };
  return { ok: true, offer: { strength, weakness, skills, items } };
}

const RULES_PROMPT = [
  'คุณคือ AI GM ของเกม Isekai Chronicles ขั้นสร้างตัวละคร: อ่านบุคลิกของผู้เล่น แล้ววิเคราะห์จุดแข็ง 1 ข้อ และจุดอ่อน 1 ข้อ',
  `จากนั้นเสนอ skill และ item อย่างละไม่เกิน ${LOOT_OPTION_MAX} ตัวเลือกที่เข้ากับบุคลิก ทุกตัวเลือกต้องเป็น tier "${LOOT_TIER}" เท่านั้น`,
  'แต่ละตัวเลือกมี buffType:',
  '- "Qualitative": ผลเชิงเรื่องเล่า GM ตัดสินตามสถานการณ์ ไม่ต้องมี effect',
  '- "Quantitative": ผลเป็นตัวเลขที่ระบบคิดเอง ต้องมี effect แบบใดแบบหนึ่งต่อไปนี้ (value 1-2):',
  `  { "type": "check_bonus", "scope": <scope>, "value": 1-2 } บวกการทอยที่ตรง scope`,
  '  { "type": "damage_reduction", "value": 1-2 } ลดความเสียหายที่ได้รับ',
  '  { "type": "stamina_refund", "value": 1-2 } คืน Stamina หลังทำ action',
  `effect ชนิดอื่น (${LOOT_EFFECT_TYPES.length} ชนิดข้างบนเท่านั้น) หรือค่าเกิน 2 จะถูกตัดทิ้ง`,
  `scope ที่ใช้ได้ (ทั้ง effect และจุดแข็ง/จุดอ่อน): ${LOOT_SCOPES.join(', ')}`,
  `จุดแข็ง/จุดอ่อน: label สั้น ๆ ภาษาไทย ≤ ${LABEL_MAX} ตัวอักษร + scope 1 ตัว + description ว่ามาจากบุคลิกส่วนไหน`,
  `ชื่อตัวเลือก ≤ ${NAME_MAX} ตัวอักษร คำอธิบาย ≤ ${DESCRIPTION_MAX} ตัวอักษร เขียนภาษาไทย`,
  'ชื่อคนในข้อความเป็น token เช่น {{p:id}} ห้ามเดาหรือแต่งชื่อจริง',
].join('\n');

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

function toView(row: LootRow | undefined, started: boolean): LootView {
  const offer = row?.offerJson ? (JSON.parse(row.offerJson) as StoredOffer) : null;
  const chosen = row?.chosenJson ? (JSON.parse(row.chosenJson) as StoredChosen) : null;
  const rerollsUsed = row?.rerollsUsed ?? 0;
  const quotaLeft = LOOT_REROLL_LIMIT === null || rerollsUsed < LOOT_REROLL_LIMIT;
  return {
    offer: offer && {
      strength: publicTrait(offer.strength),
      weakness: publicTrait(offer.weakness),
      skills: offer.skills,
      items: offer.items,
    },
    chosen: chosen && {
      strength: publicTrait(chosen.strength),
      weakness: publicTrait(chosen.weakness),
      skill: chosen.skill,
      item: chosen.item,
    },
    rerollsUsed,
    rerollLimit: LOOT_REROLL_LIMIT,
    canReroll: !chosen && !started && (offer === null || quotaLeft),
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
export async function rollLoot(db: Db, ai: AiService, me: MemberRow, now: Clock): Promise<LootOutcome> {
  const pre = precheck(db, me);
  if (isOutcome(pre)) return pre;
  const closed = closedReason(db, me);
  if (closed) return closed;

  const personality = tokenized(pre.personality, [pre.name, me.name], me.id);
  const system: PromptBlock[] = [{ id: 'rules', text: RULES_PROMPT, cache: true }];
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
  let checked = offerFrom(result.value);

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
    checked = offerFrom(result.value);
    if (!checked.ok) return { kind: 'ai_error', error: unusableAnswer() };
  }
  const offer = checked.offer;

  return db.transaction((tx) => {
    // Checked again: the AI call is slow and the game may have started, or the choice been made.
    const late = closedReason(tx, me);
    if (late) return late;
    const existing = lootRow(tx, me.id);
    const t = now();
    if (existing) {
      const rerollsUsed = existing.rerollsUsed + (existing.offerJson ? 1 : 0);
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

/** Keeps exactly one skill and one item from the current offer (C4), with the two traits. */
export function chooseLoot(db: Db, me: MemberRow, input: LootChooseRequest, now: Clock): LootOutcome {
  const pre = precheck(db, me);
  if (isOutcome(pre)) return pre;
  return db.transaction((tx) => {
    if (gameStarted(tx, me.gameId)) return { kind: 'game_started' };
    const row = lootRow(tx, me.id);
    if (row?.chosenJson) return { kind: 'loot_closed' };
    if (!row?.offerJson) return { kind: 'loot_no_offer' };
    const offer = JSON.parse(row.offerJson) as StoredOffer;
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

export const LOOT_AI_FAILED = 'AI วิเคราะห์บุคลิกไม่สำเร็จ ลองใหม่อีกครั้ง (ไม่เสียโควต้าสุ่มใหม่)';
