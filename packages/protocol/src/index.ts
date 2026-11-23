import { z } from 'zod';

/** Body of GET /health. `db` says whether the server can query its SQLite database. */
export const HealthResponse = z.object({
  ok: z.boolean(),
  db: z.enum(['connected', 'error']),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export * from './join.ts';
export * from './timeline.ts';

export * from './scenario.ts';
export * from './scenario-default.ts';
export * from './game.ts';

export * from './character.ts';
export * from './loot.ts';

export * from './visibility.ts';

export * from './weather.ts';
export * from './room.ts';
export * from './gm-console.ts';
export * from './companion.ts';
export * from './admin.ts';
export * from './inventory.ts';

// GEN-037: the read-only game summary / log, own file so parallel protocol work merges cleanly.
export * from './history.ts';

// GEN-099: view-models of Screens and Flows v2 the server does not send yet (see docs/contract.md).
// The registry + fixtures are `@isekai/protocol/contract`.
export * from './view-models.ts';

// GEN-065: the start scenario (origin) and its private narration, own file for the same reason.
export * from './origin.ts';

// GEN-168: the server owner's review of 👎 messages + "แก้เป็น" pairs, own file for the same reason.
export * from './vote-review.ts';

// GEN-169: the style checker's settings and flag counts (server owner), own file for the same reason.
export * from './style-check.ts';
