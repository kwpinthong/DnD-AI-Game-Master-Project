import { AdminCloseGameRequest, CLOSE_REASON_MAX, type AdminGamesResponse, type AdminInviteCodeResponse, type AdminMembersResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GameAssets } from '../assets/load.ts';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { adminMemory } from '../gm/player-memory.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { CryptoRng } from '../rng.ts';
import { closeGame, closureOf, gameMembers, gameRow, kickFromGame, listGames, renewInviteCodeOf, type Closure } from './games.ts';
import type { AdminSessions } from './session.ts';

export type GameClosedHook = (gameId: string, closed: Closure) => void;
/** ISK-018: after a kick was stored (the room ends their sockets; ISK-017 re-checks the lobby start here). */
export type MemberKickedHook = (gameId: string, memberId: string, turnClosed: boolean) => void;

const rng = new CryptoRng();

/**
 * ISK-001: GET /api/admin/games (every game) and POST /api/admin/games/:id/close. Admin token only; without one the
 * answer is 401 (the case), and nothing changes. The close is written to `game_close` (the audit) before the hook runs.
 */
export function registerAdminGameRoutes(app: FastifyInstance, db: Db, now: Clock, sessions: AdminSessions, onClosed: GameClosedHook, onKicked: MemberKickedHook, assets: GameAssets) {
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

  // --- ISK-018: a game's members, the kick and a new invite code (each change = one admin_game_audit row) ---
  const noGame = (reply: FastifyReply) => sendError(reply, 404, { code: 'game_not_found', message: 'ไม่พบเกมนี้' });
  const ended = (reply: FastifyReply) => sendError(reply, 409, { code: 'already_ended', message: 'เกมนี้จบหรือถูกปิดไปแล้ว' });
  const sendMembers = (reply: FastifyReply, gameId: string) => {
    const members = gameMembers(db, gameId);
    if (!members) return noGame(reply);
    const body: AdminMembersResponse = { members };
    return reply.header('cache-control', 'no-store').send(body);
  };

  app.get<{ Params: { id: string } }>('/api/admin/games/:id/members', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    return sendMembers(reply, request.params.id);
  });

  app.post<{ Params: { id: string; memberId: string } }>('/api/admin/games/:id/members/:memberId/kick', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const { id, memberId } = request.params;
    const outcome = kickFromGame(db, id, memberId, now(), rng);
    switch (outcome.kind) {
      case 'game_not_found':
        return noGame(reply);
      case 'member_not_found':
        return sendError(reply, 404, { code: 'member_not_found', message: 'ไม่พบผู้เล่นคนนี้ในเกมนี้' });
      case 'already_kicked':
        return sendError(reply, 409, { code: 'already_kicked', message: 'ผู้เล่นคนนี้ถูกเชิญออกไปแล้ว' });
      case 'is_gm':
        return sendError(reply, 409, { code: 'not_allowed', message: 'เชิญ GM ของเกมออกไม่ได้ เกมจะค้างรอ GM อนุมัติ' });
      case 'already_ended':
        return ended(reply);
      case 'kicked':
        onKicked(id, memberId, outcome.turnClosed);
        return sendMembers(reply, id);
    }
  });

  // ISK-098: what the AI remembers of each player of a game (the server owner only; a player never gets it).
  app.get<{ Params: { id: string } }>('/api/admin/games/:id/memory', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body = adminMemory(db, assets, request.params.id);
    if (!body) return noGame(reply);
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.post<{ Params: { id: string } }>('/api/admin/games/:id/invite-code', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const outcome = renewInviteCodeOf(db, request.params.id, now());
    if (outcome.kind === 'game_not_found') return noGame(reply);
    if (outcome.kind === 'already_ended') return ended(reply);
    const body: AdminInviteCodeResponse = { inviteCode: outcome.inviteCode };
    return reply.header('cache-control', 'no-store').send(body);
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
