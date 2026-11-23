import { NpcExampleAddRequest, type NpcLibraryResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../auth/join.ts';
import { sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { addNpcExample, deleteNpcExample, npcLibrary } from './npc-library.ts';

/** GEN-151: the NPC example library of the server owner; every route needs the admin token (`refuse` answers 403). */
export function registerNpcLibraryRoutes(app: FastifyInstance, db: Db, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean, now: Clock) {
  const send = (reply: FastifyReply) => {
    const body: NpcLibraryResponse = npcLibrary(db);
    return reply.header('cache-control', 'no-store').send(body);
  };
  const notFound = (reply: FastifyReply) => sendError(reply, 404, { code: 'response_not_found', message: 'ไม่พบข้อความหรือ NPC นี้' });

  app.get('/api/admin/npc-library', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    return send(reply);
  });

  app.post('/api/admin/npc-library', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const parsed = NpcExampleAddRequest.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: {} });
    if (!addNpcExample(db, parsed.data, now())) return notFound(reply);
    return send(reply);
  });

  app.delete<{ Params: { id: string } }>('/api/admin/npc-library/:id', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    if (!deleteNpcExample(db, Number(request.params.id))) return notFound(reply);
    return send(reply);
  });
}
