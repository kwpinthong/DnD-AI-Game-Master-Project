import { ResponseVoteRequest, type ResponseVoteResponse } from '@isekai/protocol';
import type { FastifyInstance } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { syncExamples } from '../learning/examples.ts';
import { myVoteFields, setVote } from './vote.ts';

/** PUT /api/game/entries/:seq/vote (GEN-107): a player's 👍 / 👎 (or null = cancel) on an AI-written entry; allowed before and after the end. */
export function registerVoteRoutes(app: FastifyInstance, db: Db, now: Clock) {
  app.put<{ Params: { seq: string } }>('/api/game/entries/:seq/vote', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 403, { code: 'forbidden', message: 'เฉพาะผู้เล่นของเกมนี้เท่านั้นที่ให้คะแนนได้' });
    const parsed = ResponseVoteRequest.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: 'invalid_input', message: 'เลือก ถูกใจ หรือ ไม่ถูกใจ', fields: { vote: 'เลือก ถูกใจ หรือ ไม่ถูกใจ' } });
    const seq = /^\d{1,15}$/.test(request.params.seq) ? Number(request.params.seq) : 0;
    const result = seq === 0 ? 'not_found' : setVote(db, me, seq, parsed.data.vote, now(), parsed.data.reasons);
    if (result === 'forbidden') return sendError(reply, 403, { code: 'forbidden', message: 'ข้อความนี้ไม่ใช่ของคุณ หรือคุณไม่ใช่ผู้เล่น' });
    if (result === 'not_found') return sendError(reply, 404, { code: 'response_not_found', message: 'ไม่พบข้อความของ AI GM นี้' });
    // GEN-081: after the end a vote may make (or unmake) a good / avoid example.
    syncExamples(db, me.gameId, now());
    const body: ResponseVoteResponse = { seq, ...myVoteFields(db, me.gameId, me.id, seq) };
    return reply.send(body);
  });
}
