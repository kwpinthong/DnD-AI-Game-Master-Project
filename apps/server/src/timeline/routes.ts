import type { GameTimelineResponse } from '@isekai/protocol';
import type { FastifyInstance } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import { getGameScenario } from '../scenario/store.ts';
import { presenceOf } from '../visibility/store.ts';
import { seesPlace } from '../visibility/views.ts';
import { getTimeline } from './store.ts';

/**
 * GET /api/game/timeline (GEN-053). A player sees only events that already began, by public title
 * (C5: nothing of an event that has not happened), and only those at their own place or town-wide
 * (Q-080, GEN-060). The Human GM sees every event with its outcome.
 */
export function registerTimelineRoutes(app: FastifyInstance, db: Db, now: Clock) {
  app.get('/api/game/timeline', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });

    const { at, ended, events } = getTimeline(db, me.gameId) ?? { at: null, ended: false, events: [] };
    // Q-080: a player sees only events at the place they are now (or town-wide ones, no place).
    const placeOf = new Map((getGameScenario(db, me.gameId)?.timeline ?? []).map((e) => [e.id, e.locationId]));
    const here = me.role === 'gm' ? null : (presenceOf(db, me.id)?.locationId ?? null);
    const body: GameTimelineResponse =
      me.role === 'gm'
        ? { view: 'gm', at, ended, events }
        : {
            view: 'player',
            at,
            ended,
            events: events.flatMap(({ id, day, phase, title, status }) =>
              status === 'pending' || !seesPlace(here, placeOf.get(id) ?? null) ? [] : [{ id, day, phase, title, status }],
            ),
          };
    return reply.send(body);
  });
}
