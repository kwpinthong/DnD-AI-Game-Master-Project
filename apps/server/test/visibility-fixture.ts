import { CharacterResponse, CreateGameResponse, JoinResponse } from '@isekai/protocol';
import { expect } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.ts';
import { seedChosenLoot } from './helpers.ts';

export const CREATE_CODE = 'ลับเฉพาะ-2026';
export const CLOCK = Date.UTC(2026, 10, 22, 12, 0, 0);

export interface Seat {
  token: string;
  memberId: string;
  name: string;
  appearance: string;
  personality: string;
}

export const LIN = { name: 'ลิน', appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง', personality: 'ช่างสังเกต พูดน้อย' };
export const DARIN = { name: 'ดาริน', appearance: 'ชายร่างสูงสวมเกราะหนังเก่า', personality: 'ใจร้อน รักพวกพ้อง' };
export const MEKHA = { name: 'เมฆา', appearance: 'เด็กหนุ่มผมขาวถือไม้เท้า', personality: 'ขี้สงสัย ชอบเดินป่า' };

export type Call = (
  method: string,
  path: string,
  options?: { body?: unknown; token?: string },
) => Promise<{ status: number; body: unknown }>;

export function caller(server: RunningServer): Call {
  return async (method, path, options = {}) => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as unknown };
  };
}

export async function startTestServer(dataDir: string, options: ServerOptions = {}): Promise<RunningServer> {
  return startServer(
    { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE) },
    // rng null: no start scenarios (GEN-065), so the tests written before it keep everyone at locations[0]
    // with the GEN-047 starting stats. start-scenarios.test.ts passes its own Rng.
    { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null, ...options },
  );
}

export interface Table {
  call: Call;
  inviteCode: string;
  /** The Human GM; only when the game has one. */
  gm?: { token: string; memberId: string };
  a: Seat;
  b: Seat;
  c: Seat;
}

/**
 * A started online game with three players A (ลิน), B (ดาริน), C (เมฆา), each with a character.
 * `humanGm`: the creator is the GM and A, B, C join; otherwise A creates the game.
 */
export async function startedTable(server: RunningServer, humanGm: boolean): Promise<Table> {
  const call = caller(server);
  const created = await call('POST', '/api/games', {
    body: { createCode: CREATE_CODE, gameName: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm, name: humanGm ? 'จีเอ็ม' : 'นก', pin: '1234' },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const game = CreateGameResponse.parse(created.body);
  const owner = { token: game.token, memberId: game.member.id };

  async function join(playerName: string) {
    const res = await call('POST', '/api/join', { body: { inviteCode: game.game.inviteCode, name: playerName, pin: '1111' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const joined = JoinResponse.parse(res.body);
    return { token: joined.token, memberId: joined.member.id };
  }

  async function withCharacter(member: { token: string; memberId: string }, identity: typeof LIN): Promise<Seat> {
    const res = await call('POST', '/api/game/character', { token: member.token, body: identity });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    CharacterResponse.parse(res.body);
    seedChosenLoot(server.db, member.memberId);
    return { ...member, ...identity };
  }

  const a = await withCharacter(humanGm ? await join('นก') : owner, LIN);
  const b = await withCharacter(await join('บี'), DARIN);
  const c = await withCharacter(await join('ซี'), MEKHA);
  const start = await call('POST', '/api/game/start', { token: owner.token });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  return { call, inviteCode: game.game.inviteCode, ...(humanGm ? { gm: owner } : {}), a, b, c };
}
