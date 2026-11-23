// GEN-149: chat with an NPC outside the turn (C1-C8): an answer at once, the turn does not move, a quota per period.
import { ApiError, defaultScenario, NpcChatResponse, NpcChatStatus, SurroundingsResponse, type RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest } from '../src/ai/provider.ts';
import { createMockProvider } from '../src/ai/providers/mock.ts';
import { npcChatPerPeriod } from '../src/npc-chat/service.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { styleFlagStats } from '../src/gm/style-check.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

const MARKET = 'market';
const merchant = defaultScenario().npcs.find((n) => n.id === 'merchant')!;
const away = defaultScenario().locations.find((l) => l.id !== MARKET)!.id;

/** What the NPC answers next (the mock's `npc_chat` reply). */
let answer: Record<string, unknown> = { reply: 'ตลาดวันนี้คึกคักดี', suggestion: null, mood: 'same' };

describe('GEN-149 NPC chat', { timeout: 60_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    answer = { reply: 'ตลาดวันนี้คึกคักดี', suggestion: null, mood: 'same' };
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function start(env: Record<string, string> = {}) {
    const config = loadAiConfig({ AI_PROVIDER: 'mock', ...env });
    const provider = createMockProvider(config, undefined, (req: AiCallRequest) => (req.purpose === 'npc_chat' ? answer : undefined));
    server = await startTestServer(dir, { ai: config, aiProvider: provider });
    const t = await startedTable(server, false);
    moveCharacter(server.orm, t.a.memberId, MARKET, CLOCK);
    moveCharacter(server.orm, t.b.memberId, MARKET, CLOCK);
    moveCharacter(server.orm, t.c.memberId, away, CLOCK);
    const seen = SurroundingsResponse.parse((await t.call('GET', '/api/game/surroundings', { token: t.a.token })).body);
    const refs = seen.view === 'player' ? seen.npcs.map((n) => n.ref) : [];
    const ref = refs.find((r) => (server!.db.prepare('select npc_id from npc_ref where ref = ?').get(r) as { npc_id: string }).npc_id === merchant.id);
    expect(ref, 'the merchant is at the market').toBeTypeOf('string');
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    return { t, ref: ref!, gameId, provider };
  }

  async function rooms(t: Table) {
    const out: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const c = await openRoom(server!, { token: seat.token });
      sockets.push(c);
      out.push(c);
      await c.waitFor(isReady);
    }
    return out as [RoomClient, RoomClient, RoomClient];
  }

  const chat = (t: Table, token: string, body: unknown) => t.call('POST', '/api/game/npc-chat', { token, body });
  const status = async (t: Table, token: string) => NpcChatStatus.parse((await t.call('GET', '/api/game/npc-chat', { token })).body);
  const entriesOf = (c: RoomClient) => c.messages.filter((m): m is Extract<RoomServerMessage, { type: 'entry' }> => m.type === 'entry').map((m) => m.entry);

  it('C1: a message gets the NPC reply at once and the turn does not move', async () => {
    const { t, ref, gameId } = await start();
    const before = ensurePhaseState(server!.orm, gameId, CLOCK);
    const res = await chat(t, t.a.token, { npc: ref, text: 'สวัสดี วันนี้เป็นไงบ้าง' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = NpcChatResponse.parse(res.body);
    expect(body.reply).toBe('ตลาดวันนี้คึกคักดี');
    expect(body.status).toEqual({ perPeriod: 5, left: 4 });
    const after = ensurePhaseState(server!.orm, gameId, CLOCK);
    expect([after.day, after.phase, after.turn, after.status]).toEqual([before.day, before.phase, before.turn, before.status]);
    expect(after.submissions).toEqual({});
  });

  it('C2: the 6th message of a period is refused, the quota says 0; the next period starts at 5 again', async () => {
    const { t, ref, gameId } = await start();
    for (let i = 0; i < 5; i++) expect((await chat(t, t.a.token, { npc: ref, text: `ข้อความ ${i}` })).status).toBe(200);
    expect(await status(t, t.a.token)).toEqual({ perPeriod: 5, left: 0 });
    const refused = await chat(t, t.a.token, { npc: ref, text: 'อีกข้อความ' });
    expect(refused.status).toBe(409);
    expect(ApiError.parse(refused.body).code).toBe('not_allowed');
    // B's quota is B's own.
    expect(await status(t, t.b.token)).toEqual({ perPeriod: 5, left: 5 });
    const state = ensurePhaseState(server!.orm, gameId, CLOCK);
    savePhaseState(server!.orm, gameId, { ...state, phase: 'SOLARION', turn: 1 }, CLOCK);
    expect(await status(t, t.a.token)).toEqual({ perPeriod: 5, left: 5 });
  });

  it('C2: the quota comes from the System_Rules row of category "NPC Chat" (default 5)', () => {
    const row = (parameters: string) => ({ category: 'NPC Chat', name: 'ข้อความคุยกับ NPC ต่อช่วง', parameters, mechanics: '' });
    expect(npcChatPerPeriod([])).toBe(5);
    expect(npcChatPerPeriod([row('3 ข้อความต่อช่วงต่อผู้เล่น')])).toBe(3);
    expect(npcChatPerPeriod([row('0')])).toBe(0);
    expect(npcChatPerPeriod([row('ไม่จำกัด')])).toBe(5);
  });

  it('C3: asking for an item gets an answer and a suggestion, and nothing in the inventory or coins changes', async () => {
    const { t, ref } = await start();
    answer = { reply: 'ดาบเล่มนี้ไม่ได้ให้กันฟรีๆ หรอก', suggestion: 'ลองต่อรองซื้อดาบเป็น action ของเทิร์นนี้', mood: 'same' };
    const inventory = (await t.call('GET', '/api/game/inventory', { token: t.a.token })).body;
    const character = (await t.call('GET', '/api/game/character', { token: t.a.token })).body;
    const body = NpcChatResponse.parse((await chat(t, t.a.token, { npc: ref, text: 'ขอดาบเล่มนั้นให้ฉันเถอะ' })).body);
    expect(body.suggestion).toBe('ลองต่อรองซื้อดาบเป็น action ของเทิร์นนี้');
    expect((await t.call('GET', '/api/game/inventory', { token: t.a.token })).body).toEqual(inventory);
    expect((await t.call('GET', '/api/game/character', { token: t.a.token })).body).toEqual(character);
  });

  it('C4: players at the place see the talk; one elsewhere does not; a whisper reaches only the speaker', async () => {
    const { t, ref } = await start();
    const [a, b, c] = await rooms(t);
    expect((await chat(t, t.a.token, { npc: ref, text: 'ราคาผ้าไหมเท่าไร' })).status).toBe(200);
    await b.waitFor((m) => m.type === 'entry' && m.entry.kind === 'npc' && m.entry.text === 'ตลาดวันนี้คึกคักดี');
    await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'npc');
    expect(entriesOf(b).find((e) => e.kind === 'player')?.text).toBe('ราคาผ้าไหมเท่าไร');
    expect(entriesOf(b).find((e) => e.kind === 'npc')?.npc).toMatchObject({ ref, name: merchant.alias, kind: 'dialogue' });

    answer = { reply: 'ความลับนะ อย่าบอกใคร', suggestion: null, mood: 'same' };
    expect((await chat(t, t.a.token, { npc: ref, text: 'กระซิบถามเรื่องลับ', whisper: true })).status).toBe(200);
    const heard = await a.waitFor((m) => m.type === 'entry' && m.entry.text === 'ความลับนะ อย่าบอกใคร');
    expect(heard.type === 'entry' && heard.entry.npc?.private).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(entriesOf(b).map((e) => e.text)).not.toContain('ความลับนะ อย่าบอกใคร');
    expect(entriesOf(b).map((e) => e.text)).not.toContain('กระซิบถามเรื่องลับ');
    expect(entriesOf(c).filter((e) => e.kind === 'npc' || e.kind === 'player')).toEqual([]);
  });

  it('C5: an NPC that is not at your place cannot be talked to', async () => {
    const { t, ref } = await start();
    const seen = SurroundingsResponse.parse((await t.call('GET', '/api/game/surroundings', { token: t.c.token })).body);
    expect(seen.view === 'player' && seen.npcs.some((n) => n.ref === ref)).toBe(false);
    const res = await chat(t, t.c.token, { npc: ref, text: 'สวัสดี' });
    expect(res.status).toBe(404);
    expect(ApiError.parse(res.body).code).toBe('npc_not_found');
    expect((await chat(t, t.a.token, { npc: 'no-such-ref', text: 'สวัสดี' })).status).toBe(404);
    expect(await status(t, t.c.token)).toEqual({ perPeriod: 5, left: 5 });
  });

  it('C6: a real name the reader does not know comes out as the alias / Social Title', async () => {
    const { t, ref } = await start();
    const [, b] = await rooms(t);
    answer = { reply: `${merchant.name}คนนี้รู้จักดารินดี`, suggestion: null, mood: 'same' };
    const body = NpcChatResponse.parse((await chat(t, t.a.token, { npc: ref, text: 'รู้จักใครแถวนี้บ้าง' })).body);
    expect(body.reply).not.toContain(merchant.name);
    expect(body.reply).not.toContain('ดาริน');
    expect(body.reply).toContain(merchant.alias);
    const line = await b.waitFor((m) => m.type === 'entry' && m.entry.kind === 'npc');
    expect(line.type === 'entry' && line.entry.text).not.toContain(merchant.name);
  });

  it('C6 (GEN-169): the reply passes the style check before it goes out', async () => {
    const { t, ref } = await start();
    answer = { reply: 'ข้าจะทำการเปิดร้านแล้ว', suggestion: null, mood: 'same' };
    expect((await chat(t, t.a.token, { npc: ref, text: 'เปิดร้านกี่โมง' })).status).toBe(200);
    expect(styleFlagStats(server!.orm).some((s) => s.npc?.id === merchant.id)).toBe(true);
  });

  it('C7: the call is counted under its own purpose npc_chat, on the small model', async () => {
    const { t, ref } = await start();
    expect((await chat(t, t.a.token, { npc: ref, text: 'สวัสดี' })).status).toBe(200);
    const rows = server!.db.prepare("select purpose, model, ok from ai_usage where purpose = 'npc_chat'").all();
    expect(rows).toEqual([{ purpose: 'npc_chat', model: 'claude-haiku-5-5', ok: 1 }]);
  });

  it('C8: when the AI fails the player gets ai_unavailable, the quota is not used and nobody gets an entry', async () => {
    const { t, ref } = await start({ AI_MOCK_FAIL: 'npc_chat:timeout', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' });
    const [, b] = await rooms(t);
    const res = await chat(t, t.a.token, { npc: ref, text: 'สวัสดี' });
    expect(res.status).toBe(503);
    expect(ApiError.parse(res.body).code).toBe('ai_unavailable');
    expect(await status(t, t.a.token)).toEqual({ perPeriod: 5, left: 5 });
    await new Promise((r) => setTimeout(r, 200));
    expect(entriesOf(b).filter((e) => e.kind === 'npc' || e.kind === 'player')).toEqual([]);
  });

  it('a warm talk moves the affinity by one, at most once per NPC per period', async () => {
    const { t, ref } = await start();
    answer = { reply: 'ขอบใจนะ', suggestion: null, mood: 'warmer' };
    for (let i = 0; i < 3; i++) expect((await chat(t, t.a.token, { npc: ref, text: 'ชมสินค้า' })).status).toBe(200);
    const bond = server!.db.prepare('select affinity from npc_bond where member_id = ? and npc_id = ?').get(t.a.memberId, merchant.id) as { affinity: number };
    expect(bond.affinity).toBe(1);
  });

  it('the Human GM and empty / too long messages are refused', async () => {
    const { t, ref } = await start();
    expect((await chat(t, t.a.token, { npc: ref, text: '   ' })).status).toBe(400);
    expect((await chat(t, t.a.token, { npc: ref, text: 'ก'.repeat(301) })).status).toBe(400);
    expect((await t.call('GET', '/api/game/npc-chat', {})).status).toBe(401);
  });
});
