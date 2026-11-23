import { z } from 'zod';

/**
 * GEN-178 (ADR "Learning Across Games" R7): the style review round of the server owner. Every 5 ended games (or
 * "run now") the server counts the 👎 (with their reason chips) and style flags new since the last round; with at
 * least 20 it asks the AI once for rules to add to the Voice data set. A proposal changes nothing until the owner
 * approves it; each approval is a new Voice version, and an older one can be restored.
 */

const count = z.number().int().min(0);

/** Signals of a round (or waiting for the next): 👎 split by reason chip, flags by rule id, both by NPC. */
export const StyleSignalCounts = z.strictObject({
  downvotes: count,
  flags: count,
  /** Reason chip → 👎 that named it (a 👎 may name several, or none). */
  reasons: z.record(z.string(), count),
  /** Voice rule id (or `pronoun_mismatch` / `never_word`) → flags. */
  rules: z.record(z.string(), count),
  /** NPC id → 👎 + flags; '' = narration. */
  npcs: z.record(z.string(), count),
});
export type StyleSignalCounts = z.infer<typeof StyleSignalCounts>;

export const StyleReviewRound = z.strictObject({
  id: z.number().int().min(1),
  /** `games` = the 5th ended game, `manual` = "run now". */
  trigger: z.enum(['games', 'manual']),
  /** `skipped` = under the minimum (no AI call, the signals wait); `failed` = the AI gave no usable answer (they wait too). */
  status: z.enum(['done', 'skipped', 'failed']),
  signals: count,
  counts: StyleSignalCounts,
  /** The repeated problems the AI found, with the message refs it based them on. */
  patterns: z.array(z.strictObject({ summary: z.string(), evidence: z.array(z.number().int()) })),
  /** Why the round failed (kind only, no prompt text). */
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type StyleReviewRound = z.infer<typeof StyleReviewRound>;

export const StyleProposalKind = z.enum(['forbid', 'pair', 'npc_patch']);
export type StyleProposalKind = z.infer<typeof StyleProposalKind>;

export const StyleProposal = z.strictObject({
  id: z.number().int().min(1),
  roundId: z.number().int().min(1),
  /** `forbid` = a Voice ForbiddenRule, `pair` = a bad → good pair, `npc_patch` = fields of one NPC's speech profile. */
  kind: StyleProposalKind,
  npcId: z.string().nullable(),
  /** Already checked against the Voice schema of its kind. */
  content: z.record(z.string(), z.unknown()),
  reason: z.string(),
  evidence: z.array(z.number().int()),
  status: z.enum(['proposed', 'approved', 'rejected']),
  /** The Voice version an approval made. */
  voiceVersion: z.number().int().nullable(),
  decidedAt: z.string().nullable(),
});
export type StyleProposal = z.infer<typeof StyleProposal>;

/** An NPC line most of its game's players liked (GEN-126 voteVerdict good), not yet in the NPC example library. */
export const StyleGoodCandidate = z.strictObject({
  gameId: z.string(),
  seq: z.number().int().min(1),
  npc: z.strictObject({ id: z.string(), name: z.string() }),
  text: z.string(),
  up: z.number().int().min(1),
});
export type StyleGoodCandidate = z.infer<typeof StyleGoodCandidate>;

/** 200 from every /api/admin/style-review route: the whole tab. */
export const StyleReviewResponse = z.strictObject({
  /** A round is waiting for the AI now. */
  running: z.boolean(),
  minSignals: z.number().int().min(1),
  gamesPerRound: z.number().int().min(1),
  gamesSinceRound: count,
  /** Signals not used by a round yet. */
  waiting: StyleSignalCounts,
  /** Newest first. */
  rounds: z.array(StyleReviewRound),
  /** Newest round first, in the AI's order within a round. */
  proposals: z.array(StyleProposal),
  voice: z.strictObject({
    version: z.number().int().min(1),
    /**
     * Every version in the game data audit, newest first; `current` = the one in use. `at` = when it was last
     * saved, null for one only seen as the value before an edit (the seed).
     */
    versions: z.array(z.strictObject({ version: z.number().int().min(1), at: z.string().nullable(), current: z.boolean() })),
  }),
  goodCandidates: z.array(StyleGoodCandidate),
});
export type StyleReviewResponse = z.infer<typeof StyleReviewResponse>;

/** Body of POST /api/admin/style-review/proposals/:id/approve; `content` = the owner's edit of the proposal. */
export const StyleProposalApproveRequest = z.strictObject({ content: z.record(z.string(), z.unknown()).optional() });
export type StyleProposalApproveRequest = z.infer<typeof StyleProposalApproveRequest>;
