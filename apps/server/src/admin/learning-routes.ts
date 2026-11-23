import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../auth/routes.ts';
import type { LearningExtractor } from '../learning/extract.ts';

/** GEN-080: the server owner starts (or retries) the lore + feedback extract of an ended game; admin token only. */
export function registerLearningRoutes(app: FastifyInstance, learning: LearningExtractor, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean) {
  app.post<{ Params: { gameId: string } }>('/api/admin/learning/games/:gameId/extract', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const outcome = await learning.extract(request.params.gameId);
    if (outcome.kind === 'not_found') return sendError(reply, 404, { code: 'game_not_found', message: 'ไม่พบเกมนี้' });
    if (outcome.kind === 'not_ended') return sendError(reply, 409, { code: 'not_allowed', message: 'สกัดความรู้ได้เมื่อเกมจบแล้วเท่านั้น' });
    return reply.header('cache-control', 'no-store').send(outcome.body);
  });
}
