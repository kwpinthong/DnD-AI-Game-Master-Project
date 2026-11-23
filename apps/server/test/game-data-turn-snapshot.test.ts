import { AdminSessionResponse, GameDataSetResponse, type RoomServerMessage } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { pinAssets } from '../src/assets/game-data.ts';
import { hashPin } from '../src/auth/pin.ts';
import type { DialogueContext, NarrationContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf } from '../src/gm/mock-gm.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, type Call, type Table } from './visibility-fixture.ts';

// GEN-174: a turn reads one snapshot of the game data from the start of its resolve to its last background stage;
// an admin edit saved meanwhile reaches the next turn (and new games) only.

/** A throwaway admin code for this test only. */
const ADMIN_CODE = 'ทดสอบ-snapshot-174';
/** โนอา's id in the default scenario; nobody is scheduled at the inn (where everyone starts) in EOSORIA. */
const NOA = 'beggar';

describe('game data snapshot per turn (GEN-174)', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;
  const sockets: RoomClient[] = [];
  const requests: AiCallRequest[] = [];
  /** Runs inside the next `gm_adjudicate` call, before it answers (an admin edit while the turn resolves). */
  let duringAdjudicate: (() => Promise<void>) | undefined;

  const provider: AiProvider = {
    id: 'mock',
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      requests.push(req);
      if (req.purpose === 'gm_adjudicate' && duringAdjudicate) {
        const edit = duringAdjudicate;
        duringAdjudicate = undefined;
        await edit();
      }
      return { ...mockReply.ok(await cannedGmAnswer(req)), model: req.model };
    },
  };

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    requests.length = 0;
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(dir, 'isekai.sqlite'), createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }), aiProvider: provider, aiLog: () => {}, rng: null },
    );
    call = caller(server);
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function adminToken() {
    return AdminSessionResponse.parse((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body).token;
  }

  /** The admin moves โนอา to the inn for every period and weather. */
  async function noaToInn() {
    const token = await adminToken();
    const schedule = GameDataSetResponse.parse((await call('GET', '/api/admin/game-data/NPC_Schedule', { token })).body).value as unknown[];
    const row = { npc: 'โนอา', location: 'โรงเตี๊ยมและกิลด์นักเดินทาง', periods: [], weathers: [], condition: '', note: 'GEN-174 test' };
    const res = await call('PUT', '/api/admin/game-data/NPC_Schedule', { token, body: { value: [...schedule, row] } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  async function enter(t: Table): Promise<RoomClient[]> {
    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const client = await openRoom(server!, { token: seat.token });
      sockets.push(client);
      await client.waitFor(isReady);
      clients.push(client);
    }
    return clients;
  }

  /** Everyone acts; resolves when the turn after it (`next`: phase + turn) is collecting for everyone. */
  async function playTurn(clients: RoomClient[], next: [string, number]) {
    for (const c of clients) {
      const from = c.messages.length;
      c.action('มองไปรอบๆ', 'public');
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
    for (const c of clients) await c.waitFor((m: RoomServerMessage) => m.type === 'room' && m.status === 'collecting' && m.phase === next[0] && m.turn === next[1]);
  }

  const noaHere = (r: AiCallRequest) => contextOf<NarrationContext | DialogueContext>(r).npcs.some((n) => n.id === NOA && n.here);
  const narrations = (from: number, to = requests.length) => requests.slice(from, to).filter((r) => r.purpose === 'narrate_place' || r.purpose === 'narrate_player');
  /** The background NPC dialogue calls of EOSORIA turn `turn` (day 1). */
  const dialogues = (turn: number) => requests.filter((r) => r.purpose === 'npc_dialogue' && contextOf<DialogueContext>(r).turn.turn === turn);

  it('C1 / C2: an NPC_Schedule edit saved while a turn resolves is not seen by that turn (narration nor dialogue); the next turn sees it', async () => {
    const t = await startedTable(server!, false);
    const clients = await enter(t);
    duringAdjudicate = noaToInn;
    const turn1 = requests.length;
    await playTurn(clients, ['EOSORIA', 2]);
    expect(duringAdjudicate).toBeUndefined();
    const turn1Narrations = narrations(turn1);
    expect(turn1Narrations.length).toBeGreaterThan(0);
    expect(turn1Narrations.filter(noaHere)).toEqual([]);

    const turn2 = requests.length;
    await playTurn(clients, ['SOLARION', 1]);
    expect(narrations(turn2).some(noaHere)).toBe(true);
    // The old turn's background dialogue read the old snapshot too: nobody was at the inn for it.
    await expect.poll(() => dialogues(2).length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(dialogues(1).filter(noaHere)).toEqual([]);
  });

  it('C3: a game started after the edit reads the latest data from its first turn', async () => {
    await noaToInn();
    const t = await startedTable(server!, false);
    const clients = await enter(t);
    const from = requests.length;
    await playTurn(clients, ['EOSORIA', 2]);
    expect(narrations(from).some(noaHere)).toBe(true);
  });

  it('pinAssets: what runs under the pin (also later, in the background) reads the data as of the pin', async () => {
    const before = server!.assets.npcSchedule!.length;
    const pin = pinAssets(server!.assets);
    const later = pin(() => new Promise<number>((resolve) => setTimeout(() => resolve(server!.assets.npcSchedule!.length), 50)));
    await noaToInn();
    expect(server!.assets.npcSchedule).toHaveLength(before + 1);
    expect(pin(() => server!.assets.npcSchedule!.length)).toBe(before);
    expect(await later).toBe(before);
    expect(await pin(async () => (await Promise.resolve(), server!.assets.npc('โนอา')?.name))).toBe(server!.assets.npc('โนอา')?.name);
    // A plain GameAssets (not the live view) passes through.
    const plain = { ...server!.assets };
    expect(pinAssets(plain)(() => 1)).toBe(1);
  });
});
