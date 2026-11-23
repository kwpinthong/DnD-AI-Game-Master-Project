import { AdminSessionRequest, type AdminSessionResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { AiConfig } from '../ai/config.ts';
import type { Db } from '../db/client.ts';
import { clientIp, maskIp } from '../auth/client-ip.ts';
import { CREATE_CODE_LIMIT, createKeyedCodeChecker } from '../game/create-code.ts';
import { createAdminSessions } from './session.ts';
import { gameUsageReport, overviewUsageReport } from './usage-report.ts';
import type { GameDataStore } from '../assets/game-data.ts';
import { registerGameDataRoutes } from './game-data-routes.ts';
import { registerVoteReviewRoutes } from './vote-review-routes.ts';
import { registerStyleRoutes } from './style-routes.ts';
import { registerNpcLibraryRoutes } from './npc-library-routes.ts';
import type { StyleReview } from './style-review.ts';
import { registerStyleReviewRoutes } from './style-review-routes.ts';
import { registerStyleEvalRoutes } from './style-eval-routes.ts';
import type { LearningExtractor } from '../learning/extract.ts';
import { registerLearningRoutes } from './learning-routes.ts';

export interface AdminRouteOptions {
  /** scrypt hash of the server owner's admin code (ADMIN_CODE_HASH); without it the dashboard is closed. */
  adminCodeHash?: string;
  /** Prices and the per-game ceiling the dashboard compares against. */
  ai: AiConfig;
  /** Server log; gets one line when an IP is locked out (masked IP, never the code). */
  log?: (line: string) => void;
  /** GEN-147: the game data the editor reads and saves. */
  gameData: GameDataStore;
  /** GEN-178: the style review round. */
  styleReview: StyleReview;
  /** GEN-080: the lore + feedback extract of ended games. */
  learning: LearningExtractor;
}

const FORBIDDEN = 'หน้านี้สำหรับเจ้าของ server เท่านั้น';
const minutesUntil = (at: number, t: number) => Math.max(1, Math.ceil((at - t) / 60_000));

/**
 * The server owner's AI usage dashboard (GEN-061, Q-058). Only an admin token from
 * POST /api/admin/session opens the data routes; a player's, game owner's or GM's session is 403.
 * Wrong codes are limited like the create code (10 in 10 minutes block 10 minutes), counted per client
 * IP (Q-170: X-Forwarded-For first hop, else the socket address), so one guesser cannot lock the owner out.
 * The code and tokens are never logged or echoed; IPs only masked.
 */
export function registerAdminRoutes(app: FastifyInstance, db: Db, now: Clock, options: AdminRouteOptions) {
  const checkCode = createKeyedCodeChecker(options.adminCodeHash, now, (ip, until) =>
    options.log?.(`[admin] wrong admin code ${CREATE_CODE_LIMIT.maxFailures} times from ${maskIp(ip)}: locked until ${new Date(until).toISOString()}`),
  );
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
    const check = await checkCode(parsed.data.code, clientIp(request.headers['x-forwarded-for'], request.socket.remoteAddress));
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

  registerGameDataRoutes(app, options.gameData, refuse, now);
  registerVoteReviewRoutes(app, db, refuse, now, options.log ?? (() => {}));
  registerStyleRoutes(app, db, refuse, options.gameData);
  registerNpcLibraryRoutes(app, db, refuse, now);
  registerStyleReviewRoutes(app, options.styleReview, refuse);
  registerStyleEvalRoutes(app, db, refuse);
  registerLearningRoutes(app, db, options.learning, refuse);

  app.get<{ Params: { gameId: string } }>('/api/admin/ai-usage/:gameId', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const report = gameUsageReport(db, options.ai, now(), request.params.gameId);
    if (!report) return sendError(reply, 404, { code: 'game_not_found', message: 'ไม่พบเกมนี้' });
    return reply.header('cache-control', 'no-store').send(report);
  });
}
