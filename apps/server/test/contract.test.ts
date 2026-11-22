import { ApiError, CreateGameResponse, defaultScenario, GameLogResponse, JoinResponse, LootResponse, ROOM_PATH, SurroundingsResponse, type RoomServerMessage } from '@isekai/protocol';
import { CONTRACT, CONTRACT_SCHEMAS, type HttpItem, type SocketItem } from '@isekai/protocol/contract';
import { SeededRng } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { moveCharacter, setPlayerBond } from '../src/visibility/store.ts';
import { heldTurn } from './gm-console-client.ts';
import { makeTempDir, seedChosenLoot } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, DARIN, LIN, startedTable, type Call } from './visibility-fixture.ts';

/**
 * GEN-099 C3 + C6: every endpoint / socket event the contract marks `ready` is called on a real server (mock
 * AI) and its payload must pass the contract's schema: 2xx = the response schema (204 = no body), anything
 * else = ApiError. Each ready endpoint must answer 2xx at least once, every ready server event must be seen,
 * and the server's routes must be exactly the ready endpoints (a new route needs a contract row).
 */

const ADMIN_CODE = 'เจ้าของ-สัญญา-2026';
const FOUNTAIN = 'น้ำพุกลางเมือง';
const CHURCH = 'โบสถ์';

const key = (item: Pick<HttpItem, 'method' | 'path'>) => `${item.method} ${item.path}`;
const READY_HTTP = CONTRACT.filter((i): i is HttpItem => i.kind === 'http' && i.status === 'ready');
const PENDING_HTTP = CONTRACT.filter((i): i is HttpItem => i.kind === 'http' && i.status === 'pending');
const READY_SERVER_EVENTS = CONTRACT.filter((i): i is SocketItem => i.kind === 'socket' && i.direction === 'server' && i.status === 'ready');

describe('GEN-099 contract against the real server', { timeout: 120_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: new SeededRng(99) },
    );
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  it('C6: the server has exactly the ready endpoints (+ the room socket), and none of the pending ones', () => {
    const routes = server!.routes.filter((r) => !r.startsWith('OPTIONS '));
    expect([...routes].sort()).toEqual([...READY_HTTP.map(key), `GET ${ROOM_PATH}`].sort());
    for (const item of PENDING_HTTP) expect(routes, `${key(item)} is pending but the server has it: mark it ready`).not.toContain(key(item));
  });

  it('C3: every ready endpoint answers with a payload that passes its schema, 2xx at least once', async () => {
    const problems: string[] = [];
    const ok = new Set<string>();
    const byKey = new Map(READY_HTTP.map((i) => [key(i), i]));

    /** Calls a route as the contract names it (`path` fills its `:params`) and checks the answer. */
    async function hit(call: Call, route: string, options: { path?: string; body?: unknown; token?: string } = {}) {
      const item = byKey.get(route);
      if (!item) throw new Error(`${route} is not a ready contract endpoint`);
      const res = await call(item.method, options.path ?? item.path, {
        ...(options.token ? { token: options.token } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
      });
      if (res.status >= 200 && res.status < 300) {
        if (item.response === null) {
          if (res.status !== 204 || res.body !== undefined) problems.push(`${route}: expected 204 with no body, got ${res.status}`);
        } else {
          const parsed = CONTRACT_SCHEMAS[item.response].safeParse(res.body);
          if (!parsed.success) problems.push(`${route} (${res.status}) → ${item.response}: ${JSON.stringify(parsed.error.issues)}`);
        }
        ok.add(route);
      } else {
        const parsed = ApiError.safeParse(res.body);
        if (!parsed.success) problems.push(`${route} (${res.status}) → ApiError: ${JSON.stringify(res.body)}`);
      }
      return res;
    }

    const call = caller(server!);

    // --- Lobby of a game with a Human GM: every route before the start ---
    await hit(call, 'GET /health');
    const created = await hit(call, 'POST /api/games', {
      body: { createCode: CREATE_CODE, gameName: 'เกมสัญญา', mode: 'online', humanGm: true, name: 'จีเอ็ม', pin: '1234' },
    });
    const lobby = CreateGameResponse.parse(created.body);
    const gm = lobby.token;
    const joinAs = async (name: string) => JoinResponse.parse((await hit(call, 'POST /api/join', { body: { inviteCode: lobby.game.inviteCode, name, pin: '1111' } })).body);
    const p1 = await joinAs('พี');
    const p2 = await joinAs('คิว');
    const kicked = await joinAs('เตะ');
    await hit(call, 'GET /api/me', { token: p1.token });
    await hit(call, 'GET /api/game', { token: gm });
    await hit(call, 'PATCH /api/game', { token: gm, body: { gameName: 'เกมสัญญา 2' } });
    await hit(call, 'GET /api/game/scenario', { token: gm });
    await hit(call, 'PUT /api/game/scenario', { token: gm, body: defaultScenario() });
    await hit(call, 'POST /api/game/scenario/reset', { token: gm });
    await hit(call, 'GET /api/game/character', { token: p1.token });
    await hit(call, 'POST /api/game/character', { token: p1.token, body: LIN });
    await hit(call, 'PUT /api/game/character', { token: p1.token, body: LIN });
    await hit(call, 'GET /api/game/character/loot', { token: p1.token });
    const offer = LootResponse.parse((await hit(call, 'POST /api/game/character/loot', { token: p1.token })).body).loot.offer!;
    await hit(call, 'POST /api/game/character/loot/choose', { token: p1.token, body: { skillIds: [offer.skills[0]!.id], itemIds: [offer.items[0]!.id] } });
    await hit(call, 'POST /api/game/character', { token: p2.token, body: DARIN });
    seedChosenLoot(server!.db, p2.member.id);
    await hit(call, 'DELETE /api/game/members/:memberId', { token: gm, path: `/api/game/members/${kicked.member.id}` });
    await hit(call, 'POST /api/game/invite-code', { token: gm });
    await hit(call, 'POST /api/game/start', { token: gm });
    await hit(call, 'GET /api/game/origin', { token: p1.token });
    await hit(call, 'GET /api/game/origin', { token: gm });

    // --- Playing: a started table with a Human GM (A ลิน, B ดาริน, C เมฆา) ---
    const t = await startedTable(server!, true);
    const tgm = t.gm!.token;
    const merchant = defaultScenario().npcs.find((n) => n.id === 'merchant')!;
    moveCharacter(server!.orm, t.a.memberId, merchant.locationId, CLOCK);
    const seen = SurroundingsResponse.parse((await hit(call, 'GET /api/game/surroundings', { token: t.a.token })).body);
    await hit(call, 'GET /api/game/surroundings', { token: tgm });
    const npcRef = seen.view === 'player' ? seen.npcs[0]?.ref : undefined;
    expect(npcRef, 'an NPC at the merchant place').toBeTypeOf('string');
    await hit(call, 'POST /api/game/companions', { token: t.a.token, body: { ref: npcRef } });
    await hit(call, 'GET /api/game/companions', { token: t.a.token });
    await hit(call, 'DELETE /api/game/companions/:ref', { token: t.a.token, path: `/api/game/companions/${encodeURIComponent(npcRef!)}` });
    await hit(call, 'GET /api/game/timeline', { token: t.a.token });
    await hit(call, 'GET /api/game/timeline', { token: tgm });
    await hit(call, 'GET /api/game/inventory', { token: t.a.token });
    await hit(call, 'GET /api/game/character', { token: t.a.token });
    await hit(call, 'GET /api/game/gm/console', { token: tgm });
    await hit(call, 'GET /api/game/gm/console', { token: t.a.token });
    await hit(call, 'POST /api/game/gm/adjust', { token: tgm, body: { field: 'hp', memberId: t.a.memberId, value: 20, reason: 'ทดสอบสัญญา' } });
    await hit(call, 'POST /api/game/gm/events', { token: tgm, body: { day: 6, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด', reason: 'ทดสอบสัญญา' } });

    // --- The play room: one turn held for the GM, edited and approved ---
    moveCharacter(server!.orm, t.a.memberId, FOUNTAIN, CLOCK);
    setPlayerBond(server!.orm, t.a.memberId, t.b.memberId, { alliance: true, relationship: 12 }, CLOCK);
    setPlayerBond(server!.orm, t.b.memberId, t.a.memberId, { alliance: true, relationship: 12 }, CLOCK);
    const [a, b, c] = await Promise.all([t.a, t.b, t.c].map(async (seat) => {
      const client = await openRoom(server!, { token: seat.token });
      sockets.push(client);
      await client.waitFor(isReady);
      return client;
    })) as [RoomClient, RoomClient, RoomClient];
    const answer = async (client: RoomClient, send: () => void, types: string[]) => {
      const from = client.messages.length;
      send();
      return client.waitFor((m) => types.includes(m.type), from);
    };
    await answer(a, () => a.send({ type: 'move', to: 'ไม่มีที่นี่' }), ['move_accepted', 'move_rejected']);
    await answer(a, () => a.send({ type: 'move', to: CHURCH }), ['move_accepted', 'move_rejected']);
    await answer(a, () => a.whisper('ไม่มีใคร', 'ทดสอบ'), ['whisper_accepted', 'whisper_rejected']);
    const ally = a.lastRoom()!.you.allies[0];
    expect(ally, 'A has B as an ally').toBeDefined();
    await answer(a, () => a.whisper(ally!.ref, 'คืนนี้เจอกัน'), ['whisper_accepted', 'whisper_rejected']);
    await answer(a, () => a.action('', 'public'), ['action_accepted', 'action_rejected']);
    await answer(a, () => a.action('สวดภาวนาที่โบสถ์', 'public'), ['action_accepted', 'action_rejected']);
    await answer(b, () => b.action('แอบหยิบของ', 'secret'), ['action_accepted', 'action_rejected']);
    await answer(c, () => c.action('นั่งพัก', 'public', true), ['action_accepted', 'action_rejected']);
    await heldTurn(call, tgm);
    await hit(call, 'POST /api/game/gm/turn/edit', { token: tgm, body: { reason: 'ปรับถ้อยคำ', narrations: [{ index: 0, text: 'GM เขียนใหม่' }] } });
    await hit(call, 'POST /api/game/gm/turn/approve', { token: tgm });
    for (const x of [a, b, c]) await x.waitFor((m) => m.type === 'room' && m.turn === 2 && m.status === 'collecting');
    await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'narration');
    await hit(call, 'GET /api/game/gm/log', { token: tgm });
    await hit(call, 'GET /api/game/log', { token: t.a.token });
    await hit(call, 'GET /api/game/log', { token: tgm });

    // A bad message: `error`, then the server closes the socket.
    const bad = await openRoom(server!, { token: t.c.token });
    sockets.push(bad);
    await bad.waitFor(isReady);
    bad.send({ type: 'nope' });
    await bad.waitFor((m) => m.type === 'error');

    // --- After the end (GEN-078): the same table, ended; B's Secret action of turn 1 stood and is revealed ---
    const tableGame = (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    savePhaseState(server!.orm, tableGame, { ...ensurePhaseState(server!.orm, tableGame, CLOCK), status: 'finale' }, CLOCK);
    const endedLog = GameLogResponse.parse((await hit(call, 'GET /api/game/log', { token: t.a.token })).body);
    const likedRef = endedLog.reveal?.players.flatMap((p) => p.secretActions)[0]?.sourceRef;
    expect(likedRef, 'a revealed Secret action with its ref').toBeTypeOf('string');
    await hit(call, 'GET /api/game/rating', { token: t.a.token });
    await hit(call, 'PUT /api/game/rating', { token: t.a.token, body: { score: 0 } });
    await hit(call, 'PUT /api/game/rating', { token: t.a.token, body: { score: 9, comment: 'สนุกมาก' } });
    await hit(call, 'PUT /api/game/rating', { token: tgm, body: { score: 8 } });
    await hit(call, 'PUT /api/game/rating/likes/:sourceRef', { token: t.a.token, path: `/api/game/rating/likes/${likedRef}` });
    await hit(call, 'PUT /api/game/rating/likes/:sourceRef', { token: t.a.token, path: '/api/game/rating/likes/none' });
    await hit(call, 'DELETE /api/game/rating/likes/:sourceRef', { token: t.a.token, path: `/api/game/rating/likes/${likedRef}` });
    await hit(call, 'GET /api/game/rating');

    // --- Server owner ---
    const admin = await hit(call, 'POST /api/admin/session', { body: { code: ADMIN_CODE } });
    const adminToken = (admin.body as { token: string }).token;
    await hit(call, 'GET /api/admin/ai-usage', { token: adminToken });
    await hit(call, 'GET /api/admin/ai-usage/:gameId', { token: adminToken, path: `/api/admin/ai-usage/${lobby.game.id}` });
    await hit(call, 'POST /api/admin/logout', { token: adminToken });
    await hit(call, 'POST /api/logout', { token: p1.token });

    // --- Socket frames: each passes the schema the contract names for its `type` ---
    const schemaOf = new Map(READY_SERVER_EVENTS.map((i) => [i.type, i.schema]));
    const seenTypes = new Set<string>();
    for (const client of [a, b, c, bad]) {
      for (const raw of client.raw) {
        const frame = JSON.parse(raw) as RoomServerMessage;
        seenTypes.add(frame.type);
        const name = schemaOf.get(frame.type);
        if (!name) {
          problems.push(`socket ${frame.type}: not a ready event of the contract`);
          continue;
        }
        const parsed = CONTRACT_SCHEMAS[name].safeParse(frame);
        if (!parsed.success) problems.push(`socket ${frame.type} → ${name}: ${JSON.stringify(parsed.error.issues)}`);
      }
    }

    expect(problems).toEqual([]);
    expect([...READY_HTTP.map(key)].filter((r) => !ok.has(r)), 'ready endpoints never answered 2xx').toEqual([]);
    expect([...schemaOf.keys()].filter((type) => !seenTypes.has(type)), 'ready server events never seen').toEqual([]);
  });
});
