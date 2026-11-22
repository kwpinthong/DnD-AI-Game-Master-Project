import type { FastifyInstance } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { surroundingsFor } from './views.ts';

/**
 * GET /api/game/surroundings (GEN-050): the caller's own character, their place and who / which NPCs
 * are there, as this viewer may see them. The Human GM gets every character with every field.
 */
export function registerVisibilityRoutes(app: FastifyInstance, db: Db, now: Clock) {
  app.get('/api/game/surroundings', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
    return reply.send(surroundingsFor(db, me));
  });
}
