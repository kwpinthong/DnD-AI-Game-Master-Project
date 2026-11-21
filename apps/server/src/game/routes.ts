import {
  CreateGameRequest,
  createGameFieldErrors,
  UpdateGameRequest,
  type CreateGameResponse,
} from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { createCodeChecker } from './create-code.ts';
import {
  createGame,
  gameView,
  kickMember,
  renewInviteCode,
  startGame,
  updateGame,
  type MemberRow,
  type OwnerActionOutcome,
} from './service.ts';

export interface GameRouteOptions {
  /** scrypt hash of the create code (CREATE_CODE_HASH); without it nobody can create a game. */
  createCodeHash?: string;
}

const minutesUntil = (at: number, t: number) => Math.max(1, Math.ceil((at - t) / 60_000));

/**
 * POST /api/games creates a game (create code + the creator's name + PIN). The /api/game routes
 * act on the caller's own game, found from the bearer token; owner-only ones answer 403 to others.
 */
export function registerGameRoutes(app: FastifyInstance, db: Db, now: Clock, options: GameRouteOptions) {
  const checkCreateCode = createCodeChecker(options.createCodeHash, now);

  app.post('/api/games', async (request, reply) => {
    const parsed = CreateGameRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, {
        code: 'invalid_input',
        message: 'ข้อมูลไม่ถูกต้อง',
        fields: createGameFieldErrors(request.body),
      });
    }

    // The create code itself is never logged or echoed (Q-021).
    const check = await checkCreateCode(parsed.data.createCode);
    switch (check.kind) {
      case 'disabled':
        return sendError(reply, 503, {
          code: 'create_disabled',
          message: 'server นี้ยังไม่ได้ตั้ง create code จึงสร้างเกมไม่ได้',
        });
      case 'blocked':
        reply.header('retry-after', String(Math.ceil((check.retryAt - now()) / 1000)));
        return sendError(reply, 429, {
          code: 'too_many_attempts',
          message: `ใส่ create code ผิดหลายครั้ง ลองใหม่ได้ในอีก ${minutesUntil(check.retryAt, now())} นาที`,
          retryAt: new Date(check.retryAt).toISOString(),
        });
      case 'wrong':
        return sendError(reply, 403, { code: 'wrong_create_code', message: 'create code ไม่ถูกต้อง' });
      case 'ok':
        break;
    }

    const created = await createGame(db, parsed.data, now);
    const body: CreateGameResponse = {
      token: created.token,
      expiresAt: new Date(created.expiresAt).toISOString(),
      member: created.member,
      game: created.view,
    };
    return reply.code(200).send(body);
  });

  /** The caller's member row, or a 401 already sent. */
  function caller(request: FastifyRequest, reply: FastifyReply): MemberRow | undefined {
    const token = bearerToken(request.headers.authorization);
    const found = token ? memberRowForToken(db, token, now) : undefined;
    if (!found) void sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
    return found;
  }

  function sendOutcome(reply: FastifyReply, outcome: OwnerActionOutcome) {
    switch (outcome.kind) {
      case 'ok':
        return reply.code(200).send(outcome.view);
      case 'forbidden':
        return sendError(reply, 403, { code: 'forbidden', message: 'เฉพาะเจ้าของเกมทำได้' });
      case 'game_started':
        return sendError(reply, 409, { code: 'game_started', message: 'เกมเริ่มแล้ว เปลี่ยนโหมดหรือสมาชิกไม่ได้' });
      case 'member_not_found':
        return sendError(reply, 404, { code: 'member_not_found', message: 'ไม่พบสมาชิกคนนี้ในเกม' });
      case 'not_allowed':
        return sendError(reply, 409, { code: 'not_allowed', message: outcome.message });
      case 'cannot_start':
        return sendError(reply, 409, {
          code: 'cannot_start',
          message: `ยังเริ่มเกมไม่ได้: ${outcome.reasons.join(' / ')}`,
          reasons: outcome.reasons,
        });
    }
  }

  app.get('/api/game', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return reply.send(gameView(db, me.gameId, me));
  });

  app.patch('/api/game', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const parsed = UpdateGameRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        fields[field] ??= issue.message;
      }
      return sendError(reply, 400, { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields });
    }
    return sendOutcome(reply, updateGame(db, me, parsed.data));
  });

  app.post('/api/game/invite-code', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendOutcome(reply, renewInviteCode(db, me));
  });

  app.delete<{ Params: { memberId: string } }>('/api/game/members/:memberId', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendOutcome(reply, kickMember(db, me, request.params.memberId, now));
  });

  app.post('/api/game/start', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendOutcome(reply, startGame(db, me, now));
  });
}
