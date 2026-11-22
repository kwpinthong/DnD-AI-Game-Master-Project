import {
  CharacterRequest,
  characterFieldErrors,
  CreateGameRequest,
  createGameFieldErrors,
  type CharacterResponse,
  LootChooseRequest,
  type LootResponse,
  UpdateGameRequest,
  type CreateGameResponse,
} from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { AiService } from '../ai/core/service.ts';
import type { Db } from '../db/client.ts';
import { readScenario, resetScenario, saveScenario, type ScenarioEditOutcome } from '../scenario/editor.ts';
import { createCharacter, getCharacter, updateCharacter, type CharacterOutcome } from './character.ts';
import { createCodeChecker } from './create-code.ts';
import { chooseLoot, getLoot, LOOT_AI_FAILED, rollLoot, type LootOutcome } from './loot.ts';
import {
  createGame,
  gameView,
  kickMember,
  renewInviteCode,
  startGame,
  updateGame,
  type MemberRow,
  type OwnerActionOutcome,
} from './service.ts';

export interface GameRouteOptions {
  /** scrypt hash of the create code (CREATE_CODE_HASH); without it nobody can create a game. */
  createCodeHash?: string;
  /**
   * The AI GM boundary: a game cannot be created or started while it is not ready (GEN-038 C4,
   * Q-075); the loot step (GEN-048) calls it.
   */
  ai: AiService;
}

const minutesUntil = (at: number, t: number) => Math.max(1, Math.ceil((at - t) / 60_000));

/**
 * POST /api/games creates a game (create code + the creator's name + PIN). The /api/game routes
 * act on the caller's own game, found from the bearer token; owner-only ones answer 403 to others.
 */
export function registerGameRoutes(app: FastifyInstance, db: Db, now: Clock, options: GameRouteOptions) {
  const checkCreateCode = createCodeChecker(options.createCodeHash, now);

  /** Sends 503 with the AI service's Thai reason and returns true when the AI GM is not ready. */
  function refuseWithoutAi(reply: FastifyReply): boolean {
    const state = options.ai.ready();
    if (state.ok) return false;
    void sendError(reply, 503, { code: 'ai_not_ready', message: state.message });
    return true;
  }

  app.post('/api/games', async (request, reply) => {
    const parsed = CreateGameRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, {
        code: 'invalid_input',
        message: 'ข้อมูลไม่ถูกต้อง',
        fields: createGameFieldErrors(request.body),
      });
    }

    // Checked before the create code so a server without AI does not use up create-code attempts.
    if (refuseWithoutAi(reply)) return reply;

    // The create code itself is never logged or echoed (Q-021).
    const check = await checkCreateCode(parsed.data.createCode);
    switch (check.kind) {
      case 'disabled':
        return sendError(reply, 503, {
          code: 'create_disabled',
          message: 'server นี้ยังไม่ได้ตั้ง create code จึงสร้างเกมไม่ได้',
        });
      case 'blocked':
        reply.header('retry-after', String(Math.ceil((check.retryAt - now()) / 1000)));
        return sendError(reply, 429, {
          code: 'too_many_attempts',
          message: `ใส่ create code ผิดหลายครั้ง ลองใหม่ได้ในอีก ${minutesUntil(check.retryAt, now())} นาที`,
          retryAt: new Date(check.retryAt).toISOString(),
        });
      case 'wrong':
        return sendError(reply, 403, { code: 'wrong_create_code', message: 'create code ไม่ถูกต้อง' });
      case 'ok':
        break;
    }

    const created = await createGame(db, parsed.data, now);
    const body: CreateGameResponse = {
      token: created.token,
      expiresAt: new Date(created.expiresAt).toISOString(),
      member: created.member,
      game: created.view,
    };
    return reply.code(200).send(body);
  });

  /** The caller's member row, or a 401 already sent. */
  function caller(request: FastifyRequest, reply: FastifyReply): MemberRow | undefined {
    const token = bearerToken(request.headers.authorization);
    const found = token ? memberRowForToken(db, token, now) : undefined;
    if (!found) void sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
    return found;
  }

  function sendOutcome(reply: FastifyReply, outcome: OwnerActionOutcome) {
    switch (outcome.kind) {
      case 'ok':
        return reply.code(200).send(outcome.view);
      case 'forbidden':
        return sendError(reply, 403, { code: 'forbidden', message: 'เฉพาะเจ้าของเกมทำได้' });
      case 'game_started':
        return sendError(reply, 409, { code: 'game_started', message: 'เกมเริ่มแล้ว เปลี่ยนโหมดหรือสมาชิกไม่ได้' });
      case 'member_not_found':
        return sendError(reply, 404, { code: 'member_not_found', message: 'ไม่พบสมาชิกคนนี้ในเกม' });
      case 'not_allowed':
        return sendError(reply, 409, { code: 'not_allowed', message: outcome.message });
      case 'cannot_start':
        return sendError(reply, 409, {
          code: 'cannot_start',
          message: `ยังเริ่มเกมไม่ได้: ${outcome.reasons.join(' / ')}`,
          reasons: outcome.reasons,
        });
    }
  }

  function sendScenario(reply: FastifyReply, outcome: ScenarioEditOutcome) {
    switch (outcome.kind) {
      case 'ok':
        return reply.code(200).send({ scenario: outcome.scenario, locked: outcome.locked });
      case 'forbidden':
        return sendError(reply, 403, {
          code: 'forbidden',
          message: 'เฉพาะ GM คนของเกมนี้แก้หรือดู scenario ได้ (เกมที่ไม่มี GM คนใช้ scenario ตั้งต้น)',
        });
      case 'game_started':
        return sendError(reply, 409, { code: 'game_started', message: 'เกมเริ่มแล้ว แก้ scenario ผ่านหน้านี้ไม่ได้' });
      case 'invalid': {
        // One message per field, keyed by its path (`timeline.3.day`; `timeline` for the whole list).
        const fields: Record<string, string> = {};
        for (const issue of outcome.errors) fields[issue.path || 'scenario'] ??= issue.message;
        return sendError(reply, 400, { code: 'invalid_input', message: 'scenario ไม่ถูกต้อง', fields });
      }
    }
  }

  // Scenario editor (GEN-046): the Human GM only; players never get scenario content.
  app.get('/api/game/scenario', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendScenario(reply, readScenario(db, me));
  });

  app.put('/api/game/scenario', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendScenario(reply, saveScenario(db, me, request.body, now()));
  });

  app.post('/api/game/scenario/reset', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendScenario(reply, resetScenario(db, me, now()));
  });

  app.get('/api/game', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return reply.send(gameView(db, me.gameId, me));
  });

  app.patch('/api/game', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const parsed = UpdateGameRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        fields[field] ??= issue.message;
      }
      return sendError(reply, 400, { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields });
    }
    return sendOutcome(reply, updateGame(db, me, parsed.data));
  });

  app.post('/api/game/invite-code', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendOutcome(reply, renewInviteCode(db, me));
  });

  app.delete<{ Params: { memberId: string } }>('/api/game/members/:memberId', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendOutcome(reply, kickMember(db, me, request.params.memberId, now));
  });

  app.post('/api/game/start', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    if (refuseWithoutAi(reply)) return reply;
    return sendOutcome(reply, startGame(db, me, now));
  });

  // --- Character (GEN-047): the caller's own character in their game. ---

  function sendCharacter(reply: FastifyReply, outcome: CharacterOutcome, okStatus: number) {
    switch (outcome.kind) {
      case 'ok': {
        const body: CharacterResponse = { character: outcome.character };
        return reply.code(okStatus).send(body);
      }
      case 'gm_has_no_character':
        return sendError(reply, 403, { code: 'forbidden', message: 'GM ไม่มีตัวละคร' });
      case 'character_exists':
        return sendError(reply, 409, { code: 'character_exists', message: 'คุณมีตัวละครในเกมนี้แล้ว (1 คนต่อ 1 ตัว)' });
      case 'character_not_found':
        return sendError(reply, 404, { code: 'character_not_found', message: 'ยังไม่ได้สร้างตัวละคร' });
      case 'game_started':
        return sendError(reply, 409, { code: 'game_started', message: 'เกมเริ่มแล้ว แก้ตัวตนของตัวละครไม่ได้' });
    }
  }

  /** The parsed body, or a 400 naming each wrong field already sent. */
  function characterInput(request: FastifyRequest, reply: FastifyReply): CharacterRequest | undefined {
    const parsed = CharacterRequest.safeParse(request.body ?? {});
    if (parsed.success) return parsed.data;
    void sendError(reply, 400, {
      code: 'invalid_input',
      message: 'ข้อมูลไม่ถูกต้อง',
      fields: characterFieldErrors(request.body),
    });
    return undefined;
  }

  app.get('/api/game/character', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const body: CharacterResponse = { character: getCharacter(db, me) };
    return reply.send(body);
  });

  app.post('/api/game/character', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const input = characterInput(request, reply);
    if (!input) return reply;
    return sendCharacter(reply, createCharacter(db, me, input, now), 201);
  });

  app.put('/api/game/character', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const input = characterInput(request, reply);
    if (!input) return reply;
    return sendCharacter(reply, updateCharacter(db, me, input, now), 200);
  });

  // --- Loot (GEN-048): the caller's own strength / weakness + Common skill / item. ---

  function sendLoot(reply: FastifyReply, outcome: LootOutcome) {
    switch (outcome.kind) {
      case 'ok': {
        const body: LootResponse = { loot: outcome.loot };
        return reply.code(200).send(body);
      }
      case 'gm_has_no_character':
        return sendError(reply, 403, { code: 'forbidden', message: 'GM ไม่มีตัวละคร' });
      case 'character_not_found':
        return sendError(reply, 404, { code: 'character_not_found', message: 'ยังไม่ได้สร้างตัวละคร' });
      case 'game_started':
        return sendError(reply, 409, { code: 'game_started', message: 'เกมเริ่มแล้ว เปลี่ยนของติดตัวไม่ได้' });
      case 'loot_closed':
        return sendError(reply, 409, { code: 'loot_closed', message: 'เลือกของติดตัวแล้ว สุ่มหรือเลือกใหม่ไม่ได้' });
      case 'loot_no_offer':
        return sendError(reply, 409, { code: 'loot_no_offer', message: 'ยังไม่มีตัวเลือก ให้ AI วิเคราะห์บุคลิกก่อน' });
      case 'invalid':
        return sendError(reply, 400, { code: 'invalid_input', message: 'เลือกของติดตัวไม่ถูกต้อง', fields: outcome.fields });
      case 'ai_error': {
        // Never the failure detail (it can name the provider's error); the player gets Thai text.
        const { error } = outcome;
        if (error.code === 'ai_not_ready') return sendError(reply, 503, { code: 'ai_not_ready', message: error.message });
        const message = error.code === 'budget_reached' ? error.message : LOOT_AI_FAILED;
        return sendError(reply, 503, { code: 'ai_unavailable', message });
      }
    }
  }

  app.get('/api/game/character/loot', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendLoot(reply, getLoot(db, me));
  });

  app.post('/api/game/character/loot', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    return sendLoot(reply, await rollLoot(db, options.ai, me, now));
  });

  app.post('/api/game/character/loot/choose', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const parsed = LootChooseRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? 'form')] ??= issue.message;
      return sendError(reply, 400, { code: 'invalid_input', message: 'เลือกของติดตัวไม่ถูกต้อง', fields });
    }
    return sendLoot(reply, chooseLoot(db, me, parsed.data, now));
  });
}
