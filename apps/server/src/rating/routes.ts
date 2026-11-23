import { GameRatingRequest, ResponseVoteRequest, type GameRatingResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import type { MemberRow } from '../game/service.ts';
import { gameEnded, ratingViewFor, saveRating, setRulingVote } from './store.ts';

/**
 * After the end (GEN-078): each member's score 1–10 + comment, and their 👍 on the rulings of the end page.
 * Members only (players and the Human GM): anyone else gets 403. Before the game ended: 409, nothing saved.
 */
export function registerRatingRoutes(app: FastifyInstance, db: Db, now: Clock, onRated: (gameId: string) => void = () => {}) {
  /** The calling member of an ended game; otherwise the error is sent and this is undefined. */
  function rater(request: { headers: { authorization?: string | undefined } }, reply: FastifyReply): MemberRow | undefined {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) {
      sendError(reply, 403, { code: 'forbidden', message: 'เฉพาะสมาชิกของเกมนี้เท่านั้นที่ให้คะแนนได้' });
      return undefined;
    }
    if (!gameEnded(db, me.gameId)) {
      sendError(reply, 409, { code: 'not_allowed', message: 'ให้คะแนนได้เมื่อเกมจบแล้วเท่านั้น' });
      return undefined;
    }
    return me;
  }

  const send = (reply: FastifyReply, me: MemberRow) => {
    const body: GameRatingResponse = { rating: ratingViewFor(db, me) };
    return reply.send(body);
  };

  app.get('/api/game/rating', async (request, reply) => {
    const me = rater(request, reply);
    return me ? send(reply, me) : reply;
  });

  app.put('/api/game/rating', async (request, reply) => {
    const me = rater(request, reply);
    if (!me) return reply;
    const parsed = GameRatingRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? 'score')] ??= issue.message;
      return sendError(reply, 400, { code: 'invalid_input', message: Object.values(fields)[0] ?? 'เลือกคะแนน 1–10', fields });
    }
    saveRating(db, me, { score: parsed.data.score, comment: parsed.data.comment.normalize('NFC') }, now());
    onRated(me.gameId);
    return send(reply, me);
  });

  /** GEN-171: the 👍/👎 of GEN-107 on a ruling (`vote: null` cancels); players only, the Human GM gets 403. */
  app.put<{ Params: { sourceRef: string } }>('/api/game/rating/votes/:sourceRef', async (request, reply) => {
    const me = rater(request, reply);
    if (!me) return reply;
    if (me.role !== 'player') return sendError(reply, 403, { code: 'forbidden', message: 'เฉพาะผู้เล่นเท่านั้นที่โหวตการตัดสินได้' });
    const parsed = ResponseVoteRequest.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: 'invalid_input', message: 'เลือก ถูกใจ หรือ ไม่ถูกใจ', fields: { vote: 'เลือก ถูกใจ หรือ ไม่ถูกใจ' } });
    if (!setRulingVote(db, me, request.params.sourceRef, parsed.data.vote, now())) {
      return sendError(reply, 404, { code: 'ruling_not_found', message: 'ไม่พบการตัดสินนี้ในหน้าสรุปของเกม' });
    }
    return send(reply, me);
  });
}
