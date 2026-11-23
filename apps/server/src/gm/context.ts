import type { ActionVisibility, Phase } from '@isekai/protocol';
import { karmaBand, type CrossPlayerState, type PeriodWeather, type TagContext, type Turn } from '@isekai/rules';
import { and, eq, isNull } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { PromptBlock } from '../ai/provider.ts';
import { sheetNpcFor } from '../companions/sheet.ts';
import { itemsInGame, skillsInGame } from '../crossplayer/items.ts';
import { isLegacyOption, type StoredOption } from '../game/loot.ts';
import { titleOf } from '../game/character.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, member } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { SKILL_FLAGS } from '../skills/unlock-rules.ts';
import { buildEventContext, type EventContext } from '../timeline/context.ts';
import { namesVisibleTo, presencesInGame } from '../visibility/store.ts';
import { activeConstraints, dayLog, journalFor, memoryFor } from './store.ts';

/**
 * What the AI GM sees (GEN-057, ADR "Isekai Chronicles - AI GM" §6). Every request is one JSON object in
 * the user message. Players are `{{p:<ref>}}` tokens (the presence ref other players see, GEN-050), NPCs
 * `{{n:<id>}}`; a real name never goes into a prompt (Q-045): action text is tokenised before it is sent.
 * Karma is a band (-2..+2), never the number. No context is logged.
 */

export const playerToken = (ref: string) => `{{p:${ref}}}`;
export const npcToken = (id: string) => `{{n:${id}}}`;
export const TOKEN_PATTERN = /\{\{([pn]):([A-Za-z0-9_-]+)\}\}/g;
/** GEN-152: any {{...}} left after the p / n tokens are rendered ({{place}}, a wrong kind, a half token) is dropped, never shown raw. */
export const stripStrayTokens = (text: string) => text.replace(/\{\{[^}]*\}\}|\{\{|\}\}/g, '').replace(/ {2,}/g, ' ');

/** Rough, on the safe side for Thai (one token per non-ASCII character). Used for the context budget. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return other + Math.ceil(ascii / 4);
}

/** ADR §6.2 hard caps per call. */
export const CONTEXT_BUDGET = {
  gm_adjudicate: 20_000,
  narrate_player: 6_000,
  narrate_place: 5_000,
  /** GEN-116: the narration context without the journal, plus the narration. */
  npc_dialogue: 6_000,
  summarize_day: 14_000,
  summarize_journal: 6_000,
  /** GEN-059: the ending (every event outcome + one entry per player). */
  finale: 10_000,
} as const;
/** ADR §6.2 / §6.3: what of a player's journal their narrator gets (saga ≤ 600 + yesterday ≤ 250 tokens). */
export const JOURNAL_BUDGET = { saga: 600, yesterday: 250 } as const;
/** How much of today's turn log the adjudicator gets (newest kept). */
const TODAY_LOG_TOKENS = 3_000;

// --- The game as the GM loop reads it ---

export interface GmPlayer {
  memberId: string;
  ref: string;
  name: string;
  appearance: string;
  socialTitle: string;
  locationId: string;
}

export interface GmWorld {
  gameId: string;
  players: Map<string, GmPlayer>;
  byRef: Map<string, GmPlayer>;
  /** `names`: every name the NPC_Schedule tab may call it by (real name, other names, the sheet's aliases). */
  npcs: { id: string; name: string; alias: string; rank: string; locationId: string; names: string[] }[];
  places: { id: string; name: string; safety: string; tags: string[] }[];
  /** Who knows whose real name (GEN-050 / GEN-067), by viewer. */
  knownNames: (viewerMemberId: string) => ReadonlySet<string>;
  /** Real names → tokens, longest first, for player-written text. */
  tokenise: (text: string) => string;
}

export function loadWorld(db: DbOrTx, gameId: string, assets: GameAssets): GmWorld {
  const scenario = getGameScenario(db, gameId);
  const presences = new Map(presencesInGame(db, gameId).map((p) => [p.memberId, p]));
  const rows = db
    .select({ c: character })
    .from(character)
    .innerJoin(member, eq(member.id, character.memberId))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt)))
    .all();
  const players = new Map<string, GmPlayer>();
  for (const { c } of rows) {
    const p = presences.get(c.memberId);
    if (!p) continue;
    players.set(c.memberId, { memberId: c.memberId, ref: p.ref, name: c.name, appearance: c.appearance, socialTitle: titleOf(c), locationId: p.locationId });
  }
  const npcs = (scenario?.npcs ?? []).map((n) => ({
    id: n.id,
    name: n.name,
    alias: n.alias,
    rank: n.rank,
    locationId: n.locationId,
    names: [...new Set([n.name, ...(n.otherNames ?? []), ...(sheetNpcFor(assets, n)?.record.aliases ?? [])])],
  }));
  const places = (scenario?.locations ?? []).map((l) => ({ id: l.id, name: l.name, safety: l.safety, tags: [...(assets.location(l.name)?.tags ?? [])] }));
  const names = [
    ...[...players.values()].map((p) => ({ name: p.name, token: playerToken(p.ref) })),
    ...npcs.map((n) => ({ name: n.name, token: npcToken(n.id) })),
  ]
    .filter((n) => n.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const known = new Map<string, ReadonlySet<string>>();
  return {
    gameId,
    players,
    byRef: new Map([...players.values()].map((p) => [p.ref, p])),
    npcs,
    places,
    knownNames: (viewer) => {
      let set = known.get(viewer);
      if (!set) known.set(viewer, (set = namesVisibleTo(db, viewer)));
      return set;
    },
    tokenise: (text) => names.reduce((out, n) => out.split(n.name).join(n.token), text),
  };
}

// --- gm_adjudicate ---

export interface TurnAction {
  actionId: string;
  memberId: string;
  text: string;
  visibility: ActionVisibility;
}

export interface PlayerContext {
  ref: string;
  appearance: string;
  socialTitle: string;
  place: string;
  hp: number;
  stamina: number;
  karmaBand: number;
  drowsy: boolean;
  /** `effect`: the qualitative text the AI judges (GEN-055); the numbers come through `tagSources`. */
  items: { id: string; name: string; tier: string; effect: string }[];
  skills: { id: string; name: string; tier: string; effect: string }[];
  tagSources: { id: string; kind: string; verbTags: string[]; targetTags: string[]; trigger: string; dailyLimit: number; usesToday: number }[];
  constraints: { id: number; text: string; reason: string; sinceDay: number }[];
  /** Timed curses on the player now (GEN-095): the server applies the d20 part; `effect` is the sheet text to judge the rest by. */
  curses: { label: string; source: string; effect: string }[];
}

export interface TurnContext {
  kind: 'gm_turn';
  turn: { day: number; phase: Phase; turn: Turn };
  /** The period's weather chosen by the AI GM within the server's limits (GEN-068, Q-089); null = none. */
  weather: string | null;
  /** Action ids in the server's order (GEN-060 §10.5). Answer every one, in this order. */
  order: string[];
  actions: { actionId: string; actor: string; place: string; visibility: ActionVisibility; text: string }[];
  /** Players who rest / sleep this turn (no action to judge). */
  resting: string[];
  players: PlayerContext[];
  places: { id: string; name: string; safety: string; tags: string[] }[];
  npcs: { id: string; alias: string; rank: string; place: string; curses: string[] }[];
  /** Every verb / target tag the game data has (GEN-064). */
  tagVocabulary: string[];
  events: { active: Omit<EventContext['active'][number], 'defaultOutcome'>[]; past: EventContext['past'] };
  memory: { saga: string | null; yesterday: string | null; today: string[] };
  /** GEN-118: last in the JSON, where the AI stops reading: the real AI stopped after an action with no effect and left the others out. */
  mustAnswer: string;
}

export interface TurnContextInput {
  world: GmWorld;
  state: CrossPlayerState;
  tags: Readonly<Record<string, TagContext>>;
  vocabulary: readonly string[];
  drowsy: ReadonlySet<string>;
  at: { day: number; phase: Phase; turn: Turn };
  /** In the server's order. */
  actions: readonly TurnAction[];
  resting: readonly string[];
  /** The period's weather (GEN-068); null = none chosen. */
  weather?: PeriodWeather | null;
  /** Game data: each skill / item's Rank and qualitative text (GEN-055). */
  assets?: GameAssets;
}

export function buildTurnContext(db: DbOrTx, input: TurnContextInput): TurnContext {
  const { world, state, at } = input;
  const skills = skillsInGame(db, world.gameId);
  const items = [...itemsInGame(db, world.gameId).values()];
  const gear = (o: StoredOption) => ({ id: o.id, name: world.tokenise(o.name), tier: optionTier(o, input.assets), effect: qualitativeText(o, input.assets) });
  const constraints = activeConstraints(db, world.gameId);
  const ref = (memberId: string) => world.players.get(memberId)?.ref ?? memberId;

  const players: PlayerContext[] = Object.values(state.players).flatMap((s) => {
    const p = world.players.get(s.id);
    if (!p) return [];
    const ctx = input.tags[s.id];
    return [
      {
        ref: p.ref,
        appearance: world.tokenise(p.appearance),
        socialTitle: p.socialTitle,
        place: s.locationId,
        hp: s.hp,
        stamina: s.stamina,
        karmaBand: karmaBand(s.karma),
        drowsy: input.drowsy.has(s.id),
        items: items.filter((i) => i.holderMemberId === s.id).map(gear),
        skills: (skills.get(s.id) ?? []).map(gear),
        tagSources: (ctx?.sources ?? []).map((src) => ({
          id: src.id,
          kind: src.kind,
          verbTags: [...src.verbTags],
          targetTags: [...src.targetTags],
          trigger: src.trigger,
          dailyLimit: src.dailyLimit,
          usesToday: ctx?.usesToday[src.id] ?? 0,
        })),
        constraints: constraints.filter((c) => c.memberId === s.id).map((c) => ({ id: c.id, text: c.text, reason: c.reason, sinceDay: c.day })),
        curses: s.statuses
          .filter((st) => st.origin === 'curse')
          .map((st) => ({ label: st.label, source: st.ref ?? '', effect: curseText(st.ref, input.assets) })),
      },
    ];
  });

  // GEN-093: with the assets, an active strategy event lists its Day10_Strategies plans.
  const events = buildEventContext(db, world.gameId, at.day, at.phase, input.assets);
  return {
    kind: 'gm_turn',
    turn: at,
    weather: input.weather ? weatherLabel(input.weather) : null,
    order: input.actions.map((a) => a.actionId),
    actions: input.actions.map((a) => ({
      actionId: a.actionId,
      actor: ref(a.memberId),
      place: state.players[a.memberId]?.locationId ?? '',
      visibility: a.visibility,
      text: world.tokenise(a.text),
    })),
    resting: input.resting.map(ref),
    players,
    places: world.places,
    npcs: world.npcs.map((n) => ({ id: n.id, alias: n.alias, rank: n.rank, place: n.locationId, curses: (state.npcs[n.id]?.statuses ?? []).filter((st) => st.origin === 'curse').map((st) => st.label) })),
    tagVocabulary: [...input.vocabulary],
    // GEN-111: the drift outcome describes what comes after (e.g. "วันที่ 7 และ 10"); an active event hands the AI only what it
    // happens now, so the narration cannot run ahead of the day.
    events: { active: events.active.map(({ defaultOutcome: _ahead, ...now }) => now), past: events.past },
    memory: memoryContext(db, world.gameId, at),
    mustAnswer: `actions ต้องมี ${input.actions.length} รายการ ตามลำดับ ${input.actions.map((a) => a.actionId).join(', ')} ทุกรายการแม้ไม่มีผลเชิงกลไก`,
  };
}

/** The longest start of `text` within `max` tokens (`estimateTokens`). */
export function withinTokens(text: string, max: number): string {
  if (estimateTokens(text) <= max) return text;
  let out = '';
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
    if (other + Math.ceil(ascii / 4) > max) break;
    out += ch;
  }
  return out;
}

/** A player's journal for their narrations on `day`, cut to the ADR budget (Q-153). */
export function narrationJournal(db: DbOrTx, memberId: string, day: number): NonNullable<NarrationContext['journal']> {
  const j = journalFor(db, memberId, day);
  return {
    saga: j.saga === null ? null : withinTokens(j.saga, JOURNAL_BUDGET.saga),
    yesterday: j.yesterday === null ? null : withinTokens(j.yesterday, JOURNAL_BUDGET.yesterday),
  };
}

/** Saga + yesterday's recap + today's turn log (newest kept within `TODAY_LOG_TOKENS`). */
export function memoryContext(db: DbOrTx, gameId: string, at: { day: number; phase: Phase; turn: Turn }): TurnContext['memory'] {
  const memory = memoryFor(db, gameId, at.day);
  const today: string[] = [];
  let used = 0;
  for (const line of [...dayLog(db, gameId, at.day, at)].reverse()) {
    const cost = estimateTokens(line);
    if (used + cost > TODAY_LOG_TOKENS) break;
    used += cost;
    today.unshift(line);
  }
  return { saga: memory.saga, yesterday: memory.yesterday, today };
}

// --- narrate_place / narrate_player ---

export type BeatKind = 'own_action' | 'affected' | 'public_action' | 'event' | 'evidence';

export interface Beat {
  /** The action the beat is about (`event:<id>` for a timeline event, `evidence:<id>` for found evidence). */
  actionId: string;
  kind: BeatKind;
  /** Player ref of who did it; null = unknown to this audience or nobody. */
  actor: string | null;
  /** Tokens only. */
  text: string;
  /** `crit` | `success` | `fail` | `fumble` | `no_target` | `skipped` | `scene`. */
  result: string;
  target: string | null;
  /** GEN-110: the scenario NPC the action is aimed at (talking to them directly = a key moment); null = none. */
  targetNpc: string | null;
  moved: { from: string; to: string } | null;
  items: string[];
}

export interface NarrationContext {
  kind: 'gm_narration';
  audience: { place: string } | { player: string };
  turn: { day: number; phase: Phase; turn: Turn };
  place: { id: string; name: string };
  /**
   * The only players the text may name, as {{p:ref}}. `self`: the reader of a private narration. `looks` = how the
   * player looks, only for someone the reader looked at (GEN-117; '' = do not describe them, a place feed has none);
   * `title` = the alias (Title Mask) NPCs and strangers know them by; `karmaBand` -2..+2 (GEN-110: how NPCs treat them, never the number).
   */
  cast: { ref: string; looks: string; title: string; self: boolean; karmaBand: number }[];
  /**
   * The NPCs of the place (tokens may name any of them). `here`: at the place now by NPC_Schedule + period + weather (GEN-110):
   * only these may speak (`npcLines`). `persona`: the sheet's personality (only when `here`), names as tokens;
   * `bonds`: each cast player's affinity (-/+) and whether they have met.
   */
  npcs: { id: string; alias: string; grade: string; here: boolean; persona: string | null; bonds: { player: string; affinity: number; met: boolean }[] }[];
  /** GEN-110: private NPC lines (`npcLines` of a player narration) are kept only when this is true: the reader's own action is Secret. */
  privateLines: boolean;
  /** In the server's order; write one or more segments for each, in the same order. */
  beats: Beat[];
  /** The reader's own journal (Q-153), for a private narration only; null for a place feed. */
  journal: { saga: string | null; yesterday: string | null } | null;
}

/** GEN-116: what the dialogue stage is given for one audience: its narration context (no journal) and the narration it follows. */
export interface DialogueContext extends Omit<NarrationContext, 'kind' | 'journal'> {
  kind: 'gm_dialogue';
  /** The narration the players already read, tokens only. */
  narration: string[];
  /** What the server will keep (the game's level): the AI should not write more. */
  limits: { dialoguePerNpc: number; reactionNpcs: number; privatePerPlayer: number };
}

/** `summarize_journal` (ADR §6.3, Q-153): one player's day from the entries that player received. */
export interface JournalContext {
  kind: 'gm_journal';
  day: number;
  /** The player's ref; their own entries say "คุณ" for them. */
  player: string;
  /** Their saga through the day before. */
  saga: string | null;
  /** What reached this player that day (feed + private narration), oldest first, tokens only. */
  seen: string[];
}

export interface DayContext {
  kind: 'gm_day';
  day: number;
  saga: string | null;
  log: string[];
}

// --- Prompts (static, cacheable) ---

const RULES_TEXT = [
  'คุณคือ Game Master ผู้ตัดสินอย่างเคร่งครัด (Strict Referee) ของเกม Isekai Chronicles ไม่ใช่ผู้ช่วยของผู้เล่น',
  '1. ห้ามเกราะตัวเอก: ห้ามลด DC หรือเพิ่ม modifier เพื่อช่วยผู้เล่น ความยากมาจากสถานการณ์จริงใน state เท่านั้น',
  '2. ตอบ action ครบทุกตัวตาม `order` ที่ให้มา ห้ามข้าม ห้ามสลับลำดับ ห้ามแต่ง actionId ใหม่ `actor` คือ ref ของผู้ทำ ทุก id ใน order ต้องมี 1 รายการใน actions เสมอ แม้ไม่มีผลเชิงกลไก / คลุมเครือ / ระบุเป้าไม่ได้ / ทำไม่ได้ (ตอบ kind general, check none, effects เป็น 0 / null แล้วอธิบายใน reason) จำนวน actions ต้องเท่ากับจำนวน order',
  '3. DC อยู่บนบันได 5, 8, 11, 14, 17, 20, 23 / staminaCost: general 3, complex 5 (opposed 6), exertion 7-10',
  '4. verbTags / targetTags ใช้ได้เฉพาะคำใน tagVocabulary ตรงตัวอักษร ห้ามคิดคำใหม่ ถ้าไม่มีคำที่เหมาะตอบ [] / activate ได้เฉพาะ tagSources ของผู้ทำที่ trigger เป็น active หรือ both และยังไม่ครบ dailyLimit (source ที่ trigger = passive ทำงานเอง ห้ามใส่ใน activate เด็ดขาด)',
  '5. ผู้เล่นที่ติด constraints (Constraint Lock) ยังติดอยู่จนกว่าคุณจะปลดใน constraints.release พร้อม reason ที่อธิบายว่าทำไมหลุด',
  '6. คุณไม่รู้ผลเต๋า เสนอ onSuccess และ onFail ให้สมเหตุสมผลทั้งคู่ ห้ามใส่ค่า HP / Stamina ใหม่เอง',
  '7. ห้ามเขียนชื่อจริงของตัวละคร ใช้ {{p:ref}} / {{n:id}} ที่ให้มาเท่านั้น',
  // Q-180
  '8. skillFlags / grants ของ action มีผลกับผู้ทำเมื่อ action นั้นสำเร็จเท่านั้น: skillFlags = เงื่อนไขปลดล็อกที่เกิดขึ้นจริงในเทิร์นนี้ ใช้ได้เฉพาะชื่อในรายการนี้: ' +
    [...SKILL_FLAGS].join(', ') +
    ' / grants = มอบสกิลที่เงื่อนไขครบแล้ว หรือสกิล / ไอเทมที่อยู่ในรางวัลของ NPC (npcId) ที่เปิดให้ผู้เล่นคนนี้แล้ว ไอเทมต้องมี npcId เสมอ นอกนั้นเว้นว่าง',
  // GEN-070
  '10. ผู้เล่น hp 0 คือสลบ: เป็นเป้าได้แค่ targetPlayer.intent steal / execute / rescue / execute ใช้กับผู้เล่นที่สลบเท่านั้น สำเร็จ = ตายถาวร (Astral Spirit) / ผู้เล่นที่พักฟื้นที่สถานพยาบาลโดนโจมตีหรือขโมยได้ แต่ execute ไม่ได้',
  // GEN-117
  '12. looksAt: ใส่ ref ของผู้เล่นที่ action นั้นตั้งใจมอง / สังเกต / คุยด้วยจริง ๆ (นอกเหนือจาก targetPlayer) เท่านั้น ถ้าไม่ได้มองใครตอบ [] (การเดินสำรวจ / มองไปรอบ ๆ ห้องทั่วไปไม่นับ ต้องจดจ้องคนนั้นโดยเฉพาะ) ผู้เล่นจะได้รับรูปลักษณ์ของคนที่มองเท่านั้น',
  '9. endingPath: เฉพาะตอนที่เหตุการณ์ kind finale (วันพิพากษา วันที่ 12) active เท่านั้น ถ้าผู้เล่นทำเส้นทางสำเร็จในเทิร์นนี้ ให้ตอบ good (ม่านปาฏิหาริย์เบี่ยงอุกกาบาต) / evil (ดูดซับพลังอุกกาบาต) / neutral (ร่วมกับ NPC ของเหตุการณ์ลบล้างผลเป็นศูนย์) ตาม interventionEffects ของเหตุการณ์นั้น โดยดูจากผลของวันที่ 1, 5, 7, 10 ใน past ด้วย นอกนั้นตอบ null',
  // GEN-093 (Q-203)
  '10. strategy ของ action: เฉพาะตอนที่เหตุการณ์ที่มี strategies (คืนวันที่ 10) active เท่านั้น ถ้า action เป็นส่วนหนึ่งของแผน ให้ตอบ id ของแผนจาก strategies ของเหตุการณ์ (ห้ามใช้ D10-DRIFT) และ role = leader (ผู้นำที่ทอยตัดสินแผน) หรือ support (ผู้ร่วมสนับสนุน) ผลสำเร็จมาจากเต๋าของ action นั้น นอกนั้นตอบ null',
  // GEN-118: the answer is mostly the time of the turn (about 175 tokens / s), so the free texts are short.
  '13. ตอบให้สั้น: intentSummary ไม่เกิน 40 ตัวอักษร / reason ไม่เกิน 80 ตัวอักษร (หนึ่งประโยค) / remember ตอบ [] เว้นแต่มีเรื่องสำคัญจริง ๆ / ห้ามมีข้อความนอก JSON',
  '11. eventOutcomes.side: ฝ่ายตาม interventionEffects ของเหตุการณ์ที่ผู้เล่นทำ ตอบ good / evil / neutral (interventionEffects ที่เขียนรวม เช่น Good/Neutral ให้เลือกฝ่ายเดียวที่ตรงกับสิ่งที่ผู้เล่นทำ) ถ้าไม่เข้าฝ่ายใดตอบ null / eventOutcomes.outcome เขียนเฉพาะสิ่งที่เกิดขึ้น ห้ามขึ้นต้น outcome ด้วยชื่อฝ่าย',
].join('\n');

const FINALE_TEXT = [
  'คุณคือผู้เล่าตอนจบของ Game Master เกมจบแล้ว ผลของตอนจบตัดสินแล้วใน context ห้ามเปลี่ยน (path, outcome ของแต่ละคน)',
  'overall = ตอนจบของทั้งเมืองที่ทุกคนอ่านร่วมกัน เล่าผลของ path จากเหตุการณ์ทั้งหมดใน events / players = ตอนจบส่วนตัวของผู้เล่นทุกคนใน context คนละ 1 รายการ ตาม outcome (survived = รอด, defeated = พ่ายแพ้) ระดับกรรม คู่หู และสิ่งที่ปกป้องเขา',
  'path: good = ม่านปาฏิหาริย์เบี่ยงอุกกาบาตปกป้องเมือง / evil = ดูดซับพลังอุกกาบาตครองโลก (ผู้เล่นฝ่ายดีพ่ายแพ้) / neutral = ร่วมกับ NPC ของเหตุการณ์ฉากจบลบล้างผลเป็นศูนย์ / none = อุกกาบาตชนเมือง (reason game_over = ทุกคนล้มลงก่อนถึงวันพิพากษา)',
  'ใช้ {{p:ref}} / {{n:id}} แทนชื่อเสมอ ห้ามเขียนชื่อจริง ห้ามตัวเลขกรรม',
].join('\n');
export const FINALE_BLOCK: PromptBlock = { id: 'finale-rules', text: FINALE_TEXT, cache: true };

const NARRATOR_TEXT = [
  'คุณคือผู้เล่าเรื่องของ Game Master เล่าเฉพาะ beats ที่ให้มา ตามลำดับ ทุก beat ต้องมีอย่างน้อย 1 segment ที่ actionId ตรงกับ beat',
  'ห้ามเล่าเรื่องที่ไม่อยู่ใน beats ห้ามอ้างคนที่ไม่อยู่ใน cast ใช้ {{p:ref}} / {{n:id}} แทนชื่อเสมอ ห้ามเขียนชื่อจริง',
  'audience แบบ place = ทุกคนที่อยู่ที่นั่นอ่านร่วมกัน / แบบ player = อ่านคนเดียว (self = คุณ)',
  // GEN-117
  'cast ที่ looks ว่าง = ผู้อ่านไม่ได้มองคนนั้น ห้ามบรรยายรูปร่างหน้าตา ผม ผิว เสื้อผ้า ของเขาเด็ดขาด บอกได้แค่ว่ามีคนอยู่และทำอะไร (เรียกด้วย token) / บรรยายรูปลักษณ์ได้เฉพาะ cast ที่ looks มีค่า และตามผลของ beat',
  // GEN-116: บทพูด NPC เป็นขั้นตอนที่สองแยกต่างหาก (DIALOGUE_TEXT) ที่นี่เล่าเฉพาะ segments ไม่ต้องเขียนบทพูด NPC
  'ห้ามใส่บทพูดของ NPC ลงใน segments (มีขั้นตอนแยกเขียนให้ทีหลัง) เล่าแค่ผลของ beats',
].join('\n');

/** GEN-116: the second stage. Same rules as GEN-110 had inside the narration; the narration is given so the lines follow it. */
const DIALOGUE_TEXT = [
  'คุณคือผู้เขียนบทพูดของ NPC ให้ Game Master ผลของเทิร์นและบทเล่า (narration) แสดงให้ผู้เล่นอ่านไปแล้ว เขียนเฉพาะบทพูด NPC ที่ต่อจากนั้น ห้ามเล่าซ้ำ',
  'npcLines = บทพูดของ NPC ที่อยู่ที่นี่ตอนนี้ (npcs ที่ here เป็น true ของ context เท่านั้น npcId ต้องตรง) ตอบ [] ได้เสมอ ไม่ต้องพูดทุกเทิร์น จำนวนสูงสุดอยู่ใน limits',
  '- audience place (ทุกคนอ่านร่วมกัน): kind dialogue = NPC พูดเรื่องที่ beat นั้นทำ / พูดกับผู้ทำ ไม่เกิน limits.dialoguePerNpc บรรทัดของ NPC เดียว (NPC ที่ beat เล็งถึงด้วย targetNpc) / kind reaction = NPC คนอื่นที่อยู่ที่นั่นตอบสนองคนละ 1 บรรทัด ไม่เกิน limits.reactionNpcs คน',
  '- audience player (อ่านคนเดียว): ใส่ npcLines ได้เฉพาะเมื่อ privateLines เป็น true (action ของผู้อ่านเป็นการกระทำลับ) เป็นสิ่งที่ NPC พูดกับผู้อ่านคนเดียว ไม่เกิน limits.privatePerPlayer บรรทัด นอกนั้นตอบ [] เสมอ (บทพูดต่อหน้าทุกคนอยู่ใน audience place แล้ว ห้ามซ้ำ)',
  '- ช่วงสำคัญ (beat มี targetNpc, ผู้เล่นเจอ NPC ครั้งแรก = bonds met เป็น false, หรือมี beat kind event) ให้พูดมากขึ้น เทิร์นธรรมดาพูดน้อย 0-2 บรรทัด',
  '- แต่ละบรรทัดสั้น ไม่เกิน 120 ตัวอักษร เป็นภาษาไทย พูดตาม persona ของ NPC นั้น และท่าทีต่อผู้เล่นตาม bonds (affinity สูง = เป็นมิตร ต่ำ = ระแวง), karmaBand (-2 โหดร้าย .. +2 ใจบุญ) และ looks / title ของผู้เล่น (NPC รู้จักผู้เล่นแค่รูปลักษณ์กับฉายา ห้ามเรียกชื่อจริง)',
  '- ห้ามเฉลยความลับ ชื่อจริง หรือกรรมเป็นตัวเลข ห้ามพูดถึงสิ่งที่ไม่อยู่ใน beats / ห้ามเล่าเรื่องของ action ลับให้คนอื่นรู้ ใช้ {{p:ref}} / {{n:id}} แทนชื่อ ห้ามใส่ HP / กรรม / เกรด',
].join('\n');

const SUMMARY_TEXT = 'สรุปวันที่จบไปของ Game Master: recap = เรื่องสำคัญของวันนี้ / saga = เรื่องทั้งหมดจนถึงวันนี้ย่อรวมกับ saga เดิม ใช้ token แทนชื่อเสมอ';

export const RULES_BLOCK: PromptBlock = { id: 'rules', text: RULES_TEXT, cache: true };
export const NARRATOR_BLOCK: PromptBlock = { id: 'narrator-rules', text: NARRATOR_TEXT, cache: true };
export const DIALOGUE_BLOCK: PromptBlock = { id: 'dialogue-rules', text: DIALOGUE_TEXT, cache: true };
export const SUMMARY_BLOCK: PromptBlock = { id: 'summary-rules', text: SUMMARY_TEXT, cache: true };

const JOURNAL_TEXT =
  'สรุปบันทึกส่วนตัวของผู้เล่นหนึ่งคนจาก seen (สิ่งที่ผู้เล่นคนนี้เห็นและได้รับรู้ในวันนั้นเท่านั้น): journal = เรื่องสำคัญของวันนี้จากมุมของเขา / saga = saga เดิมย่อรวมกับวันนี้ ห้ามเพิ่มเรื่องที่ไม่อยู่ใน seen ใช้ token แทนชื่อเสมอ ห้ามตัวเลข HP / กรรม';
export const JOURNAL_BLOCK: PromptBlock = { id: 'journal-rules', text: JOURNAL_TEXT, cache: true };

/** Tokens of a whole request (system + messages). */
export function requestTokens(system: readonly PromptBlock[], messages: readonly { text: string }[]): number {
  return estimateTokens([...system.map((b) => b.text), ...messages.map((m) => m.text)].join('\n'));
}

const sheetRow = (o: StoredOption, assets: GameAssets | undefined) => (o.kind === 'skill' ? assets?.ability(o.name) : assets?.item(o.name));

/** The tier the AI GM sees: an old GEN-048 option keeps "Common", a sheet row its Rank (GEN-055: B / A / S / SS). */
function optionTier(o: StoredOption, assets: GameAssets | undefined): string {
  if (isLegacyOption(o)) return o.tier;
  return `Rank ${sheetRow(o, assets)?.rank ?? o.rank ?? '?'}`;
}

/**
 * GEN-055: what the server does not compute (the qualitative half), as text the AI judges within the Rank cap:
 * the Ability Description / Item Effect, the item's skill-boost half of Skill Synergy, and the Note.
 * Never the unlock condition.
 */
function qualitativeText(o: StoredOption, assets: GameAssets | undefined): string {
  const row = sheetRow(o, assets);
  if (!row) return o.description;
  const boost = 'synergy' in row ? (/เสริมสกิล:\s*([^/]*)/.exec(row.synergy)?.[1]?.trim() ?? '') : '';
  const text = 'effect' in row ? row.effect : row.description;
  return [text, boost && `เสริมสกิล: ${boost}`, row.note].filter((s) => s.length > 0).join(' / ');
}

/** GEN-095: the sheet text of the row a curse came from (an Ability Description / Item Effect). */
function curseText(source: string | undefined, assets: GameAssets | undefined): string {
  if (source === undefined || assets === undefined) return '';
  const ability = assets.ability(source);
  if (ability) return ability.description;
  return assets.items.find((i) => i.nameEn === source)?.effect ?? '';
}

/** The weather as the AI GM reads it (GEN-068): the period's weather plus the day-5 Disaster state. */
function weatherLabel(w: PeriodWeather): string {
  return w.disaster ? `${w.weather} + Disaster` : w.weather;
}
