import type { GameTimelineResponse } from '@isekai/protocol';
import type { FastifyInstance } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import { bearerToken, sendError } from '../auth/routes.ts';
import type { Db } from '../db/client.ts';
import type { MemberRow } from '../game/service.ts';
import { getGameScenario } from '../scenario/store.ts';
import { presenceOf } from '../visibility/store.ts';
import { seesEvent, seesPlace } from '../visibility/views.ts';
import { eventWitnesses, getTimeline } from './store.ts';

/**
 * GET /api/game/timeline (GEN-053). A player sees only events that already began, by public title
 * (C5: nothing of an event that has not happened), and only town-wide ones or those they were at when
 * they began (Q-104, snapshot like `witnessesOf`). The Human GM sees every event with its outcome.
 */
export function registerTimelineRoutes(app: FastifyInstance, db: Db, now: Clock) {
  app.get('/api/game/timeline', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const me = token ? memberRowForToken(db, token, now) : undefined;
    if (!me) return sendError(reply, 401, { code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' });
    return reply.send(timelineFor(db, me));
  });
}

/** The timeline as `me` may see it (also in the game log, GEN-037). */
export function timelineFor(db: Db, me: Pick<MemberRow, 'id' | 'gameId' | 'role'>): GameTimelineResponse {
  const { at, ended, events } = getTimeline(db, me.gameId) ?? { at: null, ended: false, events: [] };
  if (me.role === 'gm') return { view: 'gm', at, ended, events };

  // Q-104: an event at a place is seen by those who were there when it began (kept after they move
  // away; nobody who arrives later). Town-wide events are seen by everyone. Events that began before
  // the snapshot existed fall back to where the player is now (Q-080).
  const placeOf = new Map((getGameScenario(db, me.gameId)?.timeline ?? []).map((e) => [e.id, e.locationId]));
  const witnesses = eventWitnesses(db, me.gameId);
  const here = presenceOf(db, me.id)?.locationId ?? null;
  const sees = (id: string) => {
    const snapshot = witnesses.get(id) ?? null;
    return snapshot === null ? seesPlace(here, placeOf.get(id) ?? null) : seesEvent(me.id, snapshot);
  };
  return {
    view: 'player',
    at,
    ended,
    events: events.flatMap(({ id, day, phase, title, status }) =>
      status === 'pending' || !sees(id) ? [] : [{ id, day, phase, title, status }],
    ),
  };
}
