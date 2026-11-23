import { AdminCloseGameRequest, CLOSE_REASON_MAX, type AdminGamesResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { closeGame, closureOf, gameRow, listGames, type Closure } from './games.ts';
import type { AdminSessions } from './session.ts';

export type GameClosedHook = (gameId: string, closed: Closure) => void;

/**
 * ISK-001: GET /api/admin/games (every game) and POST /api/admin/games/:id/close. Admin token only; without one the
 * answer is 401 (the case), and nothing changes. The close is written to `game_close` (the audit) before the hook runs.
 */
export function registerAdminGameRoutes(app: FastifyInstance, db: Db, now: Clock, sessions: AdminSessions, onClosed: GameClosedHook) {
  const refuse = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (sessions.valid(bearerToken(request.headers.authorization))) return false;
    void sendError(reply, 401, { code: 'unauthorized', message: 'หน้านี้สำหรับเจ้าของ server เท่านั้น เข้าด้วย admin code ก่อน' });
    return true;
  };

  app.get('/api/admin/games', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: AdminGamesResponse = { games: listGames(db) };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.post<{ Params: { id: string } }>('/api/admin/games/:id/close', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const parsed = AdminCloseGameRequest.safeParse(request.body ?? {});
    const outcome = closeGame(db, request.params.id, parsed.success ? parsed.data : { confirmName: '' }, now());
    switch (outcome.kind) {
      case 'not_found':
        return sendError(reply, 404, { code: 'game_not_found', message: 'ไม่พบเกมนี้' });
      case 'confirm_required':
        return sendError(reply, 400, { code: 'confirm_required', message: 'พิมพ์ชื่อเกมให้ตรงเพื่อยืนยันการปิด' });
      case 'reason_too_long':
        return sendError(reply, 400, { code: 'reason_too_long', message: `เหตุผลยาวได้ไม่เกิน ${CLOSE_REASON_MAX} ตัวอักษร` });
      case 'already_ended':
        return sendError(reply, 409, { code: 'already_ended', message: 'เกมนี้จบหรือถูกปิดไปแล้ว' });
      case 'closed':
        onClosed(request.params.id, { reason: outcome.reason, hasSummary: outcome.hasSummary });
        return reply.header('cache-control', 'no-store').send(gameRow(db, request.params.id));
    }
  });
}

/** What a member may still change in a closed game: the end page's rating and votes, the owner's extract retry and delete. */
const OPEN_AFTER_CLOSE: ReadonlySet<string> = new Set([
  'PUT /api/game/rating',
  'PUT /api/game/rating/votes/:sourceRef',
  'PUT /api/game/entries/:seq/vote',
  'POST /api/game/learning/extract',
  'DELETE /api/game',
]);

/** ISK-001: any other changing request of a member of a closed game is 409 `game_closed`, before its route runs. */
export function registerClosedGameGuard(app: FastifyInstance, db: Db, now: Clock) {
  app.addHook('preHandler', async (request, reply) => {
    const route = request.routeOptions.url ?? '';
    if (request.method === 'GET' || (!route.startsWith('/api/game/') && route !== '/api/game')) return;
    if (OPEN_AFTER_CLOSE.has(`${request.method} ${route}`)) return;
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (me && closureOf(db, me.gameId) !== null) return sendError(reply, 409, { code: 'game_closed', message: 'เกมนี้ถูกผู้ดูแลปิดแล้ว ทำรายการนี้ไม่ได้' });
  });
}
