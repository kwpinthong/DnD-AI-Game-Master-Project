import { AdminCorrectionRequest, type AdminCorrectionResponse, type AdminCorrectionsExportResponse, type AdminDownvotesResponse } from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../auth/join.ts';
import { sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { addNpcExample } from './npc-library.ts';
import { correctionsJsonl, downvotedEntries, saveCorrection, voteSnapshotsJsonl } from './vote-review.ts';

/** GEN-168: the 👎 review of the server owner; every route needs the admin token (`refuse` answers 403). */
export function registerVoteReviewRoutes(app: FastifyInstance, db: Db, refuse: (request: FastifyRequest, reply: FastifyReply) => boolean, now: Clock, log: (line: string) => void) {
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

  app.get('/api/admin/downvotes', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: AdminDownvotesResponse = { entries: downvotedEntries(db) };
    return noStore(reply).send(body);
  });

  app.post('/api/admin/corrections', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const parsed = AdminCorrectionRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? 'edited')] ??= issue.message;
      return sendError(reply, 400, { code: 'invalid_input', message: Object.values(fields)[0] ?? 'ข้อมูลไม่ถูกต้อง', fields });
    }
    const correction = saveCorrection(db, { ...parsed.data, edited: parsed.data.edited.normalize('NFC') }, now());
    if (!correction) return sendError(reply, 404, { code: 'response_not_found', message: 'ไม่พบข้อความของ AI GM นี้' });
    // GEN-151 / Q-337: a pair sent to the library enters it at once (a message with no NPC waits there for one).
    if (correction.libraryCandidate) addNpcExample(db, { from: 'correction', correctionId: correction.id }, now());
    // The audit line: ids only, never the text.
    log(`[admin] correction ${correction.id} saved for game ${correction.gameId} entry ${correction.seq}${correction.libraryCandidate ? ' (library candidate)' : ''}`);
    const body: AdminCorrectionResponse = { correction };
    return noStore(reply).send(body);
  });

  app.get('/api/admin/corrections-export', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: AdminCorrectionsExportResponse = { exportedAt: new Date(now()).toISOString(), ...correctionsJsonl(db) };
    return noStore(reply).send(body);
  });

  // GEN-189: the 👍/👎 kept from deleted games, the same envelope as the pairs' export.
  app.get('/api/admin/vote-snapshots-export', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: AdminCorrectionsExportResponse = { exportedAt: new Date(now()).toISOString(), ...voteSnapshotsJsonl(db) };
    return noStore(reply).send(body);
  });
}
