import { z } from 'zod';
import { RoomPhaseStatus, Turn } from './room.ts';
import { Phase, ScenarioLegendary } from './scenario.ts';
import { GmTimelineEvent } from './timeline.ts';
import { GmCharacterView, GmEvidenceView } from './visibility.ts';

/**
 * The Human GM console (GEN-058): every route under `/api/game/gm/` answers the Human GM only (a player
 * gets 403 and nothing else). Q-030: in a game with a Human GM each turn's result waits here until the GM
 * approves it (editing narration or the result first if they want); games without one publish at once.
 * Every change the GM makes is written to the override log with who, what and why.
 */

export const GM_CONSOLE_PATH = '/api/game/gm';

export const GmTurnPoint = z.strictObject({ day: z.number().int(), phase: Phase, turn: Turn });
export type GmTurnPoint = z.infer<typeof GmTurnPoint>;

/** One recorded action (any turn), Secret ones included. */
export const GmActionView = z.strictObject({
  memberId: z.string(),
  day: z.number().int(),
  phase: Phase,
  turn: Turn,
  text: z.string(),
  visibility: z.enum(['public', 'secret']),
  rest: z.boolean(),
});
export type GmActionView = z.infer<typeof GmActionView>;

export const GmStats = z.strictObject({ hp: z.number().int(), stamina: z.number().int(), karma: z.number().int() });
export type GmStats = z.infer<typeof GmStats>;

/** One entry of the held turn: `index` is what an edit names. */
export const GmPendingEntry = z.strictObject({
  index: z.number().int(),
  kind: z.enum(['feed', 'narration']),
  /** narration: its reader; feed: null. */
  memberId: z.string().nullable(),
  /** feed: its place (null = the whole town); narration: null. */
  locationId: z.string().nullable(),
  text: z.string(),
  /** The GM changed this text. */
  edited: z.boolean(),
});
export type GmPendingEntry = z.infer<typeof GmPendingEntry>;

/** A player's HP / Stamina / Karma now and as the held turn sets them (before the engine's own recovery). */
export const GmPendingResult = z.strictObject({ memberId: z.string(), before: GmStats, after: GmStats, edited: z.boolean() });
export type GmPendingResult = z.infer<typeof GmPendingResult>;

export const GmPendingTurn = z.strictObject({
  at: GmTurnPoint,
  entries: z.array(GmPendingEntry),
  results: z.array(GmPendingResult),
});
export type GmPendingTurn = z.infer<typeof GmPendingTurn>;

/** 200 from GET /api/game/gm/console. */
export const GmConsoleResponse = z.strictObject({
  view: z.literal('gm'),
  at: GmTurnPoint,
  status: RoomPhaseStatus,
  characters: z.array(GmCharacterView),
  evidence: z.array(GmEvidenceView),
  /** Every action of the game, Secret ones included, oldest first. */
  actions: z.array(GmActionView),
  events: z.array(GmTimelineEvent),
  /** The scenario's secret Legendary conditions with their progress. */
  legendaries: z.array(ScenarioLegendary),
  /** The turn that waits for approval; null = none (still collecting, or the AI GM is still working). */
  pending: GmPendingTurn.nullable(),
});
export type GmConsoleResponse = z.infer<typeof GmConsoleResponse>;

const Reason = z
  .string({ error: 'ต้องใส่เหตุผล' })
  .trim()
  .min(1, 'ต้องใส่เหตุผลของการแก้')
  .max(500, 'เหตุผลยาวได้ไม่เกิน 500 ตัวอักษร');
const Whole = z.number({ error: 'ต้องเป็นตัวเลข' }).int('ต้องเป็นจำนวนเต็ม');

/** POST /api/game/gm/turn/edit: changes to the held turn. Values are checked against the rules (C3). */
export const GmTurnEditRequest = z.strictObject({
  reason: Reason,
  narrations: z
    .array(z.strictObject({ index: Whole, text: z.string().trim().min(1, 'ข้อความห้ามว่าง').max(4000, 'ข้อความยาวได้ไม่เกิน 4000 ตัวอักษร') }))
    .default([]),
  results: z
    .array(z.strictObject({ memberId: z.string(), hp: Whole.optional(), stamina: Whole.optional(), karma: Whole.optional() }))
    .default([]),
});
export type GmTurnEditRequest = z.input<typeof GmTurnEditRequest>;

/** 200 from POST /api/game/gm/turn/approve: the turn that was published. */
export const GmApproveResponse = z.strictObject({ approved: GmTurnPoint });
export type GmApproveResponse = z.infer<typeof GmApproveResponse>;

/** 200 from POST /api/game/gm/events: the new event as the timeline now has it. */
export const GmInsertEventResponse = z.strictObject({ event: GmTimelineEvent });
export type GmInsertEventResponse = z.infer<typeof GmInsertEventResponse>;

/** POST /api/game/gm/adjust: one value set by hand between turns, within the rules (C3). */
export const GmAdjustRequest = z.discriminatedUnion(
  'field',
  [
    z.strictObject({ field: z.enum(['hp', 'stamina', 'karma']), memberId: z.string(), value: Whole, reason: Reason }),
    z.strictObject({ field: z.literal('affinity'), memberId: z.string(), npcId: z.string(), value: Whole, reason: Reason }),
  ],
  { error: 'field ต้องเป็น hp, stamina, karma หรือ affinity' },
);
export type GmAdjustRequest = z.infer<typeof GmAdjustRequest>;

/** POST /api/game/gm/events: a new event on the timeline, now or later in the game (C4). */
export const GmInsertEventRequest = z.strictObject({
  day: Whole,
  phase: Phase,
  title: z.string({ error: 'ต้องมีชื่อเหตุการณ์' }).trim().min(1, 'ต้องมีชื่อเหตุการณ์').max(120, 'ชื่อยาวได้ไม่เกิน 120 ตัวอักษร'),
  description: z.string().max(1000, 'รายละเอียดยาวได้ไม่เกิน 1000 ตัวอักษร').default(''),
  outcome: z.string().max(1000, 'ผลตั้งต้นยาวได้ไม่เกิน 1000 ตัวอักษร').default(''),
  locationId: z.string().nullable().default(null),
  reason: Reason,
});
export type GmInsertEventRequest = z.input<typeof GmInsertEventRequest>;

/** `approve` (Q-176): one row per approved turn, target `turn`, after `{ edits: n }` (0 = approved as the AI GM wrote it). */
export const GmOverrideKind = z.enum(['narration', 'result', 'adjust', 'event', 'approve']);
export type GmOverrideKind = z.infer<typeof GmOverrideKind>;

/** One override: who changed what, from what to what, and why. */
export const GmOverrideView = z.strictObject({
  id: z.number().int(),
  gmMemberId: z.string(),
  gmName: z.string(),
  kind: GmOverrideKind,
  /** The turn it belongs to (turn edits) or the turn the game was at. */
  at: GmTurnPoint,
  /** What was changed, e.g. `entry:2`, `<memberId>.hp`, `<memberId>.affinity.<npcId>`, `event:<id>`. */
  target: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string(),
  createdAt: z.number().int(),
});
export type GmOverrideView = z.infer<typeof GmOverrideView>;

/** 200 from GET /api/game/gm/log: oldest first. */
export const GmLogResponse = z.strictObject({ overrides: z.array(GmOverrideView) });
export type GmLogResponse = z.infer<typeof GmLogResponse>;

/** 200 from POST /api/game/gm/adjust: the override it logged. */
export const GmAdjustResponse = z.strictObject({ override: GmOverrideView });
export type GmAdjustResponse = z.infer<typeof GmAdjustResponse>;
