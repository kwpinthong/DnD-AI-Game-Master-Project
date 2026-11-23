import { AdminFeedbackStatusRequest, FeedbackInput, FeedbackStatus, FeedbackType, type AdminFeedbackResponse, type ApiError, type FeedbackRow } from '@isekai/protocol';
import { restorePhaseState } from '@isekai/rules';
import { and, count, desc, eq, gt, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, noSession, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { feedback, feedbackAudit, gamePhase } from '../db/schema.ts';

/** 5 reports per member in any 10 minutes, counted from the table (survives a restart). */
export const FEEDBACK_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 } as const;
const ADMIN_LIST_MAX = 200;

const UNAUTHORIZED: ApiError = { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' };

type Stored = typeof feedback.$inferSelect;
const iso = (t: number) => new Date(t).toISOString();
const view = (r: Stored): FeedbackRow => ({
  id: r.id,
  gameId: r.gameId,
  memberId: r.memberId,
  type: r.type,
  text: r.text,
  context: { day: r.day, period: r.period, turn: r.turn, page: r.page, userAgent: r.userAgent },
  status: r.status,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

/** The 400 of a bad body: the first field that failed decides the code. */
function inputError(issues: readonly { path: readonly PropertyKey[]; code: string }[]): ApiError {
  const issue = issues[0];
  switch (issue?.path[0]) {
    case 'type':
      return { code: 'invalid_type', message: 'เลือกประเภท: บั๊ก / ข้อเสนอ / อื่นๆ' };
    case 'page':
      return { code: 'invalid_page', message: 'ไม่รู้จักหน้านี้' };
    case 'text':
      return issue.code === 'custom' ? { code: 'text_too_long', message: 'ยาวได้ไม่เกิน 1000 ตัวอักษร' } : { code: 'text_required', message: 'พิมพ์ข้อความก่อนส่ง' };
    default:
      return { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: { [String(issue?.path[0] ?? 'body')]: 'ข้อมูลไม่ถูกต้อง' } };
  }
}

/**
 * ISK-010: POST /api/feedback. Any member with a session (lobby, play, end page). Game and member come from the
 * session, day / period / turn from the game's stored turn state (null before the first turn), never the body.
 * The text is never logged and never published to the room.
 */
export function registerFeedbackRoutes(app: FastifyInstance, db: Db, now: Clock) {
  app.post('/api/feedback', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 401, noSession(request.headers.authorization));
    const parsed = FeedbackInput.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, inputError(parsed.error.issues));

    const t = now();
    const recent = db
      .select({ n: count() })
      .from(feedback)
      .where(and(eq(feedback.memberId, me.id), gt(feedback.createdAt, t - FEEDBACK_LIMIT.windowMs)))
      .get();
    if ((recent?.n ?? 0) >= FEEDBACK_LIMIT.max) return sendError(reply, 429, { code: 'rate_limited', message: 'ส่งได้ 5 ครั้งใน 10 นาที ลองใหม่อีกสักครู่' });

    // Read only: a lobby game has no turn state yet, and sending feedback must not create one.
    const phase = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, me.gameId)).get();
    const at = phase ? restorePhaseState(JSON.parse(phase.state)) : null;
    const row = db
      .insert(feedback)
      .values({
        gameId: me.gameId,
        memberId: me.id,
        type: parsed.data.type,
        text: parsed.data.text,
        day: at?.day ?? null,
        period: at?.phase ?? null,
        turn: at?.turn ?? null,
        page: parsed.data.page,
        userAgent: parsed.data.userAgent ?? '',
        createdAt: t,
        updatedAt: t,
      })
      .returning()
      .get();
    return reply.code(201).send(view(row));
  });
}

/**
 * ISK-010: the owner's list (latest 200, newest first, `?status=` / `?type=`) and status change (audited).
 * No token at all is 401; any other token goes through the admin check (`refuse`, 403).
 */
export function registerFeedbackAdminRoutes(app: FastifyInstance, db: Db, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean, now: Clock) {
  const denied = (request: FastifyRequest, reply: FastifyReply) => {
    if (bearerToken(request.headers.authorization)) return refuse(request, reply);
    void sendError(reply, 401, UNAUTHORIZED);
    return true;
  };

  app.get<{ Querystring: { status?: string; type?: string } }>('/api/admin/feedback', async (request, reply) => {
    if (denied(request, reply)) return reply;
    const { status, type } = request.query;
    const filters: SQL[] = [];
    if (status !== undefined) {
      const s = FeedbackStatus.safeParse(status);
      if (!s.success) return sendError(reply, 400, { code: 'invalid_status', message: 'สถานะต้องเป็น new / reviewing / done' });
      filters.push(eq(feedback.status, s.data));
    }
    if (type !== undefined) {
      const k = FeedbackType.safeParse(type);
      if (!k.success) return sendError(reply, 400, { code: 'invalid_type', message: 'ประเภทต้องเป็น bug / idea / other' });
      filters.push(eq(feedback.type, k.data));
    }
    const rows = db
      .select()
      .from(feedback)
      .where(and(...filters))
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(ADMIN_LIST_MAX)
      .all();
    const body: AdminFeedbackResponse = { feedback: rows.map(view) };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.patch<{ Params: { id: string } }>('/api/admin/feedback/:id', async (request, reply) => {
    if (denied(request, reply)) return reply;
    const parsed = AdminFeedbackStatusRequest.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: 'invalid_status', message: 'สถานะต้องเป็น new / reviewing / done' });
    const id = Number(request.params.id);
    const found = Number.isSafeInteger(id) ? db.select().from(feedback).where(eq(feedback.id, id)).get() : undefined;
    if (!found) return sendError(reply, 404, { code: 'feedback_not_found', message: 'ไม่พบรายงานนี้' });

    const t = now();
    const to = parsed.data.status;
    const row = db.transaction((tx) => {
      tx.insert(feedbackAudit).values({ feedbackId: found.id, action: 'status', from: found.status, to, at: t }).run();
      return tx.update(feedback).set({ status: to, updatedAt: t }).where(eq(feedback.id, found.id)).returning().get()!;
    });
    return reply.header('cache-control', 'no-store').send(view(row));
  });
}
