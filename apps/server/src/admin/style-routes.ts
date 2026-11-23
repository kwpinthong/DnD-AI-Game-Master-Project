import { StyleSettingsRequest, type StyleFlagsResponse, type StyleSettings, type StyleSettingsResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GameDataStore } from '../assets/game-data.ts';
import { sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { getStyleSettings, setStyleSettings, styleFlagStats } from '../gm/style-check.ts';

/**
 * GEN-169: the style checker's flag counts and settings (server owner); every route needs the admin token.
 * GEN-177: `defaultTone` is the Voice data set's `tone`, saved like any game data edit (backup + audit + undo).
 */
export function registerStyleRoutes(app: FastifyInstance, db: Db, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean, gameData: GameDataStore) {
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');
  const settings = (): StyleSettings => ({ ...getStyleSettings(db), defaultTone: gameData.assets.voice.tone });

  app.get('/api/admin/style-flags', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: StyleFlagsResponse = { stats: styleFlagStats(db) };
    return noStore(reply).send(body);
  });

  app.get('/api/admin/style-settings', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: StyleSettingsResponse = { settings: settings() };
    return noStore(reply).send(body);
  });

  app.put('/api/admin/style-settings', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const parsed = StyleSettingsRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? '(root)')] ??= issue.message;
      return sendError(reply, 400, { code: 'invalid_input', message: Object.values(fields)[0] ?? 'ข้อมูลไม่ถูกต้อง', fields });
    }
    const { rewrite, defaultTone } = parsed.data;
    if (defaultTone !== undefined && defaultTone !== gameData.assets.voice.tone) {
      const voice = gameData.get('Voice')?.value as Record<string, unknown>;
      const saved = gameData.save('Voice', { ...voice, tone: defaultTone });
      if (!saved.ok) return sendError(reply, 409, { code: 'not_allowed', message: 'บันทึกโทนเริ่มต้นไม่ได้: ชุดข้อมูล Voice ไม่ผ่าน schema' });
    }
    if (rewrite !== undefined) setStyleSettings(db, { rewrite });
    const body: StyleSettingsResponse = { settings: settings() };
    return noStore(reply).send(body);
  });
}
