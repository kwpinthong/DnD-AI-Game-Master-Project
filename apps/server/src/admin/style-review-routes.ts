import { StyleProposalApproveRequest, type StyleReviewResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../auth/routes.ts';
import type { StyleDecision, StyleReview } from './style-review.ts';

/** GEN-178: the style review tab of the server owner; every route needs the admin token (`refuse` answers 403). */
export function registerStyleReviewRoutes(app: FastifyInstance, review: StyleReview, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean) {
  const send = (reply: FastifyReply) => {
    const body: StyleReviewResponse = review.state();
    return reply.header('cache-control', 'no-store').send(body);
  };
  const decided = (reply: FastifyReply, outcome: StyleDecision) => {
    if (outcome.ok) return send(reply);
    if (outcome.reason === 'not_found') return sendError(reply, 404, { code: 'response_not_found', message: 'ไม่พบข้อเสนอหรือเวอร์ชันนี้' });
    if (outcome.reason === 'decided') return sendError(reply, 409, { code: 'not_allowed', message: 'ข้อเสนอนี้ตัดสินไปแล้ว' });
    return sendError(reply, 400, { code: 'invalid_input', message: outcome.message, fields: outcome.fields });
  };
  const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : -1);

  app.get('/api/admin/style-review', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    return send(reply);
  });

  // The AI call takes longer than a page request: the round runs on, the tab shows `running` until it is stored.
  app.post('/api/admin/style-review/run', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    void review.run('manual');
    return send(reply);
  });

  app.post<{ Params: { id: string } }>('/api/admin/style-review/proposals/:id/approve', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const parsed = StyleProposalApproveRequest.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: { content: 'ส่งเนื้อหากฎเป็น JSON object' } });
    return decided(reply, review.approve(idOf(request.params.id), parsed.data.content));
  });

  app.post<{ Params: { id: string } }>('/api/admin/style-review/proposals/:id/reject', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    return decided(reply, review.reject(idOf(request.params.id)));
  });

  app.post<{ Params: { version: string } }>('/api/admin/style-review/voice/:version/restore', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    return decided(reply, review.restore(idOf(request.params.version)));
  });
}
