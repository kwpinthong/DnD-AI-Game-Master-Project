import { z } from 'zod';

/** Body of GET /health. `db` says whether the server can query its SQLite database. */
export const HealthResponse = z.object({
  ok: z.boolean(),
  db: z.enum(['connected', 'error']),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
