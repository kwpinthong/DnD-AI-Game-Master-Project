import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../auth/join.ts';
import type { Db } from '../db/client.ts';

/** ISK-010: POST /api/feedback (stub). */
export function registerFeedbackRoutes(app: FastifyInstance, db: Db, now: Clock) {
  void app;
  void db;
  void now;
}

/** ISK-010: the owner's list + status change (stub). */
export function registerFeedbackAdminRoutes(app: FastifyInstance, db: Db, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean, now: Clock) {
  void app;
  void db;
  void refuse;
  void now;
}
