import type { GameLearningResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { gameEnded } from '../rating/store.ts';
import { extractStatus, type LearningExtractor } from './extract.ts';

/**
 * Q-363: a member sees whether the lore + feedback extract of their ended game failed, and retries it from the end
 * page (ISK-017: every member, there is no owner). No session 403; before the end 409.
 */
export function registerGameLearningRoutes(app: FastifyInstance, db: Db, now: Clock, learning: LearningExtractor) {
  /** The caller's game id when it has ended; otherwise the error is sent. */
  function owned(request: FastifyRequest, reply: FastifyReply): string | undefined {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) {
      void sendError(reply, 403, { code: 'forbidden', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
      return undefined;
    }
    if (!gameEnded(db, me.gameId)) {
      void sendError(reply, 409, { code: 'not_allowed', message: 'สกัดความรู้ได้เมื่อเกมจบแล้วเท่านั้น' });
      return undefined;
    }
    return me.gameId;
  }
  const send = (reply: FastifyReply, gameId: string) => reply.header('cache-control', 'no-store').send({ status: extractStatus(db, gameId) } satisfies GameLearningResponse);

  app.get('/api/game/learning', async (request, reply) => {
    const gameId = owned(request, reply);
    return gameId ? send(reply, gameId) : reply;
  });

  app.post('/api/game/learning/extract', async (request, reply) => {
    const gameId = owned(request, reply);
    if (!gameId) return reply;
    await learning.extract(gameId);
    return send(reply, gameId);
  });
}
