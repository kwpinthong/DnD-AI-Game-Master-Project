import { PlayerStyleRequest, type MemorySourcesResponse, type PlayerStyleResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientIp } from '../auth/client-ip.ts';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { memberStyle } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { memorySources } from './memory.ts';
import { deleteStyle, knownKey, optedOut, playerKeyOf, profileOf, setOptOut } from './style.ts';

/** Unknown player codes per client IP: 5 in 10 minutes lock it out for 10 minutes (ADR §4, like the PIN). */
const LIMIT = { maxFailures: 5, windowMs: 10 * 60_000 };

/**
 * GEN-082: "สไตล์ของฉัน". The player code in the body (never a URL or header) is the key: look up, switch off
 * ("ไม่ให้เก็บสไตล์ฉัน") or delete the profile. A signed-in member may only use their own code (403 otherwise); an
 * unknown code is 403 and counts toward the IP's lock. The code is never logged or echoed.
 */
export function registerPlayerStyleRoutes(app: FastifyInstance, db: Db, now: Clock) {
  const failures = new Map<string, number[]>();

  /** The request's player key, or the error already sent (undefined). */
  function keyFor(request: FastifyRequest, reply: FastifyReply): { key: string; optOut: boolean | undefined } | undefined {
    const parsed = PlayerStyleRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      void sendError(reply, 400, { code: 'invalid_input', message: 'ใส่รหัสผู้เล่น', fields: { playerCode: 'ใส่รหัสผู้เล่น' } });
      return undefined;
    }
    const ip = clientIp(request.headers['x-forwarded-for'], request.socket.remoteAddress);
    const t = now();
    const recent = (failures.get(ip) ?? []).filter((at) => at > t - LIMIT.windowMs);
    if (recent.length >= LIMIT.maxFailures) {
      const retryAt = recent[0]! + LIMIT.windowMs;
      reply.header('retry-after', String(Math.max(1, Math.ceil((retryAt - t) / 1000))));
      void sendError(reply, 429, { code: 'too_many_attempts', message: 'ใส่รหัสผู้เล่นผิดหลายครั้ง ลองใหม่ภายหลัง', retryAt: new Date(retryAt).toISOString() });
      return undefined;
    }
    const key = playerKeyOf(db, parsed.data.playerCode);
    if (key === null || !knownKey(db, key)) {
      failures.set(ip, [...recent, t]);
      void sendError(reply, 403, { code: 'forbidden', message: 'ไม่พบรหัสผู้เล่นนี้' });
      return undefined;
    }
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (me && db.select({ k: memberStyle.playerKey }).from(memberStyle).where(eq(memberStyle.memberId, me.id)).get()?.k !== key) {
      void sendError(reply, 403, { code: 'forbidden', message: 'ดูได้เฉพาะสไตล์ของตัวเอง' });
      return undefined;
    }
    return { key, optOut: parsed.data.optOut };
  }

  const send = (reply: FastifyReply, key: string) => {
    const body: PlayerStyleResponse = { style: profileOf(db, key), optOut: optedOut(db, key) };
    return reply.header('cache-control', 'no-store').send(body);
  };

  app.post('/api/style', async (request, reply) => {
    const found = keyFor(request, reply);
    return found ? send(reply, found.key) : reply;
  });

  app.put('/api/style/opt-out', async (request, reply) => {
    const found = keyFor(request, reply);
    if (!found) return reply;
    if (found.optOut === undefined) return sendError(reply, 400, { code: 'invalid_input', message: 'เลือกเปิดหรือปิด', fields: { optOut: 'เลือกเปิดหรือปิด' } });
    setOptOut(db, found.key, found.optOut, now());
    return send(reply, found.key);
  });

  // GEN-083: the create form's source games of "ความทรงจำจากเกมก่อน" (same code check and lock as the style page).
  app.post('/api/memory/sources', async (request, reply) => {
    const found = keyFor(request, reply);
    if (!found) return reply;
    const body: MemorySourcesResponse = { games: memorySources(db, found.key) };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.post('/api/style/delete', async (request, reply) => {
    const found = keyFor(request, reply);
    if (!found) return reply;
    deleteStyle(db, found.key);
    return send(reply, found.key);
  });
}
