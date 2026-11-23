import type { GameLearningResponse } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { game } from '../db/schema.ts';
import { gameEnded } from '../rating/store.ts';
import { extractStatus, type LearningExtractor } from './extract.ts';

/**
 * Q-363: the game owner sees whether the lore + feedback extract of their ended game failed, and retries it from the
 * end page. Anyone else 403; before the end 409.
 */
export function registerGameLearningRoutes(app: FastifyInstance, db: Db, now: Clock, learning: LearningExtractor) {
  /** The game id when the caller owns that ended game; otherwise the error is sent. */
  function owned(request: FastifyRequest, reply: FastifyReply): string | undefined {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    const owner = me && db.select({ owner: game.ownerMemberId }).from(game).where(eq(game.id, me.gameId)).get()?.owner;
    if (!me || owner !== me.id) {
      void sendError(reply, 403, { code: 'forbidden', message: 'เฉพาะเจ้าของเกมเท่านั้น' });
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
