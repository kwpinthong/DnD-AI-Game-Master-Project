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

export * from './room.ts';
