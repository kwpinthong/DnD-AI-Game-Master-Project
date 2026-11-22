import type { OriginResponse, OriginView, Scenario } from '@isekai/protocol';
import { pickWeighted, RULES, type Rng, type StatusEffect, type TagSource } from '@isekai/rules';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AiService } from '../ai/core/service.ts';
import type { PromptBlock } from '../ai/provider.ts';
import type { GameAssets } from '../assets/load.ts';
import type { StartScenarioRecord } from '../assets/model.ts';
import { startPassiveSource } from '../assets/tags.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { character, characterLoot, characterOrigin, member, npcBond } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { PLACE_TAG } from '../travel/rules.ts';
import { placeCharacter } from '../visibility/store.ts';
import type { StoredChosen } from './loot.ts';
import type { MemberRow } from './service.ts';
import { CHRONIC_ILLNESS_LABEL, START_RULES } from './start-rules.ts';

/**
 * Start scenarios (GEN-065 on GEN-049's origin code, GDD §6.1, sheet Start_Scenarios).
 *
 * - `rollOrigins` runs inside the game-start transaction: per player (seat order) one weighted draw over
 *   every spawn point of the scenario. A spawn point's chance is its tier's weight (70 / 29 / 1) split by
 *   the Rate of its Start_Scenarios row (`label` = Name), so the default scenario gives each row its Rate.
 *   The row sets HP / Max HP, Stamina, Karma, Coins and Initial_Title, places the character at the spawn
 *   point's scenario place, and the special rows' rules (start-rules.ts) apply. Stored once: a restart
 *   never rolls again (C6).
 * - `narrateOrigins` asks the AI GM for each player's private crossing story (personality, chosen skill /
 *   item, the start scenario), names as `{{p:id}}` tokens (Q-045). A failed call leaves it null;
 *   `getOrigin` writes it on the player's next read (C8).
 * - The Pocket Dimension of GEN-045 / 049 is cut (Q-093 / Q-101): a legacy `pocket` tier rolls as the
 *   Astral Rift start.
 */

export type OriginRow = typeof characterOrigin.$inferSelect;
type OriginKind = OriginRow['kind'];

export interface SpawnChance {
  readonly tierId: string;
  readonly kind: OriginKind;
  readonly tierLabel: string;
  readonly spawnPointId: string;
  /** = the Start_Scenarios Name. */
  readonly label: string;
  /** Scenario place id. */
  readonly locationId: string;
  readonly row: StartScenarioRecord | undefined;
  /** In 1/100 of a percent (the default scenario adds up to 10000). */
  readonly weight: number;
}

const BASIS = 100;

/** The secret route of a legacy `pocket` tier: the Start_Scenarios row at the ASTRAL Location, at the scenario's place of that name. */
function legacyPocketPoints(scenario: Scenario, assets: GameAssets) {
  const astral = assets.locations.find((l) => l.tags.includes(PLACE_TAG.rift));
  const row = astral ? assets.startScenarios.find((s) => s.location === astral.name) : undefined;
  const place = astral ? scenario.locations.find((l) => l.name === astral.name) : undefined;
  return row && place ? [{ id: 'astral-drifter', label: row.name, locationId: place.id }] : [];
}

/** Every spawn point with its chance (see the module comment). */
export function spawnTable(scenario: Scenario, assets: GameAssets): SpawnChance[] {
  const out: SpawnChance[] = [];
  for (const tier of scenario.origins) {
    const points = tier.kind === 'pocket' ? legacyPocketPoints(scenario, assets) : tier.spawnPoints;
    if (points.length === 0) continue;
    const rows = points.map((p) => assets.startScenarios.find((s) => s.name === p.label));
    const rates = rows.every((r) => r !== undefined && r.rate > 0) ? rows.map((r) => r!.rate) : points.map(() => 1);
    const total = rates.reduce((sum, r) => sum + r, 0);
    points.forEach((p, i) => {
      out.push({
        tierId: tier.id,
        kind: tier.kind === 'pocket' ? 'secret' : tier.kind,
        tierLabel: tier.label,
        spawnPointId: p.id,
        label: p.label,
        locationId: p.locationId,
        row: rows[i],
        weight: Math.round((tier.weight * BASIS * rates[i]!) / total),
      });
    });
  }
  return out;
}

export function rollSpawn(table: readonly SpawnChance[], rng: Rng): SpawnChance {
  return pickWeighted(table.map((c) => ({ value: c, weight: c.weight })), rng);
}

/** Players of the game with a character, in seat (join) order. */
function seatedPlayers(db: DbOrTx, gameId: string) {
  return db
    .select({ memberId: character.memberId, characterName: character.name })
    .from(character)
    .innerJoin(member, eq(member.id, character.memberId))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt), eq(member.role, 'player')))
    .orderBy(asc(member.createdAt), sql`"member"."rowid"`)
    .all();
}

/** Rolls and stores every player's start scenario; players who already have one keep it. */
export function rollOrigins(db: DbOrTx, gameId: string, assets: GameAssets, rng: Rng, now: number): void {
  const scenario = getGameScenario(db, gameId);
  if (!scenario) return;
  const table = spawnTable(scenario, assets);
  if (table.length === 0) return;
  const rolled = new Set(db.select({ id: characterOrigin.memberId }).from(characterOrigin).where(eq(characterOrigin.gameId, gameId)).all().map((r) => r.id));

  for (const { memberId } of seatedPlayers(db, gameId)) {
    if (rolled.has(memberId)) continue;
    const chance = rollSpawn(table, rng);
    const row = chance.row;
    const rule = row ? START_RULES[row.name] : undefined;
    db.insert(characterOrigin)
      .values({
        memberId,
        gameId,
        tierId: chance.tierId,
        kind: chance.kind,
        spawnPointId: chance.spawnPointId,
        locationId: chance.locationId,
        startScenario: row?.name ?? null,
        illnessLeft: rule?.illnessTreatments ?? null,
        knowsDay12Secret: rule?.knowsDay12Secret ?? false,
        curseResistRank: rule?.curseResistRank ?? null,
        rolledAt: now,
      })
      .run();
    if (row) {
      db.update(character)
        .set({
          hp: Math.min(row.startHp, row.maxHp),
          hpMax: row.maxHp,
          stamina: Math.min(row.startStamina, RULES.staminaMax),
          karma: row.startKarma,
          coins: row.startCoins,
          initialTitle: row.initialTitle,
          updatedAt: now,
        })
        .where(eq(character.memberId, memberId))
        .run();
    }
    placeCharacter(db, gameId, memberId, chance.locationId, now);
    const met = rule?.meetsNpc ? scenario.npcs.find((n) => n.name === rule.meetsNpc) : undefined;
    if (met) db.insert(npcBond).values({ memberId, npcId: met.id, updatedAt: now }).onConflictDoNothing().run();
  }
}

export function originOf(db: DbOrTx, memberId: string): OriginRow | undefined {
  return db.select().from(characterOrigin).where(eq(characterOrigin.memberId, memberId)).get();
}

// --- What the start gives during play ---

export type TreatmentOutcome = { readonly kind: 'not_ill' } | { readonly kind: 'treated'; readonly treatmentsLeft: number };

/** One successful treatment of the chronic illness (HEAL / CLEANSE on the player): gone after the sheet's 2. */
export function treatChronicIllness(db: DbOrTx, memberId: string): TreatmentOutcome {
  const row = originOf(db, memberId);
  if (!row || row.illnessLeft === null || row.illnessLeft <= 0) return { kind: 'not_ill' };
  const treatmentsLeft = row.illnessLeft - 1;
  db.update(characterOrigin).set({ illnessLeft: treatmentsLeft }).where(eq(characterOrigin.memberId, memberId)).run();
  return { kind: 'treated', treatmentsLeft };
}

/**
 * The chronic illness as a status of the player while it lasts. The sheet gives it no number, so it has no
 * modifier: it is a fact for the AI GM (Q-090: numbers come only from the structured columns).
 */
export function originStatuses(db: DbOrTx, memberId: string): StatusEffect[] {
  const row = originOf(db, memberId);
  if (!row || row.illnessLeft === null || row.illnessLeft <= 0) return [];
  return [{ id: 'origin:chronic-illness', label: CHRONIC_ILLNESS_LABEL, polarity: 'debuff', origin: 'event', visible: true, mods: [], phasesLeft: null }];
}

/** "วันที่ 1-3" → days 1..3; anything else = every day. */
function dayRange(condition: string): { from: number; to: number } | null {
  const m = /^วันที่\s*(\d+)\s*-\s*(\d+)$/.exec(condition.trim());
  return m ? { from: Number(m[1]), to: Number(m[2]) } : null;
}

/** Each player's start passive (a d20 bonus, Passive_Verb_Tags / Passive_Value) as a tag source on game day `day`. */
export function startPassivesInGame(db: DbOrTx, gameId: string, assets: GameAssets, day: number): Record<string, TagSource[]> {
  const out: Record<string, TagSource[]> = {};
  for (const row of db.select().from(characterOrigin).where(eq(characterOrigin.gameId, gameId)).all()) {
    const record = row.startScenario ? assets.startScenarios.find((s) => s.name === row.startScenario) : undefined;
    const source = record ? startPassiveSource(record) : null;
    if (!record || !source) continue;
    const days = dayRange(record.passive.condition);
    if (days && (day < days.from || day > days.to)) continue;
    out[row.memberId] = [source];
  }
  return out;
}

// --- Narration ---

const NARRATION_MAX = 1500;
export const OriginNarration = z.object({ narration: z.string().trim().min(1).max(NARRATION_MAX) });

const RULES_PROMPT = [
  'คุณคือ AI GM ของเกม Isekai Chronicles: ผู้เล่นคนหนึ่งเพิ่งข้ามมายังต่างโลก',
  'เล่าเป็นภาษาไทยให้ผู้เล่นคนนี้อ่านคนเดียว ว่าทำไมและอย่างไรเขาจึงข้ามโลกมา โดยอิงบุคลิก skill และไอเท็มติดตัวของเขา',
  'แล้วจบที่จุดเกิดของเขา (ตามที่ให้มา: เขาเป็นใครในโลกนี้ และลืมตาขึ้นที่ไหน) เล่าแบบบุรุษที่สอง 1-3 ย่อหน้า',
  `ยาวไม่เกิน ${NARRATION_MAX} ตัวอักษร ห้ามใส่ตัวเลขค่าสถานะ (HP, Stamina, Coins, Karma, DC, โบนัส) ห้ามพูดถึงผู้เล่นคนอื่น`,
  'ชื่อคนเป็น token เช่น {{p:id}} ให้ใช้ token นั้นตรง ๆ ห้ามเดาหรือแต่งชื่อจริง',
].join('\n');

/** Every member and character name of the game swapped for its member's token (Q-045). */
function tokenize(text: string, names: { memberId: string; names: string[] }[]): string {
  const pairs = names
    .flatMap(({ memberId, names: list }) => list.filter((n) => n.trim().length > 0).map((n) => [n, `{{p:${memberId}}}`] as const))
    .sort((a, b) => b[0].length - a[0].length);
  return pairs.reduce((out, [name, token]) => out.split(name).join(token), text);
}

const placeName = (scenario: Scenario | null, id: string) => scenario?.locations.find((l) => l.id === id)?.name ?? id;
const recordOf = (assets: GameAssets, row: OriginRow) => (row.startScenario ? assets.startScenarios.find((s) => s.name === row.startScenario) : undefined);

function arrivalText(scenario: Scenario, assets: GameAssets, row: OriginRow): string {
  const record = recordOf(assets, row);
  return [
    `จุดเกิด: ${record?.name ?? row.spawnPointId} ที่ ${placeName(scenario, row.locationId)}`,
    record ? `ฉายาเริ่มต้น: ${record.initialTitle}` : '',
    record && record.passiveText ? `สิ่งที่ติดตัวมาจากจุดเกิด: ${record.passiveText}` : '',
    record && record.tags.length > 0 ? `แท็ก: ${record.tags.join(', ')}` : '',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}

const inFlight = new Map<string, Promise<void>>();

/** Writes one player's narration once; concurrent requests for the same player share one AI call. */
function narrateOne(db: Db, ai: Pick<AiService, 'call'>, assets: GameAssets, memberId: string, now: () => number): Promise<void> {
  const running = inFlight.get(memberId);
  if (running) return running;
  const job = (async () => {
    const row = originOf(db, memberId);
    if (!row || row.narration !== null) return;
    const scenario = getGameScenario(db, row.gameId);
    const me = db.select().from(character).where(eq(character.memberId, memberId)).get();
    if (!scenario || !me) return;
    const loot = db.select().from(characterLoot).where(eq(characterLoot.memberId, memberId)).get();
    const chosen = loot?.chosenJson ? (JSON.parse(loot.chosenJson) as StoredChosen) : null;
    // Every member's name (players and the Human GM) and character name becomes that member's token.
    const names = db
      .select({ memberId: member.id, playerName: member.name, characterName: character.name })
      .from(member)
      .leftJoin(character, eq(character.memberId, member.id))
      .where(eq(member.gameId, row.gameId))
      .all()
      .map((m) => ({ memberId: m.memberId, names: [m.playerName, m.characterName ?? ''] }));
    const safe = (text: string) => tokenize(text, names);

    const lines = [
      `ตัวละคร {{p:${memberId}}}`,
      `บุคลิก:\n${safe(me.personality)}`,
      chosen ? `skill ติดตัว: ${safe(chosen.skill.name)} — ${safe(chosen.skill.description)}` : 'skill ติดตัว: ไม่มี',
      chosen ? `ไอเท็มติดตัว: ${safe(chosen.item.name)} — ${safe(chosen.item.description)}` : 'ไอเท็มติดตัว: ไม่มี',
      safe(arrivalText(scenario, assets, row)),
    ];
    const system: PromptBlock[] = [
      { id: 'rules', text: RULES_PROMPT, cache: true },
      { id: 'scenario', text: safe(`เมือง: ${scenario.town.name}\n${scenario.town.mood}`), cache: true },
    ];
    const result = await ai.call({
      gameId: row.gameId,
      purpose: 'narrate_player',
      day: 1,
      phase: 'EOSORIA',
      system,
      messages: [{ role: 'user', text: lines.join('\n') }],
      output: { name: 'origin_narration', schema: OriginNarration },
      maxOutputTokens: 1_500,
    });
    if (!result.ok) return;
    db.update(characterOrigin)
      .set({ narration: result.value.narration, narratedAt: now() })
      .where(and(eq(characterOrigin.memberId, memberId), isNull(characterOrigin.narration)))
      .run();
  })().finally(() => inFlight.delete(memberId));
  inFlight.set(memberId, job);
  return job;
}

/** Writes every missing narration of the game in parallel. Failures leave them null (retried on read). */
export async function narrateOrigins(db: Db, ai: Pick<AiService, 'call'>, assets: GameAssets, gameId: string, now: () => number): Promise<void> {
  const missing = db
    .select({ memberId: characterOrigin.memberId })
    .from(characterOrigin)
    .where(and(eq(characterOrigin.gameId, gameId), isNull(characterOrigin.narration)))
    .all();
  await Promise.allSettled(missing.map((r) => narrateOne(db, ai, assets, r.memberId, now)));
}

function toView(scenario: Scenario | null, assets: GameAssets, row: OriginRow, characterName: string): OriginView {
  const tier = scenario?.origins.find((o) => o.id === row.tierId);
  const record = recordOf(assets, row);
  const narration =
    row.narration === null ? null : row.narration.split(`{{p:${row.memberId}}}`).join(characterName).replace(/\{\{p:[^}]*\}\}/g, 'ใครบางคน');
  return {
    kind: row.kind,
    tierLabel: tier?.label ?? row.tierId,
    spawnLabel: record?.name ?? row.spawnPointId,
    location: { id: row.locationId, name: placeName(scenario, row.locationId) },
    initialTitle: record?.initialTitle ?? '',
    passive: record?.passiveText ?? '',
    illness: row.illnessLeft === null ? null : { treatmentsLeft: row.illnessLeft },
    narration,
  };
}

/**
 * GET /api/game/origin. A player gets only their own start scenario (null before the start); a missing
 * narration is written first. The Human GM gets every player's, in seat order.
 */
export async function getOrigin(db: Db, ai: Pick<AiService, 'call'>, assets: GameAssets, me: MemberRow, now: () => number): Promise<OriginResponse> {
  const scenario = getGameScenario(db, me.gameId);
  if (me.role === 'gm') {
    const rows = new Map(db.select().from(characterOrigin).where(eq(characterOrigin.gameId, me.gameId)).all().map((r) => [r.memberId, r]));
    const origins = seatedPlayers(db, me.gameId).flatMap((p) => {
      const row = rows.get(p.memberId);
      return row ? [{ memberId: p.memberId, ...toView(scenario, assets, row, p.characterName) }] : [];
    });
    return { view: 'gm', origins };
  }

  let row = originOf(db, me.id);
  if (!row) return { view: 'player', origin: null };
  if (row.narration === null) {
    await narrateOne(db, ai, assets, me.id, now);
    row = originOf(db, me.id)!;
  }
  const own = db.select({ name: character.name }).from(character).where(eq(character.memberId, me.id)).get();
  return { view: 'player', origin: toView(scenario, assets, row, own?.name ?? '') };
}
