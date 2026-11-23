import { GM_CONSOLE_PATH, type GmAdjustResponse, type GmInsertEventResponse, type GmLogResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GameAssets } from '../assets/load.ts';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import type { MemberRow } from '../game/service.ts';
import type { RoomService } from '../room/service.ts';
import { gameVotes } from '../room/vote.ts';
import { adjustValue, approveTurn, consoleView, editTurn, insertEvent, overrideLog, type ConsoleResult } from './console.ts';

/**
 * The Human GM console routes (GEN-058), all under /api/game/gm/. Only the game's Human GM gets an answer;
 * a player (also the owner of a game without a GM) gets 403 with nothing of the game (Q-136). The log lines
 * carry ids and turn points only: never names, narration or reasons.
 */
export function registerGmConsoleRoutes(app: FastifyInstance, db: Db, now: Clock, room: RoomService, assets: GameAssets, log: (line: string) => void = (line) => console.log(line)) {
  function gmOf(request: FastifyRequest, reply: FastifyReply): MemberRow | undefined {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) {
      void sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
      return undefined;
    }
    if (me.role !== 'gm') {
      void sendError(reply, 403, { code: 'forbidden', message: 'GM console ใช้ได้เฉพาะ GM ของเกมนี้' });
      return undefined;
    }
    return me;
  }

  function answer<T>(reply: FastifyReply, result: ConsoleResult<T>, ok: (value: T) => unknown = (v) => v) {
    if (!result.ok) return sendError(reply, result.failure.status, result.failure.body);
    return reply.send(ok(result.value));
  }

  app.get(`${GM_CONSOLE_PATH}/console`, async (request, reply) => {
    const gm = gmOf(request, reply);
    if (!gm) return reply;
    return reply.send(consoleView(db, room, assets, gm, now()));
  });

  app.post(`${GM_CONSOLE_PATH}/turn/edit`, async (request, reply) => {
    const gm = gmOf(request, reply);
    if (!gm) return reply;
    const result = editTurn(db, room, gm, request.body, now());
    if (result.ok) log(`[gm-console] game=${gm.gameId} turn edited day=${result.value.at.day} ${result.value.at.phase} turn=${result.value.at.turn}`);
    return answer(reply, result);
  });

  app.post(`${GM_CONSOLE_PATH}/turn/approve`, async (request, reply) => {
    const gm = gmOf(request, reply);
    if (!gm) return reply;
    const result = approveTurn(db, room, gm, now());
    if (result.ok) log(`[gm-console] game=${gm.gameId} turn approved day=${result.value.approved.day} ${result.value.approved.phase} turn=${result.value.approved.turn}`);
    return answer(reply, result);
  });

  app.post(`${GM_CONSOLE_PATH}/adjust`, async (request, reply) => {
    const gm = gmOf(request, reply);
    if (!gm) return reply;
    const result = adjustValue(db, gm, request.body, now());
    if (result.ok) log(`[gm-console] game=${gm.gameId} adjust override=${result.value.id}`);
    return answer(reply, result, (override): GmAdjustResponse => ({ override }));
  });

  app.post(`${GM_CONSOLE_PATH}/events`, async (request, reply) => {
    const gm = gmOf(request, reply);
    if (!gm) return reply;
    const result = insertEvent(db, gm, request.body, now());
    if (result.ok) log(`[gm-console] game=${gm.gameId} event inserted id=${result.value.id}`);
    return answer(reply, result, (event): GmInsertEventResponse => ({ event }));
  });

  app.get(`${GM_CONSOLE_PATH}/log`, async (request, reply) => {
    const gm = gmOf(request, reply);
    if (!gm) return reply;
    return reply.send({ overrides: overrideLog(db, gm.gameId) } satisfies GmLogResponse);
  });

  // GEN-126: the players' 👍 / 👎 per AI message (GEN-107) with the Q-286 / Q-287 flags; a player sees only their own vote, on their entries.
  app.get(`${GM_CONSOLE_PATH}/votes`, async (request, reply) => {
    const gm = gmOf(request, reply);
    if (!gm) return reply;
    return reply.send(gameVotes(db, gm.gameId));
  });
}
