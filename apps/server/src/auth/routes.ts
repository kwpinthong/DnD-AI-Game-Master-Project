import { joinFieldErrors, JoinRequest, JoinStyleFields, type ApiError, type JoinResponse, type MeResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.ts';
import { saveJoinStyle } from '../learning/style.ts';
import { endSession, joinGame, memberForToken, type Clock } from './join.ts';

// Auth is a bearer token, not a cookie: the web app is on another site (Netlify, Q-031) and
// browsers increasingly block third-party cookies even with SameSite=None. The web keeps the
// token in localStorage and sends `Authorization: Bearer <token>`.

export const sendError = (reply: FastifyReply, status: number, body: ApiError) => reply.code(status).send(body);

export function registerAuthRoutes(app: FastifyInstance, db: Db, now: Clock) {
  app.post('/api/join', async (request, reply) => {
    const parsed = JoinRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, {
        code: 'invalid_input',
        message: 'ข้อมูลไม่ถูกต้อง',
        fields: joinFieldErrors(request.body),
      });
    }

    // GEN-082: the optional player code + "ไม่ต้องเก็บสไตล์ของฉัน" (`JoinStyleFields`) ride along in the same body.
    const style = JoinStyleFields.safeParse(request.body ?? {});
    if (!style.success) {
      return sendError(reply, 400, { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: { playerCode: 'รหัสผู้เล่นยาวได้ไม่เกิน 64 ตัวอักษร' } });
    }

    const outcome = await joinGame(db, parsed.data, now);
    if (outcome.kind === 'joined') saveJoinStyle(db, outcome.member, style.data, now());
    switch (outcome.kind) {
      case 'game_not_found':
        return sendError(reply, 404, { code: 'game_not_found', message: 'ไม่พบเกมจากโค้ดนี้ ตรวจตัวอักษรอีกครั้ง' });
      case 'single_mode':
        return sendError(reply, 409, { code: 'single_mode', message: 'เกมนี้เล่นคนเดียวและเริ่มไปแล้ว รับคนเพิ่มไม่ได้' });
      case 'join_closed_day':
        return sendError(reply, 409, { code: 'join_closed_day', message: 'เกมนี้เลยวันที่ 9 ไปแล้ว รับคนเพิ่มไม่ได้' });
      case 'game_ended':
        return sendError(reply, 409, { code: 'game_ended', message: 'เกมนี้จบไปแล้ว รับคนเพิ่มไม่ได้' });
      case 'game_full':
        return sendError(reply, 409, {
          code: 'game_full',
          message: outcome.mode === 'single' ? 'เกมเต็ม (เกมนี้เล่นคนเดียว)' : `เกมเต็ม (ผู้เล่นครบ ${outcome.max} คนแล้ว)`,
        });
      case 'kicked':
        return sendError(reply, 403, { code: 'kicked', message: 'ชื่อนี้ถูกเจ้าของเกมเชิญออกแล้ว เข้าเกมนี้อีกไม่ได้' });
      case 'wrong_pin':
        return sendError(reply, 401, {
          code: 'wrong_pin',
          message:
            outcome.attemptsLeft > 0
              ? `PIN ไม่ถูกต้อง เหลือ ${outcome.attemptsLeft} ครั้ง`
              : 'PIN ไม่ถูกต้อง ผิดครบ 5 ครั้ง ชื่อนี้ถูกล็อกชั่วคราว 10 นาที',
          attemptsLeft: outcome.attemptsLeft,
        });
      case 'locked': {
        const seconds = Math.max(1, Math.ceil((outcome.retryAt - now()) / 1000));
        reply.header('retry-after', String(seconds));
        return sendError(reply, 429, {
          code: 'locked',
          message: `ชื่อนี้ถูกล็อกชั่วคราวเพราะใส่ PIN ผิดหลายครั้ง ลองใหม่ได้ในอีก ${Math.ceil(seconds / 60)} นาที`,
          retryAt: new Date(outcome.retryAt).toISOString(),
        });
      }
      case 'joined': {
        const body: JoinResponse = {
          token: outcome.token,
          expiresAt: new Date(outcome.expiresAt).toISOString(),
          created: outcome.created,
          member: outcome.member,
        };
        return reply.code(200).send(body);
      }
    }
  });

  app.get('/api/me', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const found = token ? memberForToken(db, token, now) : undefined;
    if (!found) return sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
    const body: MeResponse = { member: found };
    return reply.send(body);
  });

  app.post('/api/logout', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (token) endSession(db, token);
    return reply.code(204).send();
  });
}

export function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer (\S+)$/.exec(header ?? '')?.[1];
}
