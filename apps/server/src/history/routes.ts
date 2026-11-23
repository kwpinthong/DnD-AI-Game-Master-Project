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
import type { GameAssets } from '../assets/load.ts';
import { revealFor } from '../finale/reveal.ts';
import { closureOf } from '../admin/games.ts';

/**
 * GET /api/game/log (GEN-037 C3): the caller's game as a read-only summary + log, before, during or after
 * play. It only reads: it never creates the engine state (`ensurePhaseState` would) or touches the room.
 */
export function registerHistoryRoutes(app: FastifyInstance, db: Db, now: Clock, assets: GameAssets) {
  app.get('/api/game/log', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });

    const row = db.select().from(game).where(eq(game.id, me.gameId)).get();
    if (!row) return sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
    // ISK-001: a game closed before it was played has no end page.
    const closure = closureOf(db, me.gameId);
    if (closure && !closure.hasSummary) return sendError(reply, 404, { code: 'not_started', message: 'เกมนี้ถูกปิดก่อนเริ่มเล่น จึงไม่มีหน้าสรุป' });
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
        endReason: closure ? 'closed' : ended,
        at: state ? { day: state.day, phase: state.phase, turn: state.turn === 2 ? 2 : 1 } : null,
        startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
        closedEarly: closure !== null,
        closeReason: closure?.reason ?? null,
      },
      you: { memberId: me.id, role: me.role },
      members: activeMembers(db, me.gameId).map((m) => ({ name: m.name, role: m.role })),
      timeline: timelineFor(db, me),
      entries: entriesFor(db, me.gameId, me.id, 0).map((entry) => entryViewOf(db, entry, me, assets)),
      // GEN-059 spoiler rule: the secrets only once the game ended.
      reveal: ended ? revealFor(db, assets, me.gameId) : null,
    };
    return reply.send(body);
  });
}
