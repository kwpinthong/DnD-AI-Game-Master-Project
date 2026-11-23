import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.ts';
import type { Clock } from '../auth/join.ts';
import type { AdminSessions } from './session.ts';

export type GameClosedHook = (gameId: string, closed: { reason: string | null; hasSummary: boolean }) => void;

/** ISK-001: GET /api/admin/games and POST /api/admin/games/:id/close (stub). */
export function registerAdminGameRoutes(app: FastifyInstance, db: Db, now: Clock, sessions: AdminSessions, onClosed: GameClosedHook) {
  void db;
  void now;
  void sessions;
  void onClosed;
  app.get('/api/admin/games', async (_request, reply) => reply.send({ games: [] }));
  app.post('/api/admin/games/:id/close', async (_request, reply) => reply.code(200).send({}));
}

/** ISK-001: a changing request of a member of a closed game is 409 `game_closed` (stub). */
export function registerClosedGameGuard(app: FastifyInstance, db: Db, now: Clock) {
  void app;
  void db;
  void now;
}
