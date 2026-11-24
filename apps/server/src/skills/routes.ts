import type { InventoryResponse } from '@isekai/protocol';
import type { FastifyInstance } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, noSession, sendError } from '../auth/routes.ts';
import type { GameAssets } from '../assets/load.ts';
import type { Db } from '../db/client.ts';
import { inventoryOf } from './store.ts';

/** GET /api/game/inventory: the caller's own skills, held items and library discoveries (GEN-055). */
export function registerInventoryRoutes(app: FastifyInstance, db: Db, now: Clock, assets: GameAssets) {
  app.get('/api/game/inventory', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 401, noSession(request.headers.authorization));
    const outcome = inventoryOf(db, assets, me);
    if (outcome.kind === 'gm_has_no_character') return sendError(reply, 403, { code: 'forbidden', message: 'GM ไม่มีตัวละคร จึงไม่มีสกิลหรือไอเท็ม' });
    const body: InventoryResponse = { inventory: outcome.inventory };
    return reply.code(200).send(body);
  });
}
