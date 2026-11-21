import { z } from 'zod';

/** Body of GET /health. `db` says whether the server can query its SQLite database. */
export const HealthResponse = z.object({
  ok: z.boolean(),
  db: z.enum(['connected', 'error']),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** Socket.IO event names shared by server and web. */
export const ServerEventName = {
  presence: 'presence',
} as const;

/** Payload of the `presence` event: how many clients are connected right now. */
export const PresenceEvent = z.object({
  online: z.number().int().nonnegative(),
});
export type PresenceEvent = z.infer<typeof PresenceEvent>;
