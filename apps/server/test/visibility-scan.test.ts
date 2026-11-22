import { defaultScenario } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { learnName, leaveHiddenEvidence, moveCharacter, setNpcAffinity, setPlayerBond } from '../src/visibility/store.ts';
import { approveHeldTurn } from './gm-console-client.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
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
function playerRequests(t: Table, me: Seat, merchantRef?: string): Record<string, Request> {
  return {
    'GET /health': { method: 'GET', path: '/health' },
    'GET /api/me': { method: 'GET', path: '/api/me' },
    'GET /api/game': { method: 'GET', path: '/api/game' },
    'GET /api/game/character': { method: 'GET', path: '/api/game/character' },
    'GET /api/game/timeline': { method: 'GET', path: '/api/game/timeline' },
    'GET /api/game/surroundings': { method: 'GET', path: '/api/game/surroundings' },
    // GEN-037: the read-only summary + log (timeline + every entry this player got).
    'GET /api/game/log': { method: 'GET', path: '/api/game/log' },
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
    // GEN-054: companions (save one NPC at the market, list, release a ref that is not one: the 404 is scanned too).
    'GET /api/game/companions': { method: 'GET', path: '/api/game/companions' },
    'POST /api/game/companions': { method: 'POST', path: '/api/game/companions', body: { ref: merchantRef ?? 'none' } },
    'DELETE /api/game/companions/:ref': { method: 'DELETE', path: '/api/game/companions/not-a-companion' },
    // GEN-061: the server owner's AI usage dashboard; a player's session is 403 (checked below).
    'POST /api/admin/session': { method: 'POST', path: '/api/admin/session', body: { code: 'เดาเอา' } },
    'GET /api/admin/ai-usage': { method: 'GET', path: '/api/admin/ai-usage' },
    'GET /api/admin/ai-usage/:gameId': { method: 'GET', path: '/api/admin/ai-usage/any-game' },
    'POST /api/admin/logout': { method: 'POST', path: '/api/admin/logout' },
    // GEN-055: the player's own skills, held items and library discoveries (no condition or progress).
    'GET /api/game/inventory': { method: 'GET', path: '/api/game/inventory' },
    // GEN-058: the Human GM console. Players get 403 (scanned for karma like every other answer).
    'GET /api/game/gm/console': { method: 'GET', path: '/api/game/gm/console' },
    'POST /api/game/gm/turn/edit': { method: 'POST', path: '/api/game/gm/turn/edit', body: { reason: 'ทดสอบ', narrations: [{ index: 0, text: 'x' }] } },
    'POST /api/game/gm/turn/approve': { method: 'POST', path: '/api/game/gm/turn/approve' },
    'POST /api/game/gm/adjust': { method: 'POST', path: '/api/game/gm/adjust', body: { field: 'karma', memberId: me.memberId, value: 100, reason: 'ทดสอบ' } },
    'POST /api/game/gm/events': { method: 'POST', path: '/api/game/gm/events', body: { day: 6, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด', reason: 'ทดสอบ' } },
    'GET /api/game/gm/log': { method: 'GET', path: '/api/game/gm/log' },
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

/** GEN-061 (Q-058): only the server owner's admin token opens these; every player gets 403. */
const ADMIN_DATA_ROUTES = ['GET /api/admin/ai-usage', 'GET /api/admin/ai-usage/:gameId'];

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
    // GEN-067: an alliance with a relationship number, and a Hidden Evidence Tag.
    setPlayerBond(server!.orm, t.a.memberId, t.b.memberId, { alliance: true, relationship: 12 }, CLOCK);
    setPlayerBond(server!.orm, t.b.memberId, t.c.memberId, { alliance: false, relationship: -7 }, CLOCK);
    const gameId = (server!.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    leaveHiddenEvidence(server!.orm, { gameId, locationId: merchant.locationId, day: 1, actorMemberId: t.c.memberId }, CLOCK);
  }

  /** Every frame each player's play-room socket gets while they act, Whisper and read the room (GEN-056 / GEN-067). */
  async function scanSocketsAsPlayers(t: Table) {
    const leaks: string[] = [];
    const seats = [t.a, t.b, t.c];
    const clients: RoomClient[] = [];
    try {
      for (const seat of seats) {
        const c = await openRoom(server!, { token: seat.token });
        clients.push(c);
        await c.waitFor(isReady);
      }
      const [a, b, c] = clients as [RoomClient, RoomClient, RoomClient];
      const ally = a.lastRoom()!.you.allies[0]!;
      a.whisper(ally.ref, 'กระซิบทดสอบ');
      await a.waitFor((m) => m.type === 'whisper_accepted');
      await b.waitFor((m) => m.type === 'entry' && m.entry.kind === 'whisper');
      a.action('เดินดูตลาด', 'public');
      b.action('แอบหยิบของ', 'secret');
      c.action('นั่งพัก', 'public');
      // GEN-058 (Q-030): a game with a Human GM publishes the turn once the GM approves it.
      if (t.gm) await approveHeldTurn(t.call, t.gm.token);
      for (const x of clients) await x.waitFor((m) => m.type === 'room' && m.phase === 'EOSORIA' && m.turn === 2);
      for (const [i, x] of clients.entries()) {
        for (const [n, m] of x.messages.entries()) for (const path of forbiddenKeysIn(m)) leaks.push(`socket frame ${n} as ${seats[i]!.name}: ${path}`);
        for (const frame of x.raw) if (frame.includes('"karma"') || frame.includes('"relationship"')) leaks.push(`socket raw as ${seats[i]!.name}: ${frame}`);
      }
    } finally {
      await Promise.all(clients.map((x) => x.close()));
    }
    return leaks;
  }

  async function scanAsPlayers(t: Table) {
    const leaks: string[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const seen = await t.call('GET', '/api/game/surroundings', { token: seat.token });
      const merchantRef = (seen.body as { npcs?: { ref: string }[] }).npcs?.[0]?.ref;
      expect(merchantRef, 'an NPC to save').toBeTypeOf('string');
      const requests = playerRequests(t, seat, merchantRef);
      // CORS preflight (`OPTIONS *`) answers with headers only, no payload.
      const routes = server!.routes.filter((r) => !r.startsWith('OPTIONS '));
      expect(Object.keys(requests).sort(), 'every route must be in the scan list').toEqual([...routes].sort());
      for (const [route, request] of Object.entries(requests)) {
        const res = await t.call(request.method, request.path, { token: seat.token, ...(request.body !== undefined ? { body: request.body } : {}) });
        for (const path of forbiddenKeysIn(res.body)) leaks.push(`${route} (${res.status}) as ${seat.name}: ${path}`);
        if (ADMIN_DATA_ROUTES.includes(route) && res.status !== 403) leaks.push(`${route} answered ${res.status} (not 403) to ${seat.name}`);
        // GEN-058 (Q-136): the GM console answers players with 403 only.
        if (request.path.startsWith('/api/game/gm/') && res.status !== 403) leaks.push(`${route} answered ${res.status} to ${seat.name}`);
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

  it('C2 (GEN-067): every socket frame a player gets, Whisper included, has no karma / relationship key', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, true);
    seedSecrets(t);
    // The GM's surroundings do carry the numbers (the scanner is not blind).
    const gm = await t.call('GET', '/api/game/surroundings', { token: t.gm!.token });
    expect(forbiddenKeysIn(gm.body)).toEqual(expect.arrayContaining(['characters.0.karma', 'characters.0.playerBonds.0.relationship']));

    expect(await scanSocketsAsPlayers(t)).toEqual([]);
  });

  it('C6: the same holds in a game without a Human GM (A is the owner)', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    seedSecrets(t);
    expect(await scanAsPlayers(t)).toEqual([]);
  });

  it('C6: forbiddenKeysIn finds nested keys and keys inside arrays', () => {
    expect(forbiddenKeysIn({ a: [{ b: { karma: 1 } }], reputationScore: 2, ok: 'karma' })).toEqual(['a.0.b.karma', 'reputationScore']);
    expect(forbiddenKeysIn({ bonds: [{ relationship: 12 }] })).toEqual(['bonds.0.relationship']);
    expect(forbiddenKeysIn({ socialTitle: 'คนแปลกหน้า', people: [{ name: null }] })).toEqual([]);
  });
});
