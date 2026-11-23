import type { TravelResponse } from '@isekai/protocol';
import type { GameAssets } from '../assets/load.ts';
import type { FastifyInstance } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, noSession, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { travelSheetOf } from '../travel/service.ts';
import { surroundingsFor } from './views.ts';

/**
 * GET /api/game/surroundings (GEN-050): the caller's own character, their place and who / which NPCs
 * are there, as this viewer may see them. The Human GM gets every character with every field.
 * GET /api/game/travel (Q-229): where the caller can go from their place, by zone, with the Stamina it costs.
 */
export function registerVisibilityRoutes(app: FastifyInstance, db: Db, now: Clock, assets: GameAssets) {
  app.get('/api/game/surroundings', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 401, noSession(request.headers.authorization));
    return reply.send(surroundingsFor(db, me, assets));
  });

  app.get('/api/game/travel', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 401, noSession(request.headers.authorization));
    if (me.role === 'gm') return sendError(reply, 403, { code: 'forbidden', message: 'GM ไม่มีตัวละคร จึงไม่มีแผ่นเดินทาง' });
    const sheet: TravelResponse = travelSheetOf(db, assets, me.gameId, me.id, now()) ?? { from: null, zones: [] };
    return reply.send(sheet);
  });
}
