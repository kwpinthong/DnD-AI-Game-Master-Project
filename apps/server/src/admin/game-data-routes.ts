import {
  GameDataSaveRequest,
  type GameDataAuditResponse,
  type GameDataExportResponse,
  type GameDataListResponse,
  type GameDataSetResponse,
  type GameDataSetSummary,
} from '@isekai/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isDataSetName, type DataSetSummary, type GameDataStore, type SaveOutcome, type UndoOutcome } from '../assets/game-data.ts';
import type { Clock } from '../auth/join.ts';
import { sendError } from '../auth/routes.ts';

const NOT_FOUND = { code: 'data_set_not_found', message: 'ไม่พบชุดข้อมูลนี้' } as const;
const iso = (ms: number) => new Date(ms).toISOString();
const summaryView = (s: DataSetSummary): GameDataSetSummary => ({ ...s, updatedAt: iso(s.updatedAt) });

/**
 * GEN-147: the server owner's game data editor. Every route needs the admin token (`refuse` answers 403);
 * a save is checked by the asset loader's schemas, backed up and logged by the store.
 */
export function registerGameDataRoutes(
  app: FastifyInstance,
  store: GameDataStore,
  refuse: (request: FastifyRequest, reply: FastifyReply) => boolean,
  now: Clock,
) {
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

  function sendSet(reply: FastifyReply, name: string, outcome: SaveOutcome | UndoOutcome = { ok: true }) {
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not_found':
          return sendError(reply, 404, NOT_FOUND);
        case 'nothing_to_undo':
          return sendError(reply, 409, { code: 'not_allowed', message: 'ไม่มีการแก้ที่ย้อนได้แล้ว' });
        case 'invalid':
          return sendError(reply, 400, { code: 'invalid_input', message: 'ข้อมูลไม่ตรง schema ยังไม่ได้บันทึก (ค่าเดิมไม่เปลี่ยน)', fields: outcome.fields });
      }
    }
    const set = isDataSetName(name) ? store.get(name) : undefined;
    if (!set) return sendError(reply, 404, NOT_FOUND);
    const body: GameDataSetResponse = { set: summaryView(set.summary), value: set.value };
    return noStore(reply).send(body);
  }

  app.get('/api/admin/game-data', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: GameDataListResponse = { sets: store.list().map(summaryView) };
    return noStore(reply).send(body);
  });

  app.get<{ Params: { name: string } }>('/api/admin/game-data/:name', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    return sendSet(reply, request.params.name);
  });

  app.put<{ Params: { name: string } }>('/api/admin/game-data/:name', { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const { name } = request.params;
    if (!isDataSetName(name)) return sendError(reply, 404, NOT_FOUND);
    const parsed = GameDataSaveRequest.safeParse(request.body ?? {});
    if (!parsed.success || parsed.data.value === undefined) {
      return sendError(reply, 400, { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: { value: 'ส่งข้อมูลทั้งชุดใน value' } });
    }
    return sendSet(reply, name, store.save(name, parsed.data.value));
  });

  app.post<{ Params: { name: string } }>('/api/admin/game-data/:name/undo', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const { name } = request.params;
    if (!isDataSetName(name)) return sendError(reply, 404, NOT_FOUND);
    return sendSet(reply, name, store.undo(name));
  });

  app.get('/api/admin/game-data-audit', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: GameDataAuditResponse = { entries: store.audit().map((e) => ({ ...e, at: iso(e.at) })) };
    return noStore(reply).send(body);
  });

  app.get('/api/admin/game-data-export', async (request, reply) => {
    if (refuse(request, reply)) return reply;
    const body: GameDataExportResponse = { exportedAt: iso(now()), files: store.exportFiles() };
    return noStore(reply).send(body);
  });
}
