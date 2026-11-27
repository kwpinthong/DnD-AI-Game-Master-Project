import {
  CharacterRequest,
  characterFieldErrors,
  CreateGameRequest,
  createGameFieldErrors,
  GameReadyRequest,
  parseScenario,
  sortTimeline,
  type CharacterResponse,
  LootChooseRequest,
  type LootResponse,
  type OriginResponse,
  appearanceLabels,
  type AppearanceOptionsResponse,
  type Scenario,
  type CreateGameResponse,
} from '@isekai/protocol';
import type { KarmaTier, Rng } from '@isekai/rules';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, noSession, sendError } from '../auth/routes.ts';
import type { AiService } from '../ai/core/service.ts';
import type { GameAssets } from '../assets/load.ts';
import type { Db } from '../db/client.ts';
import { checkedMemory } from '../learning/memory.ts';
import { playerKeyOf, saveJoinStyle } from '../learning/style.ts';
import type { Lobby } from '../room/lobby.ts';
import { readScenario } from '../scenario/editor.ts';
import type { WeatherService } from '../weather/service.ts';
import { checkLooks, type Looks } from './appearance.ts';
import { createCharacter, getCharacter, updateCharacter, type CharacterOutcome } from './character.ts';
import { createCodeChecker } from './create-code.ts';
import { spawnLateJoiner } from './late-join.ts';
import { chooseLoot, getLoot, LOOT_AI_FAILED, rollLoot, type LootOutcome } from './loot.ts';
import { getOrigin, narrateOrigins } from './origin.ts';
import { closureOf } from '../admin/games.ts';
import { createGame, gameView, setReady, type MemberRow } from './service.ts';

export interface GameRouteOptions {
  /** scrypt hash of the create code (CREATE_CODE_HASH); without it nobody can create a game. */
  createCodeHash?: string;
  /**
   * The AI GM boundary: a game cannot be created or started while it is not ready (GEN-038 C4,
   * Q-075); the loot step (GEN-048) calls it.
   */
  ai: AiService;
  /** Karma bands from the assets (GEN-067): the owner's own Karma word in their character. */
  karmaTiers: readonly KarmaTier[];
  /** Game data (GEN-062): the loot step offers its Rank B Ability / Item rows (GEN-073); Start_Scenarios (GEN-065). */
  assets: GameAssets;
  /** Real rolls: each player's start scenario at game start (GEN-065); null = none (ServerOptions.rng). */
  rng: Rng | null;
  /** ISK-017: the lobby sockets that hear `lobby_ready` / `lobby_start_blocked`. */
  lobby: Lobby;
  /** ISK-009: the start's weather, picked before the crossing narrations tell it. */
  weather?: Pick<WeatherService, 'ensure'>;
}

const minutesUntil = (at: number, t: number) => Math.max(1, Math.ceil((at - t) / 60_000));

/**
 * POST /api/games creates a game (create code + the creator's name + PIN + every setting, ISK-017). The /api/game
 * routes act on the caller's own game, found from the bearer token; every player has the same rights (no owner).
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

    // ISK-017: the scenario is set here once, checked as the old scenario editor did (one message per field).
    let scenario: Scenario | undefined;
    if (parsed.data.scenario !== undefined) {
      const checked = parseScenario(parsed.data.scenario);
      if (!checked.ok) {
        const fields: Record<string, string> = {};
        for (const issue of checked.errors) fields[issue.path || 'scenario'] ??= issue.message;
        return sendError(reply, 400, { code: 'invalid_input', message: 'scenario ไม่ถูกต้อง', fields });
      }
      scenario = sortTimeline(checked.scenario);
    }

    // GEN-083: the memory's source games must be ended games of the creator's player code (409 as the lobby edit was).
    const playerCode = parsed.data.playerCode ?? '';
    const sources = checkedMemory(db, parsed.data.memory, playerCode === '' ? null : playerKeyOf(db, playerCode));
    if (sources === undefined) {
      return sendError(reply, 409, { code: 'not_allowed', message: 'ความทรงจำเลือกได้เฉพาะเกมที่จบแล้วที่คุณเป็นสมาชิก (ตามรหัสผู้เล่น)' });
    }
    // GEN-177: no tone picked = the server default (the Voice data set, set at /admin).
    const created = await createGame(db, parsed.data, now, options.assets.voice.tone, sources, scenario);
    // GEN-082 / GEN-201: the creator's code and opt-out tick link their style like a join does.
    saveJoinStyle(db, { id: created.member.id, gameId: created.member.gameId }, { playerCode, noStyle: parsed.data.noStyle ?? false }, now());
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
    if (!found) void sendError(reply, 401, noSession(request.headers.authorization));
    return found;
  }

  // Scenario (GEN-046): the Human GM reads it; ISK-017: it is set once at creation, nobody edits it afterwards.
  app.get('/api/game/scenario', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const outcome = readScenario(db, me);
    if (outcome.kind === 'ok') return reply.code(200).send({ scenario: outcome.scenario, locked: outcome.locked });
    return sendError(reply, 403, {
      code: 'forbidden',
      message: 'เฉพาะ GM คนของเกมนี้ดู scenario ได้ (เกมที่ไม่มี GM คนใช้ scenario ตั้งต้น)',
    });
  });

  app.get('/api/game', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    // ISK-001: the lobby polls this; a closed game says so.
    return reply.send({ ...gameView(db, me.gameId, me), closed: closureOf(db, me.gameId) });
  });

  // ISK-017: no host. Each player presses ready; the server starts the game itself once everyone is.
  app.post('/api/game/ready', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const parsed = GameReadyRequest.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: { ready: 'ส่ง true หรือ false' } });
    const outcome = setReady(db, me, parsed.data.ready, now, options.assets, options.rng, () => options.ai.ready());
    if (outcome.kind === 'not_in_lobby') return sendError(reply, 409, { code: 'not_in_lobby', message: 'กดพร้อมได้เฉพาะผู้เล่นในห้องรอ ก่อนเกมเริ่ม' });
    options.lobby.send(me.gameId, { type: 'lobby_ready', memberId: me.id, ready: parsed.data.ready });
    if (outcome.kind === 'ai_not_ready') {
      options.lobby.send(me.gameId, { type: 'lobby_start_blocked', reason: outcome.message });
      return sendError(reply, 503, { code: 'ai_not_ready', message: outcome.message });
    }
    // The start scenarios are already stored; the private narrations follow. A failed one stays null and
    // is written on the player's next GET /api/game/origin (GEN-065 C8).
    if (outcome.started) await narrateOrigins(db, options.ai, options.assets, me.gameId, now, options.weather);
    return reply.code(200).send(outcome.view);
  });

  // --- Start scenario (GEN-065): the caller's own origin; the Human GM sees every player's. ---

  app.get('/api/game/origin', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const body: OriginResponse = await getOrigin(db, options.ai, options.assets, me, now);
    return reply.send(body);
  });

  // ISK-015: a late joiner with a character and a loot choice spawns; the answer is their crossing narration.
  app.post('/api/game/spawn', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const outcome = spawnLateJoiner(db, me, options.assets, options.rng, now);
    switch (outcome.kind) {
      case 'ok': {
        const body: OriginResponse = await getOrigin(db, options.ai, options.assets, me, now);
        return reply.send(body);
      }
      case 'gm_has_no_character':
        return sendError(reply, 403, { code: 'forbidden', message: 'GM ไม่มีตัวละคร' });
      case 'character_not_found':
        return sendError(reply, 404, { code: 'character_not_found', message: 'ยังไม่ได้สร้างตัวละคร' });
      case 'not_preparing':
        return sendError(reply, 409, { code: 'not_allowed', message: 'คุณอยู่ในเกมแล้ว ไม่ต้องเกิดใหม่' });
      case 'no_loot':
        return sendError(reply, 409, { code: 'not_allowed', message: 'ยังไม่ได้เลือกของติดตัว เลือกก่อนแล้วค่อยเข้าเมือง' });
      case 'game_ended':
        return sendError(reply, 409, { code: 'game_ended', message: 'เกมนี้จบไปแล้ว เข้าเล่นไม่ได้' });
    }
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

  /** The parsed body and its checked avatar + chips (ISK-006), or a 400 already sent. */
  function characterInput(request: FastifyRequest, reply: FastifyReply, me: MemberRow): { input: CharacterRequest; looks: Looks } | undefined {
    const parsed = CharacterRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      void sendError(reply, 400, {
        code: 'invalid_input',
        message: 'ข้อมูลไม่ถูกต้อง',
        fields: characterFieldErrors(request.body),
      });
      return undefined;
    }
    const checked = checkLooks(db, me.gameId, options.assets, parsed.data);
    if (!checked.ok) {
      void sendError(reply, 400, checked.problem);
      return undefined;
    }
    return { input: parsed.data, looks: checked.looks };
  }

  // ISK-006: the chip values a new character may pick (no login: nothing secret in it).
  app.get('/api/appearance-options', async (_request, reply) => {
    const body: AppearanceOptionsResponse = { categories: appearanceLabels(options.assets.appearanceOptions) };
    return reply.send(body);
  });

  app.get('/api/game/character', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const body: CharacterResponse = { character: getCharacter(db, me, options.karmaTiers) };
    return reply.send(body);
  });

  app.post('/api/game/character', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const body = characterInput(request, reply, me);
    if (!body) return reply;
    return sendCharacter(reply, createCharacter(db, me, body.input, body.looks, now, options.karmaTiers), 201);
  });

  app.put('/api/game/character', async (request, reply) => {
    const me = caller(request, reply);
    if (!me) return reply;
    const body = characterInput(request, reply, me);
    if (!body) return reply;
    return sendCharacter(reply, updateCharacter(db, me, body.input, body.looks, now, options.karmaTiers), 200);
  });

  // --- Loot (GEN-048, GEN-073): the caller's own strength / weakness + Rank B skill / item. ---

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
        return sendError(reply, 409, { code: 'loot_closed', message: 'สุ่มใหม่ครบโควต้าแล้ว' });
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
    return sendLoot(reply, await rollLoot(db, options.ai, options.assets, me, now));
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
