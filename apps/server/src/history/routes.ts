import type { GameLogResponse } from '@isekai/protocol';
import { restorePhaseState } from '@isekai/rules';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { game, gamePhase } from '../db/schema.ts';
import { activeMembers } from '../game/service.ts';
import { entryViewOf } from '../room/entry-view.ts';
import { entriesFor } from '../room/store.ts';
import { timelineFor } from '../timeline/routes.ts';

/**
 * GET /api/game/log (GEN-037 C3): the caller's game as a read-only summary + log, before, during or after
 * play. It only reads: it never creates the engine state (`ensurePhaseState` would) or touches the room.
 */
export function registerHistoryRoutes(app: FastifyInstance, db: Db, now: Clock) {
  app.get('/api/game/log', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });

    const row = db.select().from(game).where(eq(game.id, me.gameId)).get();
    if (!row) return sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
    const stored = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, me.gameId)).get();
    const state = stored ? restorePhaseState(JSON.parse(stored.state)) : null;
    const ended = state?.status === 'finale' || state?.status === 'game_over' ? state.status : null;

    const body: GameLogResponse = {
      game: {
        id: row.id,
        name: row.name,
        mode: row.mode,
        humanGm: row.humanGm,
        status: row.startedAt === null ? 'lobby' : ended ? 'ended' : 'playing',
        endReason: ended,
        at: state ? { day: state.day, phase: state.phase, turn: state.turn === 2 ? 2 : 1 } : null,
        startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
      },
      you: { memberId: me.id, role: me.role },
      members: activeMembers(db, me.gameId).map((m) => ({ name: m.name, role: m.role })),
      timeline: timelineFor(db, me),
      entries: entriesFor(db, me.gameId, me.id, 0).map((entry) => entryViewOf(db, entry, me)),
    };
    return reply.send(body);
  });
}
