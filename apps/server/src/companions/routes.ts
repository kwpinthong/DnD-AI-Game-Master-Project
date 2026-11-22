import { SaveCompanionRequest, type CompanionsResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { GameAssets } from '../assets/load.ts';
import type { Db } from '../db/client.ts';
import { companionsOf, releaseCompanion, saveCompanion, type CompanionOutcome } from './store.ts';

/**
 * The player's NPC companions (GEN-054, GDD §5): list, save the NPC at your place, release one.
 * Affinity, grades and evolution are engine work (store.ts) and never reach the player.
 */
export function registerCompanionRoutes(app: FastifyInstance, db: Db, now: Clock, assets: GameAssets) {
  function send(reply: FastifyReply, outcome: CompanionOutcome, okStatus: number) {
    switch (outcome.kind) {
      case 'ok': {
        const body: CompanionsResponse = { companions: outcome.companions };
        return reply.code(okStatus).send(body);
      }
      case 'gm_has_no_character':
        return sendError(reply, 403, { code: 'forbidden', message: 'GM ไม่มีคู่หู NPC' });
      case 'not_placed':
        return sendError(reply, 409, { code: 'not_allowed', message: 'ตัวละครยังไม่ได้อยู่ในเมือง (เกมยังไม่เริ่ม)' });
      case 'npc_not_found':
        return sendError(reply, 404, { code: 'npc_not_found', message: outcome.message });
      case 'already_companion':
        return sendError(reply, 409, { code: 'not_allowed', message: 'บันทึก NPC คนนี้ไว้แล้ว' });
      case 'companion_limit':
        return sendError(reply, 409, { code: 'companion_limit', message: 'บันทึก NPC ได้สูงสุด 3 คน ปล่อยคนเดิมก่อนจึงบันทึกคนใหม่ได้' });
    }
  }

  function caller(request: { headers: { authorization?: string | undefined } }, reply: FastifyReply) {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
    return me;
  }

  app.get('/api/game/companions', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return send(reply, companionsOf(db, assets, me), 200);
  });

  app.post('/api/game/companions', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const parsed = SaveCompanionRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, { code: 'invalid_input', message: 'เลือก NPC ที่จะบันทึก', fields: { ref: 'เลือก NPC ที่จะบันทึก' } });
    }
    return send(reply, saveCompanion(db, assets, me, parsed.data.ref, now()), 201);
  });

  app.delete<{ Params: { ref: string } }>('/api/game/companions/:ref', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return send(reply, releaseCompanion(db, assets, me, request.params.ref, now()), 200);
  });
}
