import { NpcChatRequest } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { memberRowForToken } from '../auth/join.ts';
import { bearerToken, noSession, sendError } from '../auth/routes.ts';
import { npcChatStatus, sendNpcChat, type ChatOutcome, type NpcChatDeps } from './service.ts';

/** GET / POST /api/game/npc-chat (GEN-149): the period's quota, and one message to an NPC at your place. */
export function registerNpcChatRoutes(app: FastifyInstance, deps: NpcChatDeps) {
  const me = (request: { headers: { authorization?: string | undefined } }, reply: FastifyReply) => {
    const token = bearerToken(request.headers.authorization);
    const found = token ? memberRowForToken(deps.db, token, deps.now) : undefined;
    if (!found) sendError(reply, 401, noSession(request.headers.authorization));
    return found;
  };
  const answer = (reply: FastifyReply, outcome: ChatOutcome) => (outcome.ok ? reply.code(outcome.status).send(outcome.body) : sendError(reply, outcome.status, outcome.error));

  app.get('/api/game/npc-chat', async (request, reply) => {
    const caller = me(request, reply);
    return caller ? answer(reply, npcChatStatus(deps.db, deps.assets, caller, deps.now())) : reply;
  });

  app.post('/api/game/npc-chat', async (request, reply) => {
    const caller = me(request, reply);
    if (!caller) return reply;
    const parsed = NpcChatRequest.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: 'invalid_input', message: 'เลือก NPC และพิมพ์ข้อความ', fields: { text: 'เลือก NPC และพิมพ์ข้อความ' } });
    return answer(reply, await sendNpcChat(deps, caller, parsed.data));
  });
}
