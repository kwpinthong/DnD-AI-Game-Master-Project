import { ApiError, CreateGameResponse, defaultScenario, GameLogResponse, JoinResponse, LootResponse, ROOM_PATH, SurroundingsResponse, type RoomServerMessage } from '@isekai/protocol';
import { CONTRACT, CONTRACT_SCHEMAS, type HttpItem, type SocketItem } from '@isekai/protocol/contract';
import { SeededRng } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { providerFor } from '../src/ai/registry.ts';
import { hashPin } from '../src/auth/pin.ts';
import { runStyleEval } from '../src/eval/style-eval.ts';
import { playerKeyOf } from '../src/learning/style.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { ASTRAL_PLANE, moveCharacter, presenceOf, setPlayerBond } from '../src/visibility/store.ts';
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
    await hit(call, 'GET /api/game/travel', { token: t.a.token });
    await hit(call, 'GET /api/game/travel', { token: tgm });
    const npcRef = seen.view === 'player' ? seen.npcs[0]?.ref : undefined;
    expect(npcRef, 'an NPC at the merchant place').toBeTypeOf('string');
    // GEN-121: only a known NPC can be saved.
    for (const n of defaultScenario().npcs.filter((x) => x.locationId === merchant.locationId)) {
      server!.db.prepare('insert into npc_bond (member_id, npc_id, name_revealed, updated_at) values (?, ?, 1, ?)').run(t.a.memberId, n.id, CLOCK);
    }
    await hit(call, 'POST /api/game/companions', { token: t.a.token, body: { ref: npcRef } });
    await hit(call, 'GET /api/game/companions', { token: t.a.token });
    await hit(call, 'DELETE /api/game/companions/:ref', { token: t.a.token, path: `/api/game/companions/${encodeURIComponent(npcRef!)}` });
    await hit(call, 'GET /api/game/timeline', { token: t.a.token });
    await hit(call, 'GET /api/game/timeline', { token: tgm });
    await hit(call, 'GET /api/game/inventory', { token: t.a.token });
    // GEN-149: the chat quota and one message to the NPC here (no turn moves); the Human GM has no chat.
    await hit(call, 'GET /api/game/npc-chat', { token: t.a.token });
    await hit(call, 'POST /api/game/npc-chat', { token: t.a.token, body: { npc: npcRef, text: 'วันนี้ตลาดคึกคักไหม' } });
    await hit(call, 'POST /api/game/npc-chat', { token: tgm, body: { npc: npcRef, text: 'สวัสดี' } });
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
    // GEN-128: the turn's NPC lines wait in the console too; the GM approves them as they are.
    expect((await heldTurn(call, tgm)).dialogue).toBe(true);
    await hit(call, 'POST /api/game/gm/turn/approve', { token: tgm });
    await Promise.race([a, b, c].map((x) => x.waitFor((m) => m.type === 'entry' && m.entry.kind === 'npc')));
    await hit(call, 'GET /api/game/gm/log', { token: tgm });
    await hit(call, 'GET /api/game/gm/votes', { token: tgm });
    await hit(call, 'GET /api/game/gm/votes', { token: t.a.token });
    const playLog = GameLogResponse.parse((await hit(call, 'GET /api/game/log', { token: t.a.token })).body);
    await hit(call, 'GET /api/game/log', { token: tgm });
    // GEN-107: a vote on an AI-written entry, then the refusals (a GM, an unknown id)
    const votable = playLog.entries.find((e) => e.myVote !== undefined);
    expect(votable, 'an AI-written entry with myVote').toBeDefined();
    await hit(call, 'PUT /api/game/entries/:seq/vote', { token: t.a.token, path: `/api/game/entries/${votable!.seq}/vote`, body: { vote: 'up' } });
    await hit(call, 'PUT /api/game/entries/:seq/vote', { token: tgm, path: `/api/game/entries/${votable!.seq}/vote`, body: { vote: 'up' } });
    await hit(call, 'PUT /api/game/entries/:seq/vote', { token: t.a.token, path: '/api/game/entries/99999/vote', body: { vote: 'up' } });

    // GEN-070: an omen from a living player is refused; C, an Astral Spirit in NOCTHERION, sends one to A.
    await answer(a, () => a.send({ type: 'omen', to: presenceOf(server!.orm, t.b.memberId)!.ref, text: 'ระวัง' }), ['omen_accepted', 'omen_rejected']);
    const gameId = (server!.db.prepare('select game_id as id from member where id = ?').get(t.c.memberId) as { id: string }).id;
    const playing = ensurePhaseState(server!.orm, gameId, CLOCK);
    const ghost = { ...playing.players[t.c.memberId]!, hp: 0, condition: 'astral_spirit' as const, mustSubmit: false, diedAt: { day: 1, phase: 'EOSORIA' as const, turn: 1 as const } };
    savePhaseState(server!.orm, gameId, { ...playing, phase: 'NOCTHERION', players: { ...playing.players, [t.c.memberId]: ghost } }, CLOCK);
    moveCharacter(server!.orm, t.c.memberId, ASTRAL_PLANE, CLOCK);
    await answer(c, () => c.send({ type: 'omen', to: presenceOf(server!.orm, t.a.memberId)!.ref, text: 'เงาใต้แท่นบูชา' }), ['omen_accepted', 'omen_rejected']);
    await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'omen');

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
    const rulingVote = (token: string, ref: string, vote: 'up' | 'down' | null) =>
      hit(call, 'PUT /api/game/rating/votes/:sourceRef', { token, path: `/api/game/rating/votes/${ref}`, body: { vote } });
    await rulingVote(t.a.token, likedRef!, 'down');
    await rulingVote(t.a.token, likedRef!, 'up');
    await rulingVote(t.a.token, 'none', 'up');
    await rulingVote(tgm, likedRef!, 'up');
    await rulingVote(t.a.token, likedRef!, null);
    await hit(call, 'GET /api/game/rating');

    // --- Server owner ---
    const admin = await hit(call, 'POST /api/admin/session', { body: { code: ADMIN_CODE } });
    const adminToken = (admin.body as { token: string }).token;
    await hit(call, 'GET /api/admin/ai-usage', { token: adminToken });
    await hit(call, 'GET /api/admin/ai-usage/:gameId', { token: adminToken, path: `/api/admin/ai-usage/${lobby.game.id}` });
    // GEN-147: the game data editor.
    await hit(call, 'GET /api/admin/game-data', { token: adminToken });
    const schedule = await hit(call, 'GET /api/admin/game-data/:name', { token: adminToken, path: '/api/admin/game-data/NPC_Schedule' });
    const scheduleValue = (schedule.body as { value: unknown }).value;
    await hit(call, 'PUT /api/admin/game-data/:name', { token: adminToken, path: '/api/admin/game-data/NPC_Schedule', body: { value: [] } });
    await hit(call, 'PUT /api/admin/game-data/:name', { token: adminToken, path: '/api/admin/game-data/NPC_Schedule', body: { value: 'not a list' } });
    await hit(call, 'POST /api/admin/game-data/:name/undo', { token: adminToken, path: '/api/admin/game-data/NPC_Schedule/undo' });
    await hit(call, 'POST /api/admin/game-data/:name/undo', { token: adminToken, path: '/api/admin/game-data/NPC_Schedule/undo' });
    expect((await call('GET', '/api/admin/game-data/NPC_Schedule', { token: adminToken })).body).toMatchObject({ value: scheduleValue });
    await hit(call, 'GET /api/admin/game-data/:name', { token: adminToken, path: '/api/admin/game-data/Nope' });
    await hit(call, 'GET /api/admin/game-data/:name/asset-file', { token: adminToken, path: '/api/admin/game-data/NPC_Schedule/asset-file' });
    await hit(call, 'GET /api/admin/game-data/:name/asset-file', { token: adminToken, path: '/api/admin/game-data/Nope/asset-file' });
    await hit(call, 'GET /api/admin/game-data-audit', { token: adminToken });
    await hit(call, 'GET /api/admin/game-data-export', { token: adminToken });
    // GEN-168: a 👎 with reasons, then the owner's review of it.
    await hit(call, 'PUT /api/game/entries/:seq/vote', { token: t.a.token, path: `/api/game/entries/${votable!.seq}/vote`, body: { vote: 'down', reasons: ['too_long'] } });
    await hit(call, 'GET /api/admin/downvotes', { token: adminToken });
    await hit(call, 'POST /api/admin/corrections', { token: adminToken, body: { gameId: tableGame, seq: votable!.seq, edited: 'ฉบับที่ควรเป็น', toLibrary: true } });
    await hit(call, 'POST /api/admin/corrections', { token: adminToken, body: { gameId: tableGame, seq: 99_999, edited: 'x' } });
    await hit(call, 'POST /api/admin/corrections', { token: adminToken, body: { gameId: tableGame, seq: votable!.seq, edited: ' ' } });
    await hit(call, 'GET /api/admin/corrections-export', { token: adminToken });
    await hit(call, 'GET /api/admin/vote-snapshots-export', { token: adminToken });
    // GEN-169: the style checker's counts and settings.
    await hit(call, 'GET /api/admin/style-flags', { token: adminToken });
    await hit(call, 'GET /api/admin/style-settings', { token: adminToken });
    await hit(call, 'PUT /api/admin/style-settings', { token: adminToken, body: { rewrite: false } });
    // GEN-167: the style eval rounds: none yet, then two (Mock AI) and a mark on the second.
    await hit(call, 'GET /api/admin/style-eval', { token: adminToken });
    await hit(call, 'PUT /api/admin/style-eval/:runId/marks/:sceneId', { token: adminToken, path: '/api/admin/style-eval/1/marks/greeting', body: { mark: 'better' } });
    const evalConfig = { ...loadAiConfig({ AI_PROVIDER: 'mock' }), retryDelayMs: 0 };
    for (let i = 0; i < 2; i++) await runStyleEval({ db: server!.orm, assets: server!.assets, provider: providerFor(evalConfig), config: evalConfig, now: () => CLOCK, log: () => {}, maxUsd: 1 });
    await hit(call, 'GET /api/admin/style-eval', { token: adminToken });
    await hit(call, 'PUT /api/admin/style-eval/:runId/marks/:sceneId', { token: adminToken, path: '/api/admin/style-eval/2/marks/greeting', body: { mark: 'better' } });
    await hit(call, 'PUT /api/admin/style-eval/:runId/marks/:sceneId', { token: adminToken, path: '/api/admin/style-eval/2/marks/greeting', body: { mark: 'great' } });
    // GEN-151: the NPC example library.
    await hit(call, 'PUT /api/game/entries/:seq/vote', { token: t.a.token, path: `/api/game/entries/${votable!.seq}/vote`, body: { vote: 'up' } });
    const npcLibrary = await hit(call, 'GET /api/admin/npc-library', { token: adminToken });
    const someNpc = (npcLibrary.body as { npcChoices: { id: string }[] }).npcChoices[0]!.id;
    const withExample = await hit(call, 'POST /api/admin/npc-library', { token: adminToken, body: { from: 'vote', gameId: tableGame, seq: votable!.seq, npcId: someNpc, scene: 'narration' } });
    await hit(call, 'POST /api/admin/npc-library', { token: adminToken, body: { from: 'vote', gameId: tableGame, seq: 99_999, npcId: someNpc, scene: 'narration' } });
    await hit(call, 'POST /api/admin/npc-library', { token: adminToken, body: { from: 'nope' } });
    const exampleId = (withExample.body as { npcs: { examples: { id: number }[] }[] }).npcs[0]!.examples[0]!.id;
    await hit(call, 'DELETE /api/admin/npc-library/:id', { token: adminToken, path: `/api/admin/npc-library/${exampleId}` });
    await hit(call, 'DELETE /api/admin/npc-library/:id', { token: adminToken, path: `/api/admin/npc-library/${exampleId}` });
    // GEN-178: the style review round (too few signals here: skipped); two proposals stored as a round would.
    await hit(call, 'GET /api/admin/style-review', { token: adminToken });
    await hit(call, 'POST /api/admin/style-review/run', { token: adminToken });
    const round = server!.db.prepare("insert into style_review_round (trigger, status, signals, counts, to_at, flag_snapshot, created_at) values ('manual', 'done', 20, ?, 0, '{}', 0)").run(JSON.stringify({ downvotes: 20, flags: 0, reasons: {}, rules: {}, npcs: {} }));
    const propose = () => Number(server!.db.prepare("insert into style_rule_proposal (round_id, kind, content, reason, status) values (?, 'pair', ?, 'สั้นลง', 'proposed')").run(round.lastInsertRowid, JSON.stringify({ bad: 'เขามีความโกรธ', good: 'เขาโกรธ' })).lastInsertRowid);
    const [approveId, rejectId] = [propose(), propose()];
    await hit(call, 'POST /api/admin/style-review/proposals/:id/approve', { token: adminToken, path: `/api/admin/style-review/proposals/${approveId}/approve`, body: {} });
    await hit(call, 'POST /api/admin/style-review/proposals/:id/approve', { token: adminToken, path: `/api/admin/style-review/proposals/${approveId}/approve`, body: {} });
    await hit(call, 'POST /api/admin/style-review/proposals/:id/reject', { token: adminToken, path: `/api/admin/style-review/proposals/${rejectId}/reject` });
    await hit(call, 'POST /api/admin/style-review/proposals/:id/reject', { token: adminToken, path: '/api/admin/style-review/proposals/99999/reject' });
    await hit(call, 'POST /api/admin/style-review/voice/:version/restore', { token: adminToken, path: '/api/admin/style-review/voice/1/restore' });
    await hit(call, 'POST /api/admin/style-review/voice/:version/restore', { token: adminToken, path: '/api/admin/style-review/voice/99/restore' });
    // GEN-080: the lore + feedback extract of the ended table game (Mock AI), then a game that is not one.
    await hit(call, 'POST /api/admin/learning/games/:gameId/extract', { token: adminToken, path: `/api/admin/learning/games/${tableGame}/extract` });
    await hit(call, 'POST /api/admin/learning/games/:gameId/extract', { token: adminToken, path: '/api/admin/learning/games/nope/extract' });
    // GEN-084: the game owner's extract status / retry (Q-363), then the library and its deletes.
    await hit(call, 'GET /api/game/learning', { token: t.gm!.token });
    await hit(call, 'POST /api/game/learning/extract', { token: t.gm!.token });
    await hit(call, 'GET /api/game/learning', { token: t.b.token });
    const lib = await hit(call, 'GET /api/admin/learning', { token: adminToken });
    const first = (lib.body as { entries: { id: string }[] }).entries[0]!.id;
    await hit(call, 'DELETE /api/admin/learning/:id', { token: adminToken, path: `/api/admin/learning/${first}` });
    await hit(call, 'DELETE /api/admin/learning/:id', { token: adminToken, path: `/api/admin/learning/${first}` });
    await hit(call, 'DELETE /api/admin/learning/games/:gameId', { token: adminToken, path: `/api/admin/learning/games/${tableGame}` });
    await hit(call, 'DELETE /api/admin/learning/games/:gameId', { token: adminToken, path: `/api/admin/learning/games/${tableGame}` });
    // GEN-082: a player's style by their player code (stored as joining with it would): look up, switch off, delete; unknown = 403.
    server!.db.prepare("insert into member_style (member_id, game_id, player_key, opt_out, updated_at) values (?, ?, ?, 0, 0)").run(t.a.memberId, tableGame, playerKeyOf(server!.orm, 'pc-contract'));
    await hit(call, 'POST /api/style', { body: { playerCode: 'pc-contract' } });
    await hit(call, 'POST /api/style', { body: { playerCode: 'pc-unknown' } });
    await hit(call, 'PUT /api/style/opt-out', { body: { playerCode: 'pc-contract', optOut: true } });
    await hit(call, 'POST /api/style/delete', { body: { playerCode: 'pc-contract' } });
    // GEN-083: the ended games of that code (none ended here: an empty list); unknown = 403.
    await hit(call, 'POST /api/memory/sources', { body: { playerCode: 'pc-contract' } });
    await hit(call, 'POST /api/memory/sources', { body: { playerCode: 'pc-unknown' } });
    await hit(call, 'POST /api/admin/logout', { token: adminToken });
    await hit(call, 'POST /api/logout', { token: p1.token });
    await hit(call, 'DELETE /api/game', { token: gm, body: { confirmName: 'เกมสัญญา 2' } });

    // --- Socket frames: each passes the schema the contract names for its `type` ---
    const schemaOf = new Map(READY_SERVER_EVENTS.map((i) => [i.type, i.schema]));
    const seenTypes = new Set<string>();
    const seenEntryKinds = new Set<string>();
    for (const client of [a, b, c, bad]) {
      for (const raw of client.raw) {
        const frame = JSON.parse(raw) as RoomServerMessage;
        seenTypes.add(frame.type);
        if (frame.type === 'entry') seenEntryKinds.add(frame.entry.kind);
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
    // GEN-101 C2: every kind of entry the Play page reads came over the real socket and passed `entry` above.
    expect([...seenEntryKinds].sort()).toEqual(expect.arrayContaining(['feed', 'narration', 'omen', 'whisper', 'npc']));
    expect([...READY_HTTP.map(key)].filter((r) => !ok.has(r)), 'ready endpoints never answered 2xx').toEqual([]);
    expect([...schemaOf.keys()].filter((type) => !seenTypes.has(type)), 'ready server events never seen').toEqual([]);
  });
});
