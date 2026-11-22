import { defaultScenario } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { learnName, moveCharacter, setNpcAffinity } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, CREATE_CODE, LIN, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

interface Request {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * Every HTTP route, keyed `METHOD /url` exactly as Fastify registers it, with the request a player sends.
 * The C6 test fails when the server has a route that is missing here, so a new route gets scanned too.
 * Socket events (GEN-056) go through the same `forbiddenKeysIn` before they are emitted.
 */
function playerRequests(t: Table, me: Seat): Record<string, Request> {
  return {
    'GET /health': { method: 'GET', path: '/health' },
    'GET /api/me': { method: 'GET', path: '/api/me' },
    'GET /api/game': { method: 'GET', path: '/api/game' },
    'GET /api/game/character': { method: 'GET', path: '/api/game/character' },
    'GET /api/game/timeline': { method: 'GET', path: '/api/game/timeline' },
    'GET /api/game/surroundings': { method: 'GET', path: '/api/game/surroundings' },
    // GEN-056: the play room's WebSocket (a plain GET is 404, no body). Its events are scanned in room.test.ts.
    'GET /api/game/room': { method: 'GET', path: '/api/game/room' },
    'GET /api/game/scenario': { method: 'GET', path: '/api/game/scenario' },
    'PUT /api/game/scenario': { method: 'PUT', path: '/api/game/scenario', body: defaultScenario() },
    'POST /api/game/scenario/reset': { method: 'POST', path: '/api/game/scenario/reset' },
    'PATCH /api/game': { method: 'PATCH', path: '/api/game', body: { gameName: 'ชื่อใหม่' } },
    'POST /api/game/invite-code': { method: 'POST', path: '/api/game/invite-code' },
    'DELETE /api/game/members/:memberId': { method: 'DELETE', path: `/api/game/members/${t.c.memberId}` },
    'POST /api/game/start': { method: 'POST', path: '/api/game/start' },
    'POST /api/game/character': { method: 'POST', path: '/api/game/character', body: LIN },
    'PUT /api/game/character': { method: 'PUT', path: '/api/game/character', body: LIN },
    // GEN-048 loot step (after the character exists). The ids are not in the offer: the 400 is scanned too.
    'POST /api/game/character/loot': { method: 'POST', path: '/api/game/character/loot' },
    'GET /api/game/character/loot': { method: 'GET', path: '/api/game/character/loot' },
    'POST /api/game/character/loot/choose': {
      method: 'POST',
      path: '/api/game/character/loot/choose',
      body: { skillIds: ['not-offered'], itemIds: ['not-offered'] },
    },
    'POST /api/join': { method: 'POST', path: '/api/join', body: { inviteCode: t.inviteCode, name: playerNameOf(t, me), pin: '1111' } },
    'POST /api/games': {
      method: 'POST',
      path: '/api/games',
      body: { createCode: CREATE_CODE, gameName: 'เกมใหม่', mode: 'online', humanGm: false, name: 'คนใหม่', pin: '1234' },
    },
    // Last: it ends the session.
    'POST /api/logout': { method: 'POST', path: '/api/logout' },
  };
}

/** The join name the fixture gave each seat (A is "นก" in both table kinds). */
function playerNameOf(t: Table, me: Seat): string {
  return me === t.a ? 'นก' : me === t.b ? 'บี' : 'ซี';
}

describe('C6: no player-facing payload carries karma (GEN-050)', { timeout: 120_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  /** Gives the table every hidden value a leak could carry: karma, reputation, affinity, known names. */
  function seedSecrets(t: Table) {
    const merchant = defaultScenario().npcs.find((n) => n.id === 'merchant')!;
    for (const [i, seat] of [t.a, t.b, t.c].entries()) {
      server!.db.prepare('update character set karma = ?, reputation = ? where member_id = ?').run(-30 - i, 20 + i, seat.memberId);
      moveCharacter(server!.orm, seat.memberId, merchant.locationId, CLOCK);
      setNpcAffinity(server!.orm, seat.memberId, merchant, 12, CLOCK);
    }
    learnName(server!.orm, t.a.memberId, t.b.memberId, 'introduced', CLOCK);
  }

  async function scanAsPlayers(t: Table) {
    const leaks: string[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const requests = playerRequests(t, seat);
      // CORS preflight (`OPTIONS *`) answers with headers only, no payload.
      const routes = server!.routes.filter((r) => !r.startsWith('OPTIONS '));
      expect(Object.keys(requests).sort(), 'every route must be in the scan list').toEqual([...routes].sort());
      for (const [route, request] of Object.entries(requests)) {
        const res = await t.call(request.method, request.path, { token: seat.token, ...(request.body !== undefined ? { body: request.body } : {}) });
        for (const path of forbiddenKeysIn(res.body)) leaks.push(`${route} (${res.status}) as ${seat.name}: ${path}`);
        if (JSON.stringify(res.body ?? null).includes('"karma"')) leaks.push(`${route} raw "karma" as ${seat.name}`);
      }
    }
    return leaks;
  }

  it('C6: every route, called by every player of a game with a Human GM, has no karma / reputation / affinity', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, true);
    seedSecrets(t);

    // The scanner is not blind: the GM view does carry karma.
    const gm = await t.call('GET', '/api/game/surroundings', { token: t.gm!.token });
    expect(forbiddenKeysIn(gm.body)).toContain('characters.0.karma');

    expect(await scanAsPlayers(t)).toEqual([]);
  });

  it('C6: the same holds in a game without a Human GM (A is the owner)', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    seedSecrets(t);
    expect(await scanAsPlayers(t)).toEqual([]);
  });

  it('C6: forbiddenKeysIn finds nested keys and keys inside arrays', () => {
    expect(forbiddenKeysIn({ a: [{ b: { karma: 1 } }], reputationScore: 2, ok: 'karma' })).toEqual(['a.0.b.karma', 'reputationScore']);
    expect(forbiddenKeysIn({ socialTitle: 'คนแปลกหน้า', people: [{ name: null }] })).toEqual([]);
  });
});
