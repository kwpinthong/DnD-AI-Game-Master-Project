import { CharacterResponse, CreateGameResponse, JoinResponse, type RoomServerMessage } from '@isekai/protocol';
import type Database from 'better-sqlite3';
import { expect } from 'vitest';
import type { RunningServer } from '../src/server.ts';
import { seedChosenLoot, withLooks } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CREATE_CODE, DARIN, LIN, MEKHA, type Call, type Seat } from './visibility-fixture.ts';

/** GEN-037: a started online game with four players, the size of the C1 table. */

export const NARA = withLooks({ name: 'นารา', appearance: 'หญิงสาวถือพิณไม้ ผมเปีย', personality: 'ร่าเริง ชอบร้องเพลง' }, 'avatar-04');

export interface FourTable {
  call: Call;
  gameId: string;
  inviteCode: string;
  seats: [Seat, Seat, Seat, Seat];
}

export async function fourPlayerTable(server: RunningServer, gameName = 'เมืองก่อนอุกกาบาต'): Promise<FourTable> {
  const call = caller(server);
  const created = await call('POST', '/api/games', {
    body: { createCode: CREATE_CODE, gameName, mode: 'online', humanGm: false, name: 'นก', pin: '1234' },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const game = CreateGameResponse.parse(created.body);

  async function postJoin(name: string) {
    const res = await call('POST', '/api/join', { body: { inviteCode: game.game.inviteCode, name, pin: '1111' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const joined = JoinResponse.parse(res.body);
    return { token: joined.token, memberId: joined.member.id };
  }
  async function withCharacter(member: { token: string; memberId: string }, identity: typeof LIN): Promise<Seat> {
    const res = await call('POST', '/api/game/character', { token: member.token, body: identity });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    CharacterResponse.parse(res.body);
    // The start needs a loot choice (Q-144).
    seedChosenLoot(server.db, member.memberId);
    return { ...member, ...identity };
  }

  const seats: [Seat, Seat, Seat, Seat] = [
    await withCharacter({ token: game.token, memberId: game.member.id }, LIN),
    await withCharacter(await postJoin('บี'), DARIN),
    await withCharacter(await postJoin('ซี'), MEKHA),
    await withCharacter(await postJoin('ดี'), NARA),
  ];
  const start = await call('POST', '/api/game/start', { token: game.token });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  return { call, gameId: game.game.id, inviteCode: game.game.inviteCode, seats };
}

export async function enterRoom(server: RunningServer, seat: { token: string }, sockets: RoomClient[], afterSeq = 0): Promise<RoomClient> {
  const client = await openRoom(server, { token: seat.token, afterSeq });
  sockets.push(client);
  await client.waitFor(isReady);
  return client;
}

export async function sendAction(client: RoomClient, text: string, visibility: 'public' | 'secret' = 'public') {
  const from = client.messages.length;
  client.action(text, visibility);
  return client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
}

export const atTurn = (day: number, phase: string, turn: number) => (m: RoomServerMessage) =>
  m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';

/** Everyone acts once in day 1 EOSORIA turn 1 and the AI GM (Mock) resolves it: feed, narration, GM memory, AI usage. */
export async function playFirstTurn(server: RunningServer, t: FourTable, sockets: RoomClient[]): Promise<RoomClient[]> {
  const clients = [];
  for (const seat of t.seats) clients.push(await enterRoom(server, seat, sockets));
  const texts = ['เดินสำรวจตลาด', 'ถามข่าวพ่อค้า', 'ช่วยยายแบกของ', 'นั่งฟังเพลงที่โรงเตี๊ยม'];
  for (const [i, client] of clients.entries()) expect(await sendAction(client, texts[i]!)).toEqual({ type: 'action_accepted' });
  for (const client of clients) await client.waitFor(atTurn(1, 'EOSORIA', 2));
  return clients;
}

/** Every row of every table (sorted), to compare two moments of the same database. */
export function dumpTables(sqlite: Database.Database): Record<string, unknown[]> {
  const tables = sqlite
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all() as { name: string }[];
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const rows = sqlite.prepare(`select * from "${name}"`).all().map((r) => JSON.stringify(r));
    out[name] = rows.sort().map((r) => JSON.parse(r) as unknown);
  }
  return out;
}
