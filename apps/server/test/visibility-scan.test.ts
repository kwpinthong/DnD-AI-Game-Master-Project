import { defaultScenario } from '@isekai/protocol';
import { SeededRng } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '../src/server.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
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
    'GET /api/game/travel': { method: 'GET', path: '/api/game/travel' },
    // GEN-037: the read-only summary + log (timeline + every entry this player got).
    'GET /api/game/log': { method: 'GET', path: '/api/game/log' },
    // GEN-065: the player's own start scenario and crossing narration.
    'GET /api/game/origin': { method: 'GET', path: '/api/game/origin' },
    // GEN-056: the play room's WebSocket (a plain GET is 404, no body). Its events are scanned in room.test.ts.
    'GET /api/game/room': { method: 'GET', path: '/api/game/room' },
    'GET /api/game/scenario': { method: 'GET', path: '/api/game/scenario' },
    'PUT /api/game/scenario': { method: 'PUT', path: '/api/game/scenario', body: defaultScenario() },
    'POST /api/game/scenario/reset': { method: 'POST', path: '/api/game/scenario/reset' },
    'PATCH /api/game': { method: 'PATCH', path: '/api/game', body: { gameName: 'ชื่อใหม่' } },
    'POST /api/game/invite-code': { method: 'POST', path: '/api/game/invite-code' },
    // No confirmName: the owner gets 400 and nobody's game is deleted by the scan.
    'DELETE /api/game': { method: 'DELETE', path: '/api/game' },
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
    // GEN-149: chat with the NPC at the market (outside the turn) and the quota of the period.
    'GET /api/game/npc-chat': { method: 'GET', path: '/api/game/npc-chat' },
    'POST /api/game/npc-chat': { method: 'POST', path: '/api/game/npc-chat', body: { npc: merchantRef ?? 'none', text: 'สวัสดี วันนี้ขายอะไร' } },
    // GEN-061: the server owner's AI usage dashboard; a player's session is 403 (checked below).
    'POST /api/admin/session': { method: 'POST', path: '/api/admin/session', body: { code: 'เดาเอา' } },
    'GET /api/admin/ai-usage': { method: 'GET', path: '/api/admin/ai-usage' },
    'GET /api/admin/ai-usage/:gameId': { method: 'GET', path: '/api/admin/ai-usage/any-game' },
    'POST /api/admin/logout': { method: 'POST', path: '/api/admin/logout' },
    // GEN-147: the game data editor; a player's session is 403 (checked below).
    'GET /api/admin/game-data': { method: 'GET', path: '/api/admin/game-data' },
    'GET /api/admin/game-data/:name': { method: 'GET', path: '/api/admin/game-data/NPC' },
    'PUT /api/admin/game-data/:name': { method: 'PUT', path: '/api/admin/game-data/NPC', body: { value: [] } },
    'POST /api/admin/game-data/:name/undo': { method: 'POST', path: '/api/admin/game-data/NPC/undo' },
    'GET /api/admin/game-data/:name/asset-file': { method: 'GET', path: '/api/admin/game-data/NPC/asset-file' },
    'GET /api/admin/game-data-audit': { method: 'GET', path: '/api/admin/game-data-audit' },
    'GET /api/admin/game-data-export': { method: 'GET', path: '/api/admin/game-data-export' },
    // GEN-168: the 👎 review; a player's session is 403 (checked below).
    'GET /api/admin/downvotes': { method: 'GET', path: '/api/admin/downvotes' },
    'POST /api/admin/corrections': { method: 'POST', path: '/api/admin/corrections', body: { gameId: 'g', seq: 1, edited: 'x' } },
    'GET /api/admin/corrections-export': { method: 'GET', path: '/api/admin/corrections-export' },
    // GEN-169: the style checker (server owner); a player's session is 403.
    'GET /api/admin/style-flags': { method: 'GET', path: '/api/admin/style-flags' },
    'GET /api/admin/style-settings': { method: 'GET', path: '/api/admin/style-settings' },
    'PUT /api/admin/style-settings': { method: 'PUT', path: '/api/admin/style-settings', body: { rewrite: true } },
    // GEN-167: the style eval rounds (server owner); a player's session is 403.
    'GET /api/admin/style-eval': { method: 'GET', path: '/api/admin/style-eval' },
    'PUT /api/admin/style-eval/:runId/marks/:sceneId': { method: 'PUT', path: '/api/admin/style-eval/1/marks/greeting', body: { mark: 'better' } },
    // GEN-151: the NPC example library; a player's session is 403 (checked below).
    'GET /api/admin/npc-library': { method: 'GET', path: '/api/admin/npc-library' },
    'POST /api/admin/npc-library': { method: 'POST', path: '/api/admin/npc-library', body: { from: 'correction', correctionId: 1 } },
    'DELETE /api/admin/npc-library/:id': { method: 'DELETE', path: '/api/admin/npc-library/1' },
    // GEN-178: the style review round; a player's session is 403 (checked below).
    'GET /api/admin/style-review': { method: 'GET', path: '/api/admin/style-review' },
    'POST /api/admin/style-review/run': { method: 'POST', path: '/api/admin/style-review/run' },
    'POST /api/admin/style-review/proposals/:id/approve': { method: 'POST', path: '/api/admin/style-review/proposals/1/approve', body: {} },
    'POST /api/admin/style-review/proposals/:id/reject': { method: 'POST', path: '/api/admin/style-review/proposals/1/reject' },
    'POST /api/admin/style-review/voice/:version/restore': { method: 'POST', path: '/api/admin/style-review/voice/1/restore' },
    // GEN-055: the player's own skills, held items and library discoveries (no condition or progress).
    'GET /api/game/inventory': { method: 'GET', path: '/api/game/inventory' },
    // GEN-058: the Human GM console. Players get 403 (scanned for karma like every other answer).
    'GET /api/game/gm/console': { method: 'GET', path: '/api/game/gm/console' },
    'POST /api/game/gm/turn/edit': { method: 'POST', path: '/api/game/gm/turn/edit', body: { reason: 'ทดสอบ', narrations: [{ index: 0, text: 'x' }] } },
    'POST /api/game/gm/turn/approve': { method: 'POST', path: '/api/game/gm/turn/approve' },
    'POST /api/game/gm/adjust': { method: 'POST', path: '/api/game/gm/adjust', body: { field: 'karma', memberId: me.memberId, value: 100, reason: 'ทดสอบ' } },
    'POST /api/game/gm/events': { method: 'POST', path: '/api/game/gm/events', body: { day: 6, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด', reason: 'ทดสอบ' } },
    'GET /api/game/gm/log': { method: 'GET', path: '/api/game/gm/log' },
    // GEN-126: vote counts per AI message, Human GM only.
    'GET /api/game/gm/votes': { method: 'GET', path: '/api/game/gm/votes' },
    // GEN-078: rating + 👍 after the end (the game here is still playing: the 409 is scanned).
    'GET /api/game/rating': { method: 'GET', path: '/api/game/rating' },
    'PUT /api/game/rating': { method: 'PUT', path: '/api/game/rating', body: { score: 9, comment: 'สนุก' } },
    'PUT /api/game/entries/:seq/vote': { method: 'PUT', path: '/api/game/entries/1/vote', body: { vote: 'up' } },
    'PUT /api/game/rating/votes/:sourceRef': { method: 'PUT', path: '/api/game/rating/votes/1-EOSORIA-1-1', body: { vote: 'up' } },
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
const ADMIN_DATA_ROUTES = [
  'GET /api/admin/ai-usage',
  'GET /api/admin/ai-usage/:gameId',
  'GET /api/admin/game-data',
  'GET /api/admin/game-data/:name',
  'PUT /api/admin/game-data/:name',
  'POST /api/admin/game-data/:name/undo',
  'GET /api/admin/game-data/:name/asset-file',
  'GET /api/admin/game-data-audit',
  'GET /api/admin/game-data-export',
  'GET /api/admin/downvotes',
  'POST /api/admin/corrections',
  'GET /api/admin/corrections-export',
  'GET /api/admin/style-flags',
  'GET /api/admin/style-settings',
  'PUT /api/admin/style-settings',
  'GET /api/admin/npc-library',
  'POST /api/admin/npc-library',
  'DELETE /api/admin/npc-library/:id',
  'GET /api/admin/style-review',
  'POST /api/admin/style-review/run',
  'POST /api/admin/style-review/proposals/:id/approve',
  'POST /api/admin/style-review/proposals/:id/reject',
  'POST /api/admin/style-review/voice/:version/restore',
];

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
        // Q-195: who sent this turn is the GM's; a player's room frames carry only their own `submitted`.
        for (const [n, m] of x.messages.entries()) {
          if (m.type !== 'room') continue;
          for (const member of m.members) {
            if (member.memberId !== seats[i]!.memberId && 'submitted' in member) leaks.push(`socket frame ${n} as ${seats[i]!.name}: submitted of ${member.memberId}`);
          }
        }
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
    // GEN-065: with start scenarios rolled, so GET /api/game/origin answers with a real one.
    server = await startTestServer(dataDir, { rng: new SeededRng(65) });
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
    server = await startTestServer(dataDir, { rng: new SeededRng(65) });
    const t = await startedTable(server, false);
    seedSecrets(t);
    expect(await scanAsPlayers(t)).toEqual([]);
  });

  it('Q-219: a player standing with a grade S NPC they have not met gets its Public_Alias, never its real name, on any route', async () => {
    server = await startTestServer(dataDir, { rng: null });
    const t = await startedTable(server, false);
    seedSecrets(t);
    const sNpcs = defaultScenario().npcs.filter((n) => n.rank === 'S');
    expect(sNpcs.map((n) => n.name).sort()).toEqual(['น็อกทิส', 'ออเรเลีย', 'แอสทรา'].sort());
    // GEN-175: the chips follow NPC_Schedule; Astra's row keeps her at the Astral Rift at every period.
    for (const [i, npc] of sNpcs.entries()) moveCharacter(server.orm, [t.a, t.b, t.c][i]!.memberId, npc.id === 'horizon-watcher' ? 'astral-rift' : npc.locationId, CLOCK);

    const leaks: string[] = [];
    for (const [i, seat] of [t.a, t.b, t.c].entries()) {
      const around = await t.call('GET', '/api/game/surroundings', { token: seat.token });
      expect(JSON.stringify(around.body), seat.name).toContain(sNpcs[i]!.alias);
      for (const [route, request] of Object.entries(playerRequests(t, seat))) {
        if (route === 'POST /api/logout') continue;
        const res = await t.call(request.method, request.path, { token: seat.token, ...(request.body !== undefined ? { body: request.body } : {}) });
        const text = JSON.stringify(res.body ?? null);
        for (const npc of sNpcs) if (text.includes(npc.name)) leaks.push(`${route} as ${seat.name}: ${npc.name}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('GEN-059 spoiler rule: before the end no secret reaches a player; after it only the summary reveals them', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    seedSecrets(t);
    const secretFields = ['reveal', 'characterName', 'secretActions', 'spawn', 'karmaTier'];
    const hasSecretField = (body: unknown) => {
      const keys: string[] = [];
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v !== null && typeof v === 'object') for (const [k, c] of Object.entries(v)) (keys.push(k), walk(c));
      };
      walk(body);
      return secretFields.filter((f) => keys.includes(f) && !(f === 'reveal' && (body as { reveal?: unknown }).reveal === null));
    };

    // Before the end: every route of every player carries none of the reveal's fields (the log's reveal is null).
    for (const seat of [t.a, t.b, t.c]) {
      for (const [route, request] of Object.entries(playerRequests(t, seat))) {
        if (route === 'POST /api/logout') continue;
        const res = await t.call(request.method, request.path, { token: seat.token, ...(request.body !== undefined ? { body: request.body } : {}) });
        expect(hasSecretField(res.body), `${route} as ${seat.name}`).toEqual([]);
      }
      const log = await t.call('GET', '/api/game/log', { token: seat.token });
      expect((log.body as { reveal: unknown }).reveal).toBeNull();
    }

    // The game ends (as the engine ends it); the room tells the ending to everyone in it.
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    const clients: RoomClient[] = [];
    try {
      for (const seat of [t.a, t.b, t.c]) {
        const c = await openRoom(server, { token: seat.token });
        clients.push(c);
        await c.waitFor(isReady);
      }
      const state = ensurePhaseState(server.orm, gameId, CLOCK);
      savePhaseState(server.orm, gameId, { ...state, day: 12, phase: 'NOCTHERION', turn: 2 }, CLOCK);
      for (const [i, c] of clients.entries()) c.action(['มองฟ้า', 'สวดมนต์', 'เขียนจดหมาย'][i]!, 'public');
      for (const c of clients) await c.waitFor((m) => m.type === 'room' && m.status === 'finale');
      for (const c of clients) await c.waitFor((m) => m.type === 'entry' && m.entry.kind === 'narration' && m.entry.day === 12 && /วันพิพากษา/.test(m.entry.text));
      // The ending over the socket carries no karma key either.
      for (const c of clients) for (const m of c.messages) expect(forbiddenKeysIn(m)).toEqual([]);
    } finally {
      await Promise.all(clients.map((x) => x.close()));
    }

    // After the end: the summary may carry karma, but only inside `reveal`; every other route stays clean.
    for (const seat of [t.a, t.b, t.c]) {
      const log = await t.call('GET', '/api/game/log', { token: seat.token });
      const leaks = forbiddenKeysIn(log.body);
      expect(leaks.length).toBeGreaterThan(0);
      expect(leaks.filter((p) => !p.startsWith('reveal.'))).toEqual([]);
      for (const [route, request] of Object.entries(playerRequests(t, seat))) {
        if (route === 'GET /api/game/log' || route === 'POST /api/logout') continue;
        const res = await t.call(request.method, request.path, { token: seat.token, ...(request.body !== undefined ? { body: request.body } : {}) });
        expect(forbiddenKeysIn(res.body), `${route} as ${seat.name} after the end`).toEqual([]);
      }
    }
  });

  it('C6: forbiddenKeysIn finds nested keys and keys inside arrays', () => {
    expect(forbiddenKeysIn({ a: [{ b: { karma: 1 } }], reputationScore: 2, ok: 'karma' })).toEqual(['a.0.b.karma', 'reputationScore']);
    expect(forbiddenKeysIn({ bonds: [{ relationship: 12 }] })).toEqual(['bonds.0.relationship']);
    expect(forbiddenKeysIn({ socialTitle: 'คนแปลกหน้า', people: [{ name: null }] })).toEqual([]);
  });
});
