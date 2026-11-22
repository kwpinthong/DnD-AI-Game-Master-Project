import { AdminSessionRequest, type AdminSessionResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { AiConfig } from '../ai/config.ts';
import type { Db } from '../db/client.ts';
import { createCodeChecker } from '../game/create-code.ts';
import { createAdminSessions } from './session.ts';
import { gameUsageReport, overviewUsageReport } from './usage-report.ts';

export interface AdminRouteOptions {
  /** scrypt hash of the server owner's admin code (ADMIN_CODE_HASH); without it the dashboard is closed. */
  adminCodeHash?: string;
  /** Prices and the per-game ceiling the dashboard compares against. */
  ai: AiConfig;
}

const FORBIDDEN = 'หน้านี้สำหรับเจ้าของ server เท่านั้น';
const minutesUntil = (at: number, t: number) => Math.max(1, Math.ceil((at - t) / 60_000));

/**
 * The server owner's AI usage dashboard (GEN-061, Q-058). Only an admin token from
 * POST /api/admin/session opens the data routes; a player's, game owner's or GM's session is 403.
 * Wrong codes are limited like the create code (10 in 10 minutes block 10 minutes, server-wide).
 * The code and tokens are never logged or echoed.
 */
export function registerAdminRoutes(app: FastifyInstance, db: Db, now: Clock, options: AdminRouteOptions) {
  const checkCode = createCodeChecker(options.adminCodeHash, now);
  const sessions = createAdminSessions(now);

  /** Sends 403 and returns true unless the request carries a live admin token. */
  function refuse(request: FastifyRequest, reply: FastifyReply): boolean {
    if (sessions.valid(bearerToken(request.headers.authorization))) return false;
    void sendError(reply, 403, { code: 'forbidden', message: FORBIDDEN });
    return true;
  }

  app.post('/api/admin/session', async (request, reply) => {
    const parsed = AdminSessionRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: { code: 'ใส่ admin code' } });
    }
    const check = await checkCode(parsed.data.code);
    switch (check.kind) {
      case 'disabled':
        return sendError(reply, 503, { code: 'admin_disabled', message: 'server นี้ยังไม่ได้ตั้ง admin code (ADMIN_CODE_HASH) จึงเปิดหน้านี้ไม่ได้' });
      case 'blocked':
        reply.header('retry-after', String(Math.ceil((check.retryAt - now()) / 1000)));
        return sendError(reply, 429, {
          code: 'too_many_attempts',
          message: `ใส่ admin code ผิดหลายครั้ง ลองใหม่ได้ในอีก ${minutesUntil(check.retryAt, now())} นาที`,
          retryAt: new Date(check.retryAt).toISOString(),
        });
      case 'wrong':
        return sendError(reply, 403, { code: 'wrong_admin_code', message: 'admin code ไม่ถูกต้อง' });
      case 'ok': {
        const session = sessions.issue();
        const body: AdminSessionResponse = { token: session.token, expiresAt: new Date(session.expiresAt).toISOString() };
        return reply.code(200).send(body);
      }
    }
  });

  app.post('/api/admin/logout', async (request, reply) => {
    sessions.revoke(bearerToken(request.headers.authorization));
    return reply.code(204).send();
  });

  app.get('/api/admin/ai-usage', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    return reply.header('cache-control', 'no-store').send(overviewUsageReport(db, options.ai, now()));
  });

  app.get<{ Params: { gameId: string } }>('/api/admin/ai-usage/:gameId', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const report = gameUsageReport(db, options.ai, now(), request.params.gameId);
    if (!report) return sendError(reply, 404, { code: 'game_not_found', message: 'ไม่พบเกมนี้' });
    return reply.header('cache-control', 'no-store').send(report);
  });
}
