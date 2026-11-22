import { z } from 'zod';
import { MemberRole } from './game.ts';
import { Phase } from './scenario.ts';
import { PlaceView } from './visibility.ts';
import { PeriodWeather } from './weather.ts';
import { AstralView, HitView, PlaceActionId, PlaceActionView, RollView, RoomOmen, TurnChange, RoomOmenAccepted, RoomOmenRejected } from './view-models.ts';

/**
 * The play room (GEN-056): one WebSocket per browser tab at `ROOM_PATH`. The browser cannot set an
 * Authorization header on a WebSocket, so the bearer token goes in the first message (`hello`), never in
 * the URL (URLs end up in logs). Every server message is strict: a new field is a deliberate change.
 */
export const ROOM_PATH = '/api/game/room';

/** Longest action, in Unicode code points after normalisation (Thai marks count). */
export const ACTION_MAX_LENGTH = 1000;

/** How long the server waits for `hello` before it closes the socket. */
export const ROOM_HELLO_TIMEOUT_MS = 10_000;

export const ActionVisibility = z.enum(['public', 'secret'], { error: 'เลือก Public หรือ Secret' });
export type ActionVisibility = z.infer<typeof ActionVisibility>;

/**
 * NFC, outer whitespace off, line breaks kept. Not NFKC: NFKC splits Thai sara am (ำ U+0E33) into
 * nikhahit + sara aa, so "สำรวจ" would come back as a different string.
 */
export const normalizeActionText = (raw: string) => raw.normalize('NFC').trim();

export type ActionTextProblem = { code: 'empty' | 'too_long'; message: string } | null;

/** The text check the server makes (C5); the web runs it too so the player sees the reason before sending. */
export function actionTextProblem(raw: string): ActionTextProblem {
  const text = normalizeActionText(raw);
  if (text.length === 0) return { code: 'empty', message: 'พิมพ์ action ก่อนส่ง' };
  if ([...text].length > ACTION_MAX_LENGTH) {
    return { code: 'too_long', message: `action ยาวได้ไม่เกิน ${ACTION_MAX_LENGTH} ตัวอักษร` };
  }
  return null;
}

// --- Client → server ---

/**
 * First message on a new socket. `afterSeq`: the highest entry `seq` this tab already has (0 = none);
 * the server replays every entry for this viewer after it, so a reconnect gets what it missed, once.
 */
export const RoomHello = z.object({
  type: z.literal('hello'),
  token: z.string().min(1),
  afterSeq: z.number().int().min(0).default(0),
});
export type RoomHello = z.infer<typeof RoomHello>;

/** A turn number within the period (GEN-063: 2 turns per period). */
export const Turn = z.number().int().min(1).max(2);

/**
 * This turn's action. A resubmit before the turn closes replaces the earlier one. `rest`: REST / SLEEP
 * this turn (in NOCTHERION it counts as the night's sleep against Drowsy). `train`: TRAIN at the guild
 * (GEN-069: Max HP +3, once a day, up to 45); not with `rest`.
 */
export const RoomAction = z.object({
  type: z.literal('action'),
  text: z.string(),
  visibility: z.string(),
  rest: z.boolean().default(false),
  train: z.boolean().default(false),
  /** GEN-069: a chip of the place (`you.placeActions`) used as this turn's action (pending, see docs/contract.md). */
  placeAction: PlaceActionId.optional(),
});
export type RoomAction = z.infer<typeof RoomAction>;

/**
 * A private message to one ally (GEN-067, sheet Fog of War). `to` is the ally's `ref` from `you.allies`.
 * Allowed only while the two are allies with relationship > +9; any place, any phase until the game ends.
 * Same text rules as an action. Only the sender, the target and the Human GM receive it.
 */
export const RoomWhisper = z.object({
  type: z.literal('whisper'),
  to: z.string(),
  text: z.string(),
});
export type RoomWhisper = z.infer<typeof RoomWhisper>;

/** Ask the AI GM to try the closed turn again after it got stuck (`RoomState.gmStatus`, GEN-057 C2). Any member may send it. */
export const RoomRetry = z.object({ type: z.literal('retry') });
export type RoomRetry = z.infer<typeof RoomRetry>;

/**
 * Walk to another place (GEN-066). `to` is a place id of the game data's Location tab (its name, e.g.
 * "โบสถ์"). Same zone: you are there now (Stamina -1) and still send this turn's action. Another zone: the
 * trip is this turn's action (Stamina -3) and you arrive when the turn closes.
 */
export const RoomMove = z.object({
  type: z.literal('move'),
  to: z.string(),
});
export type RoomMove = z.infer<typeof RoomMove>;

export const RoomClientMessage = z.discriminatedUnion('type', [RoomHello, RoomAction, RoomWhisper, RoomRetry, RoomMove, RoomOmen]);
export type RoomClientMessage = z.infer<typeof RoomClientMessage>;

// --- Server → client ---

/** `collecting` = actions open; `resolving` = closed, the GM is working it out; then the next phase opens. */
export const RoomPhaseStatus = z.enum(['collecting', 'resolving', 'finale', 'game_over']);
export type RoomPhaseStatus = z.infer<typeof RoomPhaseStatus>;

/**
 * A member as everyone in the room sees them: lobby name and online. Never the action's text or its
 * visibility (C3), never their character or place. `submitted` (sent this turn's action) is there only on
 * the viewer's own entry, and on every entry for the Human GM (Q-195): players get `RoomState.submittedCount`.
 */
export const RoomMember = z.strictObject({
  memberId: z.string(),
  name: z.string(),
  role: MemberRole,
  online: z.boolean(),
  submitted: z.boolean().optional(),
});
export type RoomMember = z.infer<typeof RoomMember>;

/**
 * Why this viewer cannot send an action now (the codes the server sends today); null = they can. GEN-070:
 * `exhausted` (Stamina 0: this turn is a forced REST), `unconscious` (HP 0: out cold this turn), `recovering`
 * (resting at the central clinic after HP 0), `astral_spirit` (dead for good; `you.astral` has the omen box).
 */
export const RoomLockCode = z.enum(['not_a_player', 'exhausted', 'unconscious', 'recovering', 'astral_spirit', 'resolving', 'game_ended', 'traveling']);
export type RoomLockCode = z.infer<typeof RoomLockCode>;

/**
 * `traveling` (Q-229, GEN-066): this turn is the trip to another zone; the action is the trip and you arrive
 * when the turn closes. The web's name for every lock it handles (`RoomYou.lock.code`).
 */
export const RoomViewLockCode = RoomLockCode;
export type RoomViewLockCode = RoomLockCode;

export const RoomYou = z.strictObject({
  memberId: z.string(),
  role: MemberRole,
  /** Where your character is; null for the Human GM and before the game places you. */
  place: PlaceView.nullable(),
  lock: z.strictObject({ code: RoomViewLockCode, message: z.string() }).nullable(),
  /**
   * The Secret quota that applies now is used: today's one Secret turn (Rules Spec §10.4), or in
   * NOCTHERION tonight's free Secret turn (GEN-063).
   */
  secretUsed: z.boolean(),
  /** Your character is Drowsy today (stayed awake through last NOCTHERION): d20 -2, +1 Stamina per action. */
  drowsy: z.boolean(),
  /** Your own action this turn (only you get this). */
  action: z
    .strictObject({ text: z.string(), visibility: ActionVisibility, rest: z.boolean(), /** GEN-069: only when it is a TRAIN. */ train: z.literal(true).optional() })
    .nullable(),
  /** Allies with relationship > +9 (GEN-067): their real name and the `ref` to Whisper to. Empty for the GM. */
  allies: z.array(z.strictObject({ ref: z.string(), name: z.string() })),
  /** GEN-069: the action chips of your place (pending, see docs/contract.md). */
  placeActions: z.array(PlaceActionView).optional(),
  /** GEN-070: you are an Astral Spirit; null = you are not. Optional for older servers. */
  astral: AstralView.nullable().optional(),
});
export type RoomYou = z.infer<typeof RoomYou>;

/**
 * The AI GM could not resolve the closed turn (GEN-057). The turn stays closed with every action kept.
 * `stuck`: its answer was still wrong after one repair, or it did not answer; `retry` tries again.
 * `budget_reached`: the game's monthly AI ceiling (Q-078); no AI call is made until it is raised.
 * `ai_not_ready`: the provider cannot be used (no API key). `message` is Thai, for this viewer
 * (the owner / Human GM get the reason; players get "AI GM ติดขัด").
 * `awaiting_gm` (GEN-058, Q-030): the turn is resolved and waits for the Human GM to approve it.
 */
export const RoomGmStatusCode = z.enum(['stuck', 'budget_reached', 'ai_not_ready', 'awaiting_gm']);
export type RoomGmStatusCode = z.infer<typeof RoomGmStatusCode>;
export const RoomGmStatus = z.strictObject({ code: RoomGmStatusCode, message: z.string(), canRetry: z.boolean() });
export type RoomGmStatus = z.infer<typeof RoomGmStatus>;

/** The room as one viewer sees it; sent after `hello` and whenever presence, submissions or the turn change. */
export const RoomState = z.strictObject({
  type: z.literal('room'),
  gameId: z.string(),
  mode: z.enum(['online', 'single']),
  day: z.number().int(),
  /** The period. */
  phase: Phase,
  turn: Turn,
  status: RoomPhaseStatus,
  /** The current period's weather (GEN-068), the same for everyone; null until the AI GM has picked it. */
  weather: PeriodWeather.nullable(),
  members: z.array(RoomMember),
  /** Q-195: how many have sent this turn's action (not who). */
  submittedCount: z.number().int().min(0),
  you: RoomYou,
  /** null = the AI GM is fine (or working). */
  gmStatus: RoomGmStatus.nullable(),
});
export type RoomState = z.infer<typeof RoomState>;

/**
 * `feed`: something that happened at a place, sent only to who was there (witnesses, GEN-050).
 * `narration`: private GM text for one player. `place` null = the whole town (feed) or none (narration).
 * `whisper`: one ally to another (GEN-067); `place` null, `whisper` says who to whom.
 * `omen`: an Astral Spirit's one-sentence omen to you (GEN-070, Q-193); `place` null, the sender is not named.
 */
export const RoomEntryKind = z.enum(['feed', 'narration', 'whisper', 'omen', 'hit', 'changes', 'npc']);
export type RoomEntryKind = z.infer<typeof RoomEntryKind>;

/**
 * GEN-110, `npc` entries: one line an NPC says while the AI GM narrates a turn (`text`, at most 120 characters,
 * already with names filled in for this viewer). `kind`: `dialogue` = the NPC talks about / to what a player did (1-3 per
 * NPC), `reaction` = a bystander at the place reacts (1 line, up to 3 NPCs). Public lines carry the `place` and
 * go to everyone who was there (a Secret action never causes one); `private: true` = said to this player alone
 * (`place` null). `ref` is the same opaque handle as `NpcView.ref` / `CompanionView.ref`. `name` is the alias until
 * the viewer has learned the real name (Q-219); `grade` only once the viewer knows the name (never for a hidden one).
 */
export const NpcLineView = z.strictObject({
  ref: z.string(),
  name: z.string(),
  grade: z.enum(['F', 'B', 'A', 'S', 'SS']).optional(),
  kind: z.enum(['dialogue', 'reaction']),
  private: z.literal(true).optional(),
});
export type NpcLineView = z.infer<typeof NpcLineView>;
/** `hit` (Q-229, GEN-060): another player's act landed on you (the pinned card; `RoomEntry.hit` has the details). */
export const RoomViewEntryKind = RoomEntryKind;
export type RoomViewEntryKind = RoomEntryKind;

export const RoomEntry = z.strictObject({
  /** Increases within a game; a viewer's entries are a subsequence, so "the last one I have" is enough. */
  seq: z.number().int().min(1),
  kind: RoomViewEntryKind,
  day: z.number().int(),
  phase: Phase,
  turn: Turn,
  place: PlaceView.nullable(),
  text: z.string(),
  /**
   * Whisper entries only: the characters' real names (both could see each other's when it was sent) and
   * whether this viewer sent it.
   */
  whisper: z.strictObject({ from: z.string(), to: z.string(), mine: z.boolean() }).optional(),
  /**
   * Q-177: the server's template text, not the AI GM's (the AI did not answer, ran out of budget, or its
   * text was still wrong after a repair). Present only when true; show `FALLBACK_NARRATION_LABEL` with it.
   */
  fallback: z.literal(true).optional(),
  /** F5: the roll of the reader's own action, on that narration only (Q-229). */
  roll: RollView.optional(),
  /** `hit` entries: who (if known) and what changed for you (Q-229). */
  hit: HitView.optional(),
  /** `changes` entries (GEN-114): what changed in your own HP / Stamina / coins / conduct word / items / statuses, and why. `text` = the character's name. */
  changes: z.array(TurnChange).optional(),
  /** `npc` entries (GEN-110): who says `text` (avatar + name + grade for the chat UI) and what kind of line it is. */
  npc: NpcLineView.optional(),
});
export type RoomEntry = z.infer<typeof RoomEntry>;

/** The small marker players see on a `fallback` entry (Q-177). */
export const FALLBACK_NARRATION_LABEL = 'บรรยายสำรองจากระบบ';

export const RoomEntryMessage = z.strictObject({ type: z.literal('entry'), entry: RoomEntry });

/** After `hello`: every missed entry came before this message. */
export const RoomReady = z.strictObject({ type: z.literal('ready'), lastSeq: z.number().int().min(0) });

export const RoomActionCode = z.enum([
  'empty',
  'too_long',
  'invalid_action',
  'not_a_player',
  'exhausted',
  'unconscious',
  /** GEN-070: resting at the central clinic after HP 0. */
  'recovering',
  /** GEN-070: dead for good (an Astral Spirit). */
  'astral_spirit',
  'resolving',
  'secret_quota_used',
  'game_ended',
  /** GEN-066: this turn is the trip to another zone. */
  'traveling',
  /** GEN-069: REST at the inn costs 5 coins. */
  'not_enough_coins',
  /** GEN-069: TRAIN only at the guild. */
  'train_not_here',
  /** GEN-069 (Q-088): TRAIN once a day. */
  'train_used',
  /** GEN-069 (Q-088): Max HP is at the TRAIN ceiling (45). */
  'train_cap',
]);
export type RoomActionCode = z.infer<typeof RoomActionCode>;

/** Why a move was refused (GEN-066). */
export const RoomMoveCode = z.enum([
  'unknown_location',
  'already_here',
  'not_enough_stamina',
  'restricted',
  'infiltrate_failed',
  'black_market_closed',
  'rift_closed',
  'rift_gateway',
  'traveling',
  'not_placed',
  'cannot_act',
]);
export type RoomMoveCode = z.infer<typeof RoomMoveCode>;
/** `arrives`: `now` (same zone, or into the Astral Rift for one turn) or `next_turn` (another zone). */
export const RoomMoveAccepted = z.strictObject({
  type: z.literal('move_accepted'),
  kind: z.enum(['same_zone', 'cross_zone', 'rift']),
  place: PlaceView,
  arrives: z.enum(['now', 'next_turn']),
});
export const RoomMoveRejected = z.strictObject({ type: z.literal('move_rejected'), code: RoomMoveCode, message: z.string() });

export const RoomActionAccepted = z.strictObject({ type: z.literal('action_accepted') });
export const RoomActionRejected = z.strictObject({ type: z.literal('action_rejected'), code: RoomActionCode, message: z.string() });

/**
 * `not_allowed`: no ally with that ref at relationship > +9 (an unknown ref gets the same answer, so a
 * Whisper cannot probe who exists). `unconscious`: the sender is at HP 0, the same lock as an action (Q-136).
 * `astral_spirit`: the dead speak only through the omen (GEN-070).
 */
export const RoomWhisperCode = z.enum(['empty', 'too_long', 'not_a_player', 'not_allowed', 'game_ended', 'unconscious', 'astral_spirit']);
export type RoomWhisperCode = z.infer<typeof RoomWhisperCode>;
export const RoomWhisperAccepted = z.strictObject({ type: z.literal('whisper_accepted') });
export const RoomWhisperRejected = z.strictObject({ type: z.literal('whisper_rejected'), code: RoomWhisperCode, message: z.string() });

/**
 * The socket cannot be used; the server closes it after this. `no_character`: the web takes the player to
 * character creation (C2). `unauthorized`: back to the join form.
 */
export const RoomErrorCode = z.enum(['unauthorized', 'no_character', 'game_not_started', 'bad_message']);
export type RoomErrorCode = z.infer<typeof RoomErrorCode>;
export const RoomError = z.strictObject({ type: z.literal('error'), code: RoomErrorCode, message: z.string() });

export const RoomServerMessage = z.discriminatedUnion('type', [
  RoomState,
  RoomEntryMessage,
  RoomReady,
  RoomActionAccepted,
  RoomActionRejected,
  RoomWhisperAccepted,
  RoomWhisperRejected,
  RoomMoveAccepted,
  RoomMoveRejected,
  RoomError,
  // GEN-070: the answer to a `RoomOmen`.
  RoomOmenAccepted,
  RoomOmenRejected,
]);
export type RoomServerMessage = z.infer<typeof RoomServerMessage>;
