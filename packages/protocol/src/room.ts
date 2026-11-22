import { z } from 'zod';
import { MemberRole } from './game.ts';
import { Phase } from './scenario.ts';
import { PlaceView } from './visibility.ts';

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
 * this turn (in NOCTHERION it counts as the night's sleep against Drowsy).
 */
export const RoomAction = z.object({
  type: z.literal('action'),
  text: z.string(),
  visibility: z.string(),
  rest: z.boolean().default(false),
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

export const RoomClientMessage = z.discriminatedUnion('type', [RoomHello, RoomAction, RoomWhisper]);
export type RoomClientMessage = z.infer<typeof RoomClientMessage>;

// --- Server → client ---

/** `collecting` = actions open; `resolving` = closed, the GM is working it out; then the next phase opens. */
export const RoomPhaseStatus = z.enum(['collecting', 'resolving', 'finale', 'game_over']);
export type RoomPhaseStatus = z.infer<typeof RoomPhaseStatus>;

/**
 * A member as everyone in the room sees them: lobby name, online, and whether they sent this phase's action.
 * Never the action's text or its visibility (C3), never their character or place.
 */
export const RoomMember = z.strictObject({
  memberId: z.string(),
  name: z.string(),
  role: MemberRole,
  online: z.boolean(),
  submitted: z.boolean(),
});
export type RoomMember = z.infer<typeof RoomMember>;

/** Why this viewer cannot send an action now; null = they can. */
export const RoomLockCode = z.enum(['not_a_player', 'exhausted', 'unconscious', 'resolving', 'game_ended']);
export type RoomLockCode = z.infer<typeof RoomLockCode>;

export const RoomYou = z.strictObject({
  memberId: z.string(),
  role: MemberRole,
  /** Where your character is; null for the Human GM and before the game places you. */
  place: PlaceView.nullable(),
  lock: z.strictObject({ code: RoomLockCode, message: z.string() }).nullable(),
  /**
   * The Secret quota that applies now is used: today's one Secret turn (Rules Spec §10.4), or in
   * NOCTHERION tonight's free Secret turn (GEN-063).
   */
  secretUsed: z.boolean(),
  /** Your character is Drowsy today (stayed awake through last NOCTHERION): d20 -2, +1 Stamina per action. */
  drowsy: z.boolean(),
  /** Your own action this turn (only you get this). */
  action: z.strictObject({ text: z.string(), visibility: ActionVisibility, rest: z.boolean() }).nullable(),
  /** Allies with relationship > +9 (GEN-067): their real name and the `ref` to Whisper to. Empty for the GM. */
  allies: z.array(z.strictObject({ ref: z.string(), name: z.string() })),
});
export type RoomYou = z.infer<typeof RoomYou>;

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
  members: z.array(RoomMember),
  you: RoomYou,
});
export type RoomState = z.infer<typeof RoomState>;

/**
 * `feed`: something that happened at a place, sent only to who was there (witnesses, GEN-050).
 * `narration`: private GM text for one player. `place` null = the whole town (feed) or none (narration).
 * `whisper`: one ally to another (GEN-067); `place` null, `whisper` says who to whom.
 */
export const RoomEntryKind = z.enum(['feed', 'narration', 'whisper']);
export type RoomEntryKind = z.infer<typeof RoomEntryKind>;

export const RoomEntry = z.strictObject({
  /** Increases within a game; a viewer's entries are a subsequence, so "the last one I have" is enough. */
  seq: z.number().int().min(1),
  kind: RoomEntryKind,
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
});
export type RoomEntry = z.infer<typeof RoomEntry>;

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
  'resolving',
  'secret_quota_used',
  'game_ended',
]);
export type RoomActionCode = z.infer<typeof RoomActionCode>;

export const RoomActionAccepted = z.strictObject({ type: z.literal('action_accepted') });
export const RoomActionRejected = z.strictObject({ type: z.literal('action_rejected'), code: RoomActionCode, message: z.string() });

/**
 * `not_allowed`: no ally with that ref at relationship > +9 (an unknown ref gets the same answer, so a
 * Whisper cannot probe who exists).
 */
export const RoomWhisperCode = z.enum(['empty', 'too_long', 'not_a_player', 'not_allowed', 'game_ended']);
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
  RoomError,
]);
export type RoomServerMessage = z.infer<typeof RoomServerMessage>;
