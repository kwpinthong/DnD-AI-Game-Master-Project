import { CharacterResponse, CreateGameResponse, JoinResponse, PlayerStyleResponse } from '@isekai/protocol';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStyles, styleContextFor } from '../src/learning/style.ts';
import { ensurePhaseState, recordAction, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir, seedChosenLoot } from './helpers.ts';
import { caller, CLOCK, CREATE_CODE, DARIN, LIN, MEKHA, readyAll, startTestServer, type Call } from './visibility-fixture.ts';

/**
 * GEN-082: a player's style profile across games, linked by the player code they set when joining (Q-167), kept only
 * as an HMAC. Built from the actions of ended games (no score gate), only what the end page reveals; the player
 * sees / deletes their own and can switch it off.
 */
const CODE_B = 'ab12-cd34';
const CODE_B_AGAIN = 'AB12CD34';
const CODE_A = 'nok-2026';
const PERIODS = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

interface Seat {
  token: string;
  memberId: string;
}

describe('GEN-082 player style across games', { timeout: 120_000 }, () => {
  let cleanup = () => {};
  let dbPath = '';
  let server: RunningServer | undefined;
  let logs: string[] = [];
  let createBodies: string[] = [];

  beforeEach(async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    logs = [];
    createBodies = [];
    server = await startTestServer(tmp.dir, { aiLog: (line) => logs.push(line) });
    dbPath = server.dbPath;
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  /** A started game: A owns it, B and C join with the given style fields. */
  async function table(style: { a?: Record<string, unknown>; b?: Record<string, unknown>; c?: Record<string, unknown> } = {}): Promise<{ call: Call; gameId: string; a: Seat; b: Seat; c: Seat }> {
    const call = caller(server!);
    const created = await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm: false, name: 'นก', pin: '1234', ...style.a } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const game = CreateGameResponse.parse(created.body);
    createBodies.push(JSON.stringify(created.body));
    const join = async (name: string, extra: Record<string, unknown> = {}) => {
      const res = await call('POST', '/api/join', { body: { inviteCode: game.game.inviteCode, name, pin: '1111', ...extra } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const joined = JoinResponse.parse(res.body);
      return { token: joined.token, memberId: joined.member.id };
    };
    const a = { token: game.token, memberId: game.member.id };
    const b = await join('บี', style.b);
    const c = await join('ซี', style.c);
    for (const [s, identity] of [[a, LIN], [b, DARIN], [c, MEKHA]] as const) {
      const res = await call('POST', '/api/game/character', { token: s.token, body: identity });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      CharacterResponse.parse(res.body);
      seedChosenLoot(server!.db, s.memberId);
    }
    await readyAll(call, [a, b, c]);
    return { call, gameId: game.game.id, a, b, c };
  }

  const refOf = (memberId: string) => (server!.db.prepare('select ref from character_presence where member_id = ?').get(memberId) as { ref: string }).ref;

  /** Action n of a member (its own period / turn), tagged by the AI GM with `verbs`. */
  function act(gameId: string, seat: Seat, n: number, verbs: string[], visibility: 'public' | 'secret' = 'public') {
    const at = { day: 1 + Math.floor(n / 8), phase: PERIODS[Math.floor(n / 2) % 4]!, turn: n % 2 === 0 ? (1 as const) : (2 as const) };
    recordAction(server!.orm, gameId, at, seat.memberId, { text: `การกระทำที่ ${n}`, visibility, rest: false }, CLOCK);
    const row = server!.db.prepare('select proposal from gm_turn where game_id = ? and day = ? and phase = ? and turn = ?').get(gameId, at.day, at.phase, at.turn) as { proposal: string } | undefined;
    const actions = row ? (JSON.parse(row.proposal) as { actions: unknown[] }).actions : [];
    actions.push({ actionId: `act-${actions.length + 1}`, actor: refOf(seat.memberId), tagging: { verbTags: verbs, targetTags: [], activate: [] } });
    server!.db
      .prepare("insert into gm_turn (game_id, day, phase, turn, status, proposal, rolls, updated_at) values (?, ?, ?, ?, 'applied', ?, '[]', 0) on conflict do update set proposal = excluded.proposal")
      .run(gameId, at.day, at.phase, at.turn, JSON.stringify({ actions }));
  }

  function end(gameId: string) {
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, CLOCK);
    buildStyles(server!.orm, gameId, CLOCK);
  }

  async function profile(call: Call, playerCode: string, token?: string) {
    return call('POST', '/api/style', { body: { playerCode }, ...(token ? { token } : {}) });
  }
  async function myStyle(call: Call, playerCode: string) {
    const res = await profile(call, playerCode);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return PlayerStyleResponse.parse(res.body);
  }

  it('C1: actions in 2 ended games (same code, any spelling) → one profile over both, top 3 verbs; the code itself is never stored or logged', async () => {
    const g1 = await table({ b: { playerCode: CODE_B } });
    act(g1.gameId, g1.b, 0, ['STEAL']);
    act(g1.gameId, g1.b, 1, ['STEAL']);
    act(g1.gameId, g1.b, 2, ['TALK']);
    end(g1.gameId);
    const g2 = await table({ b: { playerCode: CODE_B_AGAIN } });
    act(g2.gameId, g2.b, 0, ['STEAL']);
    act(g2.gameId, g2.b, 1, ['OBSERVE']);
    act(g2.gameId, g2.b, 2, ['OBSERVE'], 'secret');
    end(g2.gameId);

    const style = await myStyle(g1.call, CODE_B);
    expect(style.optOut).toBe(false);
    expect(style.style?.verbs).toEqual([
      { verb: 'steal', count: 3 },
      { verb: 'observe', count: 2 },
      { verb: 'talk', count: 1 },
    ]);
    expect(style.style?.summary.length).toBeGreaterThan(0);

    const keys = server!.db.prepare('select player_key as k from member_style where player_key is not null').all() as { k: string }[];
    expect(keys).toHaveLength(2);
    expect(keys[0]!.k).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[0]!.k).toBe(keys[1]!.k);
    const files = [dbPath, `${dbPath}-wal`].filter((p) => existsSync(p)).map((p) => readFileSync(p));
    const file = files.map((f) => f.toString('latin1') + f.toString('utf8')).join('');
    for (const code of [CODE_B, CODE_B_AGAIN, 'AB12-CD34']) expect(file).not.toContain(code);
    expect(logs.join('\n')).not.toMatch(/ab12|AB12/i);
  });

  it('C2: actions in a game not ended are not counted', async () => {
    const g1 = await table({ b: { playerCode: CODE_B } });
    act(g1.gameId, g1.b, 0, ['STEAL']);
    end(g1.gameId);
    const g2 = await table({ b: { playerCode: CODE_B } });
    act(g2.gameId, g2.b, 0, ['HEAL']);
    buildStyles(server!.orm, g2.gameId, CLOCK);
    expect((await myStyle(g1.call, CODE_B)).style?.verbs).toEqual([{ verb: 'steal', count: 1 }]);
  });

  it('C3: a Secret action the end page does not reveal (a removed player) is not in the profile; a revealed one is', async () => {
    const g = await table({ b: { playerCode: CODE_B }, c: { playerCode: CODE_A } });
    act(g.gameId, g.b, 0, ['STEAL'], 'secret');
    act(g.gameId, g.c, 0, ['POISON'], 'secret');
    server!.db.prepare('update member set kicked_at = ? where id = ?').run(CLOCK, g.c.memberId);
    end(g.gameId);
    expect((await myStyle(g.call, CODE_B)).style?.verbs).toEqual([{ verb: 'steal', count: 1 }]);
    expect((await myStyle(g.call, CODE_A)).style).toBeNull();
  });

  it('C4: player A asking for B\'s profile → 403; an unknown code → 403 and 5 wrong codes lock the IP out', async () => {
    const g = await table({ b: { playerCode: CODE_B }, c: { playerCode: CODE_A } });
    act(g.gameId, g.b, 0, ['STEAL']);
    end(g.gameId);
    expect((await profile(g.call, CODE_B, g.c.token)).status).toBe(403);
    expect((await profile(g.call, CODE_B, g.b.token)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await profile(g.call, `wrong-${i}`)).status).toBe(403);
    expect((await profile(g.call, CODE_B)).status).toBe(429);
  });

  it('C5: the player deletes the profile → it is gone, and a new game gives the AI no style of theirs', async () => {
    const g1 = await table({ b: { playerCode: CODE_B } });
    act(g1.gameId, g1.b, 0, ['STEAL']);
    end(g1.gameId);
    const g2 = await table({ b: { playerCode: CODE_B } });
    expect(styleContextFor(server!.orm, g2.gameId)).toContain(`{{p:${refOf(g2.b.memberId)}}}`);
    const res = await g1.call('POST', '/api/style/delete', { body: { playerCode: CODE_B } });
    expect(res.status).toBe(200);
    expect(PlayerStyleResponse.parse(res.body).style).toBeNull();
    expect((await myStyle(g1.call, CODE_B)).style).toBeNull();
    expect(styleContextFor(server!.orm, g2.gameId)).toBeNull();
    expect(server!.db.prepare("select count(*) as n from learning_entry where type = 'style'").get()).toEqual({ n: 0 });
  });

  it('C6: "ไม่ให้เก็บสไตล์ฉัน" switched off (on the style page or when joining) → the next game end stores no new profile', async () => {
    const g1 = await table({ b: { playerCode: CODE_B } });
    act(g1.gameId, g1.b, 0, ['STEAL']);
    const off = await g1.call('PUT', '/api/style/opt-out', { body: { playerCode: CODE_B, optOut: true } });
    expect(off.status).toBe(200);
    expect(PlayerStyleResponse.parse(off.body)).toEqual({ style: null, optOut: true });
    end(g1.gameId);
    expect(server!.db.prepare("select count(*) as n from learning_entry where type = 'style'").get()).toEqual({ n: 0 });

    const g2 = await table({ c: { playerCode: CODE_A, noStyle: true } });
    act(g2.gameId, g2.c, 0, ['TALK']);
    end(g2.gameId);
    expect((await myStyle(g2.call, CODE_A)).style).toBeNull();
    expect(styleContextFor(server!.orm, g2.gameId)).toBeNull();
  });

  it('C7: a new player with no history in a game → empty profile, and the AI gets no style section', async () => {
    const g = await table({ b: { playerCode: CODE_B } });
    act(g.gameId, g.b, 0, ['STEAL']);
    expect(await myStyle(g.call, CODE_B)).toEqual({ style: null, optOut: false });
    expect(styleContextFor(server!.orm, g.gameId)).toBeNull();
  });

  // GEN-201: the game owner sets the same fields on the create form.
  it('GEN-201 C1: the owner\'s code at create links their style across games (same profile as a join with that code)', async () => {
    const g1 = await table({ a: { playerCode: CODE_A } });
    act(g1.gameId, g1.a, 0, ['STEAL']);
    act(g1.gameId, g1.a, 1, ['STEAL']);
    end(g1.gameId);
    const g2 = await table({ b: { playerCode: 'NOK2026' } });
    act(g2.gameId, g2.b, 0, ['OBSERVE']);
    end(g2.gameId);
    expect((await myStyle(g1.call, CODE_A)).style?.verbs).toEqual([
      { verb: 'steal', count: 2 },
      { verb: 'observe', count: 1 },
    ]);
  });

  it('GEN-201 C2: the owner ticks "ไม่ต้องเก็บสไตล์ของฉัน" at create → no profile is built from that game', async () => {
    const g = await table({ a: { playerCode: CODE_A, noStyle: true } });
    act(g.gameId, g.a, 0, ['STEAL']);
    end(g.gameId);
    expect(server!.db.prepare("select count(*) as n from learning_entry where type = 'style'").get()).toEqual({ n: 0 });
    expect((await myStyle(g.call, CODE_A)).style).toBeNull();
    expect(styleContextFor(server!.orm, g.gameId)).toBeNull();

    // Ticked without a code: still no profile.
    const g2 = await table({ a: { noStyle: true } });
    act(g2.gameId, g2.a, 0, ['TALK']);
    end(g2.gameId);
    expect(server!.db.prepare("select count(*) as n from learning_entry where type = 'style'").get()).toEqual({ n: 0 });
  });

  it('GEN-201 C3: the owner\'s code is not stored, logged or sent back by the create call', async () => {
    const g = await table({ a: { playerCode: CODE_A } });
    act(g.gameId, g.a, 0, ['STEAL']);
    end(g.gameId);
    expect(createBodies.join('\n')).not.toMatch(/nok-?2026/i);
    const files = [dbPath, `${dbPath}-wal`].filter((p) => existsSync(p)).map((p) => readFileSync(p));
    const file = files.map((f) => f.toString('latin1') + f.toString('utf8')).join('');
    expect(file).not.toMatch(/nok-?2026/i);
    expect(logs.join('\n')).not.toMatch(/nok-?2026/i);
  });
});
