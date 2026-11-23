import { StyleEvalMarkRequest } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { markStyleEval, styleEvalView } from '../eval/style-eval.ts';

/** GEN-167: the style eval rounds side by side and Nok's marks (server owner); every route needs the admin token. */
export function registerStyleEvalRoutes(app: FastifyInstance, db: Db, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean) {
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

  app.get('/api/admin/style-eval', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    return noStore(reply).send(styleEvalView(db));
  });

  app.put<{ Params: { runId: string; sceneId: string } }>('/api/admin/style-eval/:runId/marks/:sceneId', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const parsed = StyleEvalMarkRequest.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: 'invalid_input', message: 'เลือก ดีขึ้น / เท่าเดิม / แย่ลง', fields: { mark: 'เลือก ดีขึ้น / เท่าเดิม / แย่ลง' } });
    const runId = Number(request.params.runId);
    const result = Number.isSafeInteger(runId) ? markStyleEval(db, runId, request.params.sceneId, parsed.data.mark) : 'not_found';
    if (result === 'not_found') return sendError(reply, 404, { code: 'response_not_found', message: 'ไม่พบฉากนี้ในรอบนี้' });
    if (result === 'no_previous') return sendError(reply, 409, { code: 'not_allowed', message: 'รอบแรกยังไม่มีรอบก่อนให้เทียบ' });
    return noStore(reply).send(result);
  });
}
