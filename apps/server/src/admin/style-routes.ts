import { StyleSettingsRequest, type StyleFlagsResponse, type StyleSettingsResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { getStyleSettings, setStyleSettings, styleFlagStats } from '../gm/style-check.ts';

/** GEN-169: the style checker's flag counts and settings (server owner); every route needs the admin token. */
export function registerStyleRoutes(app: FastifyInstance, db: Db, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean) {
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

  app.get('/api/admin/style-flags', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: StyleFlagsResponse = { stats: styleFlagStats(db) };
    return noStore(reply).send(body);
  });

  app.get('/api/admin/style-settings', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: StyleSettingsResponse = { settings: getStyleSettings(db) };
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
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const body: StyleSettingsResponse = { settings: setStyleSettings(db, patch) };
    return noStore(reply).send(body);
  });
}
