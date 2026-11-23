import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { deleteLearningEntry, deleteLearningGame } from '../learning/examples.ts';
import type { LearningExtractor } from '../learning/extract.ts';
import { learningLibrary } from '../learning/library.ts';

/**
 * GEN-080: the server owner starts (or retries) the lore + feedback extract of an ended game. GEN-084: the Learning
 * library, delete one entry or every entry of a source game (tombstones). Admin token only.
 */
export function registerLearningRoutes(app: FastifyInstance, db: Db, learning: LearningExtractor, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean) {
  const send = (reply: FastifyReply) => reply.header('cache-control', 'no-store').send(learningLibrary(db));

  app.get('/api/admin/learning', async (request, reply) => (refuse(request, reply) ? reply : send(reply)));

  app.delete<{ Params: { id: string } }>('/api/admin/learning/:id', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || !deleteLearningEntry(db, id)) return sendError(reply, 404, { code: 'response_not_found', message: 'ไม่พบความรู้นี้' });
    return send(reply);
  });

  app.delete<{ Params: { gameId: string } }>('/api/admin/learning/games/:gameId', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    if (!deleteLearningGame(db, request.params.gameId)) return sendError(reply, 404, { code: 'game_not_found', message: 'ไม่มีความรู้ของเกมนี้' });
    return send(reply);
  });

  app.post<{ Params: { gameId: string } }>('/api/admin/learning/games/:gameId/extract', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const outcome = await learning.extract(request.params.gameId);
    if (outcome.kind === 'not_found') return sendError(reply, 404, { code: 'game_not_found', message: 'ไม่พบเกมนี้' });
    if (outcome.kind === 'not_ended') return sendError(reply, 409, { code: 'not_allowed', message: 'สกัดความรู้ได้เมื่อเกมจบแล้วเท่านั้น' });
    return reply.header('cache-control', 'no-store').send(outcome.body);
  });
}
