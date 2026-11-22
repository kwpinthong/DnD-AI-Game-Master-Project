import { z } from 'zod';
import { Phase } from './scenario.ts';

/**
 * View-models for Screens and Flows v2 (GEN-086) that the server does not send yet (GEN-099). The web builds
 * on them now (on mocks, GEN-100); the backend task named in docs/contract.md sends them later and must
 * send exactly these shapes. Players get words, never numbers for DC / karma / affinity (C3, GEN-099 C2).
 */

// --- Q-198: difficulty as a word ---

/** Rules Spec DC ladder with the words players see (Q-198). */
export const DIFFICULTY_LADDER = [
  { dc: 5, word: 'ง่ายมาก' },
  { dc: 8, word: 'ง่าย' },
  { dc: 11, word: 'ปานกลาง' },
  { dc: 14, word: 'ยาก' },
  { dc: 17, word: 'ยากมาก' },
  { dc: 20, word: 'สุดขีด' },
  { dc: 23, word: 'แทบเป็นไปไม่ได้' },
] as const;
export const DifficultyWord = z.enum(['ง่ายมาก', 'ง่าย', 'ปานกลาง', 'ยาก', 'ยากมาก', 'สุดขีด', 'แทบเป็นไปไม่ได้']);
export type DifficultyWord = z.infer<typeof DifficultyWord>;

/** The word for a DC: the nearest ladder step, a tie goes to the harder one (Q-198). Server side only. */
export function difficultyWord(dc: number): DifficultyWord {
  let best: (typeof DIFFICULTY_LADDER)[number] = DIFFICULTY_LADDER[0];
  for (const step of DIFFICULTY_LADDER) if (Math.abs(step.dc - dc) <= Math.abs(best.dc - dc)) best = step;
  return best.word;
}

// --- F5: a roll as the player sees it ---

/** Crit / fumble are a natural 20 / 1 (Q-053). */
export const RollOutcome = z.enum(['success', 'failure', 'critical_success', 'critical_failure']);
export type RollOutcome = z.infer<typeof RollOutcome>;

/** Where a factor came from (GEN-064 tag matching log). `fate` is the hidden karma part: always `unknown`. */
export const RollFactorKind = z.enum(['skill', 'item', 'weather', 'place', 'status', 'trait', 'title', 'origin', 'fate', 'other']);
export type RollFactorKind = z.infer<typeof RollFactorKind>;

/** One ▲ / ▼ / ? line under "ดูเหตุ" (F5): same arrow size for every source, no number. */
export const RollFactor = z.strictObject({ label: z.string(), kind: RollFactorKind, dir: z.enum(['up', 'down', 'unknown']) });
export type RollFactor = z.infer<typeof RollFactor>;

/** The roll of the viewer's own action (F5): d20 face + difficulty word + outcome + factor arrows. */
export const RollView = z.strictObject({
  d20: z.number().int().min(1).max(20),
  difficulty: DifficultyWord,
  outcome: RollOutcome,
  factors: z.array(RollFactor),
});
export type RollView = z.infer<typeof RollView>;

// --- GEN-060: something another player did to you ---

/** Your own values that changed (own numbers are fine to show: HP -8, เหรียญ -12). */
export const HitChange = z.discriminatedUnion('stat', [
  z.strictObject({ stat: z.literal('hp'), delta: z.number().int() }),
  z.strictObject({ stat: z.literal('stamina'), delta: z.number().int() }),
  z.strictObject({ stat: z.literal('coins'), delta: z.number().int() }),
  z.strictObject({ stat: z.literal('item_lost'), name: z.string() }),
  z.strictObject({ stat: z.literal('skill_lost'), name: z.string() }),
  z.strictObject({ stat: z.literal('status'), name: z.string() }),
]);
export type HitChange = z.infer<typeof HitChange>;

/** The pinned "เกิดกับคุณ" card. `actor`: their appearance when the act was public or you noticed; null = "ไม่รู้ว่าใครทำ". */
export const HitView = z.strictObject({ actor: z.string().nullable(), changes: z.array(HitChange) });
export type HitView = z.infer<typeof HitView>;

// --- F4: companion bond as a word + a 6-step bar ---

export const BOND_STEPS = [
  { min: -Infinity, word: 'เกลียดชัง' },
  { min: -60, word: 'ไม่ไว้ใจ' },
  { min: -20, word: 'ห่างเหิน' },
  { min: 9, word: 'คุ้นเคย' },
  { min: 41, word: 'สนิท' },
  { min: 70, word: 'ผูกพัน' },
] as const;
export const BondWord = z.enum(['เกลียดชัง', 'ไม่ไว้ใจ', 'ห่างเหิน', 'คุ้นเคย', 'สนิท', 'ผูกพัน']);
export type BondWord = z.infer<typeof BondWord>;
export const BondView = z.strictObject({ word: BondWord, step: z.number().int().min(1).max(6) });
export type BondView = z.infer<typeof BondView>;

/** The bond a player sees for an affinity (F4). Server side only: the number never leaves the server. */
export function bondFor(affinity: number): BondView {
  let step = 0;
  BOND_STEPS.forEach((s, i) => {
    if (affinity >= s.min) step = i;
  });
  return { word: BOND_STEPS[step]!.word, step: step + 1 };
}

// --- GEN-066: zones and the travel sheet ---

export const PlaceZone = z.strictObject({ id: z.string(), name: z.string() });
export type PlaceZone = z.infer<typeof PlaceZone>;

/**
 * Labels of a destination on the travel sheet: `safe` ปลอดภัย, `restricted` เขตหวงห้าม (go = infiltrate, a
 * roll), `hazard` อันตราย (from day 5), `password` ตลาดมืดช่วงค่ำ, `rift` มิติพิศวง (one turn), `closed` (e.g.
 * the harbour from day 5).
 */
export const DestinationTag = z.enum(['safe', 'restricted', 'hazard', 'password', 'rift', 'closed']);
export type DestinationTag = z.infer<typeof DestinationTag>;

export const TravelDestination = z.strictObject({
  /** The id `RoomMove.to` takes. */
  id: z.string(),
  name: z.string(),
  tags: z.array(DestinationTag),
  /** One Thai line for the sheet, e.g. "ต้องมีสิทธิ์ หรือแทรกซึม (ทอย)"; null = none. */
  note: z.string().nullable(),
  /** `go` [ ไป ] or `infiltrate` [ แทรกซึม ]; null = cannot go now (closed). */
  action: z.enum(['go', 'infiltrate']).nullable(),
});
export type TravelDestination = z.infer<typeof TravelDestination>;

export const TravelZoneGroup = z.strictObject({
  zone: PlaceZone,
  /** Same zone as you: arrive now and still act this turn. Another zone: the trip is this turn. */
  sameZone: z.boolean(),
  /** Your own Stamina cost (1 same zone, 3 another zone). */
  staminaCost: z.number().int().min(0),
  arrives: z.enum(['now', 'next_turn']),
  destinations: z.array(TravelDestination),
});
export type TravelZoneGroup = z.infer<typeof TravelZoneGroup>;

/** 200 from GET /api/game/travel (pending, see docs/contract.md): the travel sheet from where you are. */
export const TravelResponse = z.strictObject({
  from: z.strictObject({ id: z.string(), name: z.string(), zone: PlaceZone }).nullable(),
  zones: z.array(TravelZoneGroup),
});
export type TravelResponse = z.infer<typeof TravelResponse>;

// --- GEN-069: action chips of a place ---

export const PlaceActionId = z.enum(['inn_rest', 'clinic_rest', 'train']);
export type PlaceActionId = z.infer<typeof PlaceActionId>;

/** A chip in the action box, e.g. โรงเตี๊ยม "พัก (5 เหรียญ)", กิลด์ "ฝึก TRAIN (วันนี้เหลือ 1)". */
export const PlaceActionView = z.strictObject({
  id: PlaceActionId,
  label: z.string(),
  /** Your own coins it costs; null = free. */
  costCoins: z.number().int().min(0).nullable(),
  /** Uses left today; null = no daily limit. */
  usesLeftToday: z.number().int().min(0).nullable(),
  /** Why it cannot be used now (Thai); null = it can. */
  blocked: z.string().nullable(),
});
export type PlaceActionView = z.infer<typeof PlaceActionView>;

// --- GEN-070: Astral Spirit and the omen (Q-192, Q-193) ---

export const OMEN_MAX_LENGTH = 200;

/**
 * You are an Astral Spirit (permanent death). Q-192: you get the public feed of every place, read-only.
 * Q-193: once per day in NOCTHERION you send one omen of ≤ 200 characters to ONE player you choose.
 */
export const AstralView = z.strictObject({
  since: z.strictObject({ day: z.number().int(), phase: Phase, turn: z.number().int().min(1).max(2) }),
  omen: z.strictObject({
    /** It is NOCTHERION and today's omen is not sent yet. */
    canSend: z.boolean(),
    /** Who you may send it to: a handle and how you know them (appearance, not the real name). */
    targets: z.array(z.strictObject({ ref: z.string(), label: z.string() })),
  }),
});
export type AstralView = z.infer<typeof AstralView>;

/** Client → server (`RoomClientMessage`). `to` = a target's `ref`; same text rules as an action, ≤ 200 characters. */
export const RoomOmen = z.object({ type: z.literal('omen'), to: z.string(), text: z.string() });
export type RoomOmen = z.infer<typeof RoomOmen>;

export const RoomOmenCode = z.enum(['empty', 'too_long', 'not_astral', 'not_noctherion', 'already_sent', 'unknown_target', 'game_ended']);
export type RoomOmenCode = z.infer<typeof RoomOmenCode>;
export const RoomOmenAccepted = z.strictObject({ type: z.literal('omen_accepted') });
export const RoomOmenRejected = z.strictObject({ type: z.literal('omen_rejected'), code: RoomOmenCode, message: z.string() });

// --- GEN-083: memory from earlier games ---

/** An ended game that passed the learning gate (> 8, GEN-079) and the caller was a member of. Its score is public. */
export const MemorySourceGame = z.strictObject({ id: z.string(), name: z.string(), score: z.number().min(1).max(10), endedAt: z.string() });
export type MemorySourceGame = z.infer<typeof MemorySourceGame>;

/** 200 from GET /api/memory/sources (pending GEN-083). */
export const MemorySourcesResponse = z.strictObject({ games: z.array(MemorySourceGame) });
export type MemorySourcesResponse = z.infer<typeof MemorySourcesResponse>;

/** The create-game memory toggle (pending: GEN-083 adds it as `CreateGameRequest.memory`). Default off. */
export const GameMemorySetting = z.object({
  enabled: z.boolean().default(false),
  sourceGameIds: z.array(z.string()).max(10).default([]),
});
export type GameMemorySetting = z.infer<typeof GameMemorySetting>;

/** What the lobby shows of the setting (pending: `GameView.memory`). */
export const GameMemoryView = z.strictObject({ enabled: z.boolean(), sources: z.array(z.strictObject({ id: z.string(), name: z.string() })) });
export type GameMemoryView = z.infer<typeof GameMemoryView>;

// --- GEN-078 / 079: rating after the end ---

export const RATING_MIN = 1;
export const RATING_MAX = 10;
export const RATING_COMMENT_MAX_LENGTH = 500;

/** Body of PUT /api/game/rating: one score per member, can be changed. */
export const GameRatingRequest = z.object({
  score: z.number({ error: 'เลือกคะแนน 1–10' }).int('เลือกคะแนน 1–10').min(RATING_MIN, 'เลือกคะแนน 1–10').max(RATING_MAX, 'เลือกคะแนน 1–10'),
  comment: z.string().trim().max(RATING_COMMENT_MAX_LENGTH, `ความเห็นยาวได้ไม่เกิน ${RATING_COMMENT_MAX_LENGTH} ตัวอักษร`).default(''),
});
export type GameRatingRequest = z.input<typeof GameRatingRequest>;

/**
 * The rating part of the end page. `average` is the game score (public, not a secret value). Eligible for
 * learning when average > 8 and raters ≥ half the members (Q-163, Q-164); `blocker` says which is missing.
 * `liked`: the `sourceRef`s (`${day}-${phase}-${turn}-${actionSeq}`, GEN-077 ADR) of the action → result
 * rows this viewer gave a 👍 (GEN-081 rulings).
 */
export const GameRatingView = z.strictObject({
  mine: z.strictObject({ score: z.number().int().min(RATING_MIN).max(RATING_MAX), comment: z.string() }).nullable(),
  liked: z.array(z.string()),
  average: z.number().nullable(),
  raters: z.number().int().min(0),
  members: z.number().int().min(0),
  eligible: z.boolean(),
  blocker: z.enum(['too_few_raters', 'score_too_low']).nullable(),
});
export type GameRatingView = z.infer<typeof GameRatingView>;

/** 200 from GET / PUT /api/game/rating and PUT / DELETE /api/game/rating/likes/:sourceRef. */
export const GameRatingResponse = z.strictObject({ rating: GameRatingView });
export type GameRatingResponse = z.infer<typeof GameRatingResponse>;

// --- GEN-084: Learning library (admin) ---

/**
 * Shapes follow `LearningEntry` of the GEN-077 ADR "Learning Across Games" (proposed): `type`, source game
 * snapshot, `content`, `tags`, `status`, `detail` per type. The library view leaves out the style entry's
 * `playerKey` (an HMAC the page has no use for). Rulings carry the difficulty word, never the DC number.
 */
export const LearningType = z.enum(['lore', 'feedback_note', 'ruling', 'style']);
export type LearningType = z.infer<typeof LearningType>;

const LearningBase = z.strictObject({
  id: z.string(),
  sourceGameId: z.string(),
  sourceGameName: z.string(),
  sourceScore: z.number().min(0).max(10),
  content: z.string(),
  tags: z.array(z.string()),
  status: z.enum(['active', 'suspended']),
  /** epoch ms */
  createdAt: z.number().int(),
});

export const LearningEntryView = z.discriminatedUnion('type', [
  LearningBase.extend({ type: z.literal('lore'), detail: z.strictObject({ endingPath: z.enum(['good', 'evil', 'neutral', 'none']), npcIds: z.array(z.string()) }) }),
  LearningBase.extend({ type: z.literal('feedback_note'), detail: z.strictObject({ fromComments: z.number().int().min(1) }) }),
  LearningBase.extend({
    type: z.literal('ruling'),
    detail: z.strictObject({
      sourceRef: z.string(),
      actionText: z.string(),
      check: z.enum(['ladder', 'pvp', 'auto', 'none']),
      dcLabel: z.string().nullable(),
      d20: z.number().int().min(1).max(20).nullable(),
      result: z.enum(['crit', 'success', 'fail', 'fumble', 'blocked', 'no_target', 'auto', 'none']),
      thumbs: z.number().int(),
      players: z.number().int(),
    }),
  }),
  LearningBase.extend({ type: z.literal('style'), detail: z.strictObject({ topVerbs: z.array(z.string()), secretShare: z.number().min(0).max(1) }) }),
]);
export type LearningEntryView = z.infer<typeof LearningEntryView>;

/** 200 from GET /api/admin/learning (and after a delete). */
export const LearningLibraryResponse = z.strictObject({
  entries: z.array(LearningEntryView),
  counts: z.strictObject({ lore: z.number().int(), feedback_note: z.number().int(), ruling: z.number().int(), style: z.number().int() }),
});
export type LearningLibraryResponse = z.infer<typeof LearningLibraryResponse>;

// --- GEN-082: player style across games (Q-167 player code) ---

/** Join form extras (pending: GEN-082 adds them to `JoinRequest`). */
export const JoinStyleFields = z.object({
  playerCode: z.string().trim().max(64).default(''),
  noStyle: z.boolean().default(false),
});
export type JoinStyleFields = z.input<typeof JoinStyleFields>;

/** Body of POST /api/style (look up), POST /api/style/delete and PUT /api/style/opt-out (with `optOut`). */
export const PlayerStyleRequest = z.object({ playerCode: z.string().trim().min(1, 'ใส่รหัสผู้เล่น'), optOut: z.boolean().optional() });
export type PlayerStyleRequest = z.input<typeof PlayerStyleRequest>;

export const PlayerStyleView = z.strictObject({
  verbs: z.array(z.strictObject({ verb: z.string(), count: z.number().int().min(1) })),
  summary: z.string(),
});
export type PlayerStyleView = z.infer<typeof PlayerStyleView>;

/** `style` null = nothing stored yet ("ยังไม่มีสไตล์ที่เก็บ"). */
export const PlayerStyleResponse = z.strictObject({ style: PlayerStyleView.nullable(), optOut: z.boolean() });
export type PlayerStyleResponse = z.infer<typeof PlayerStyleResponse>;
