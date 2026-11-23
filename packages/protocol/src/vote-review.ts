import { z } from 'zod';
import { Phase } from './scenario.ts';
import { VoteReason } from './room.ts';

/**
 * GEN-168: the server owner's review of the AI messages players gave a 👎 (admin code only, like GEN-061). A
 * "แก้เป็น" pair keeps the message as it was in the game and the version it should have been, for fine-tuning
 * later; the game's own text never changes. Sending a pair to an NPC's example library is GEN-151's: here a pair
 * is only marked as a library candidate.
 */

/** `npc-dialogue` / `npc-reaction` = an `npc` entry of that kind (GEN-110); otherwise the entry kind. */
export const ReviewScene = z.enum(['feed', 'narration', 'npc-dialogue', 'npc-reaction']);
export type ReviewScene = z.infer<typeof ReviewScene>;

export const AdminCorrection = z.strictObject({
  id: z.number().int().min(1),
  gameId: z.string(),
  seq: z.number().int().min(1),
  original: z.string(),
  edited: z.string(),
  /** The NPC's real name (the scenario's), null = not an NPC line. */
  npc: z.string().nullable(),
  scene: ReviewScene,
  /** The 👎 reasons the message had when the pair was saved. */
  reasons: z.array(VoteReason),
  libraryCandidate: z.boolean(),
  createdAt: z.string(),
});
export type AdminCorrection = z.infer<typeof AdminCorrection>;

export const AdminDownvoteEntry = z.strictObject({
  gameId: z.string(),
  gameName: z.string(),
  seq: z.number().int().min(1),
  scene: ReviewScene,
  npc: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  at: z.strictObject({ day: z.number().int(), phase: Phase, turn: z.number().int().min(1).max(2) }),
  /** The text as stored (real names, as the AI wrote it). */
  text: z.string(),
  down: z.number().int().min(1),
  /** Reason → how many 👎 named it (reasons nobody named are left out). */
  reasons: z.partialRecord(VoteReason, z.number().int().min(1)),
  /** Pairs saved for this message, oldest first (append-only: the audit of who edited what when). */
  corrections: z.array(AdminCorrection),
});
export type AdminDownvoteEntry = z.infer<typeof AdminDownvoteEntry>;

/** 200 from GET /api/admin/downvotes: every AI message with a 👎, newest first. */
export const AdminDownvotesResponse = z.strictObject({ entries: z.array(AdminDownvoteEntry) });
export type AdminDownvotesResponse = z.infer<typeof AdminDownvotesResponse>;

/** Body of POST /api/admin/corrections. */
export const AdminCorrectionRequest = z.object({
  gameId: z.string().min(1),
  seq: z.number().int().min(1),
  edited: z.string().trim().min(1, 'พิมพ์ฉบับที่ควรเป็น').max(2000, 'ยาวได้ไม่เกิน 2000 ตัวอักษร'),
  /** Mark the pair for the NPC example library (GEN-151 reads it later). */
  toLibrary: z.boolean().default(false),
});
export type AdminCorrectionRequest = z.input<typeof AdminCorrectionRequest>;

/** 200 from POST /api/admin/corrections. */
export const AdminCorrectionResponse = z.strictObject({ correction: AdminCorrection });
export type AdminCorrectionResponse = z.infer<typeof AdminCorrectionResponse>;

/**
 * 200 from GET /api/admin/corrections-export: one JSON object per line per pair
 * (`{ npc, scene, reasons, original, edited, libraryCandidate }`), players' names swapped for `{{PLAYER_n}}`.
 */
export const AdminCorrectionsExportResponse = z.strictObject({ exportedAt: z.string(), count: z.number().int().min(0), jsonl: z.string() });
export type AdminCorrectionsExportResponse = z.infer<typeof AdminCorrectionsExportResponse>;
