import type { RoomServerMessage } from '@isekai/protocol';
import type { Period, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import type { NarrationContext, TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf } from '../src/gm/mock-gm.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startTestServer, startedTable, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-157: the day summary and the journals of a finished day run in the background, together: the turn that
 * ends the day is published at once, the next turn opens and is resolved without waiting for the room loop; the
 * prompt that needs a summary waits for that one only (adjudicate: the day summary; a narration: the journals).
 * A restart during the summary redoes it on startup.
 */

type Purpose = AiCallRequest['purpose'];

/** Holds the calls of `purposes` until `release()` (then the Mock answers) or `fail()` (a call that never finished). */
function gated(purposes: readonly Purpose[]) {
  const waiting: ((r: AiCallResult | undefined) => void)[] = [];
  let state: 'held' | 'open' | 'failing' = 'held';
  const requests: AiCallRequest[] = [];
  const provider: AiProvider & { requests: AiCallRequest[] } = {
    id: 'mock',
    requests,
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      requests.push(req);
      if (purposes.includes(req.purpose) && state !== 'open') {
        const held = state === 'failing' ? mockReply.fail('timeout') : await new Promise<AiCallResult | undefined>((resolve) => waiting.push(resolve));
        if (held) return held;
      }
      return { ...mockReply.ok(await cannedGmAnswer(req)), model: req.model };
    },
  };
  return {
    provider,
    held: () => waiting.length,
    release() {
      state = 'open';
      waiting.splice(0).forEach((w) => w(undefined));
    },
    fail() {
      state = 'failing';
      waiting.splice(0).forEach((w) => w(mockReply.fail('timeout')));
    },
  };
}

describe('GEN-157 day summary and journals in the background', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let gate: ReturnType<typeof gated> | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    gate?.release();
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function boot(purposes: readonly Purpose[] = []): Promise<ReturnType<typeof gated>> {
    gate = gated(purposes);
    server = await startTestServer(dataDir, {
      aiProvider: gate.provider,
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }),
    });
    return gate;
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function sendAll(clients: RoomClient[], texts: string[]) {
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(texts[i]!, 'public');
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
  }

  const at = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';
  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const refOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.ref;
  const summaries = () => server!.db.prepare("select day from gm_memory where kind = 'day'").all();
  const journals = () => (server!.db.prepare("select count(*) as n from gm_journal where kind = 'day'").get() as { n: number }).n;
  /** Requests of day 2 (made after day 1's last turn was published). */
  let day2From = 0;
  const ofDay2 = (purpose: Purpose) => gate!.provider.requests.slice(day2From).filter((r) => r.purpose === purpose);

  /** Day 1 ends: the last turn of NOCTHERION is played; resolves once day 2 is open for everyone. */
  async function endDay1(): Promise<{ t: Table; clients: RoomClient[] }> {
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 1, phase: 'NOCTHERION', turn: 2 }, CLOCK);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await sendAll(clients, ['เฝ้ายามทั้งคืน', 'นับดาว', 'จุดไฟ']);
    for (const c of clients) await c.waitFor(at(2, 'EOSORIA', 1));
    day2From = gate!.provider.requests.length;
    return { t, clients };
  }

  it('C1: the turn that ends the day is published while the summary and every journal are still running, all at once', async () => {
    const g = await boot(['summarize_day', 'summarize_journal']);
    const { clients } = await endDay1();
    // The result is on screen (its narration arrived) though no summary is done.
    for (const c of clients) expect(c.entries().some((e) => e.kind === 'narration' && e.day === 1 && e.phase === 'NOCTHERION')).toBe(true);
    expect(summaries()).toEqual([]);
    // One day summary + one journal per player, all asked together (not one after another).
    await expect.poll(() => g.held(), { timeout: 5_000 }).toBe(4);
    g.release();
    await expect.poll(() => [summaries().length, journals()], { timeout: 5_000 }).toEqual([1, 3]);
  });

  it('C1/C2: the next turn is adjudicated while the journals still run; its narrations wait for them and read them', async () => {
    const g = await boot(['summarize_journal']);
    const { t, clients } = await endDay1();
    await expect.poll(() => summaries().length, { timeout: 5_000 }).toBe(1);
    await sendAll(clients, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น']);
    // Adjudicate goes out with yesterday's summary although the journals are held.
    await expect.poll(() => ofDay2('gm_adjudicate').length, { timeout: 5_000 }).toBe(1);
    expect(contextOf<TurnContext>(ofDay2('gm_adjudicate')[0]!).memory.yesterday).toContain('เฝ้ายามทั้งคืน');
    expect(journals()).toBe(0);
    expect(ofDay2('narrate_player')).toEqual([]);
    g.release();
    for (const c of clients) await c.waitFor(at(2, 'EOSORIA', 2));
    // No journal lost to the race: every private narration of the turn read its reader's journal of day 1.
    const privateFor = (ref: string) =>
      ofDay2('narrate_player').map((r) => contextOf<NarrationContext>(r)).find((c) => 'player' in c.audience && c.audience.player === ref)!;
    for (const who of [t.a, t.b, t.c]) expect(privateFor(refOf(who)).journal?.yesterday).toBeTruthy();
  });

  it('C2: the next adjudicate waits for the day summary still running, then reads it', async () => {
    const g = await boot(['summarize_day']);
    const { clients } = await endDay1();
    await sendAll(clients, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น']);
    await new Promise((r) => setTimeout(r, 300));
    expect(ofDay2('gm_adjudicate')).toEqual([]);
    g.release();
    for (const c of clients) await c.waitFor(at(2, 'EOSORIA', 2));
    expect(ofDay2('gm_adjudicate')).toHaveLength(1);
    expect(contextOf<TurnContext>(ofDay2('gm_adjudicate')[0]!).memory.yesterday).toContain('เฝ้ายามทั้งคืน');
  });

  it('C3: a restart during the summary redoes it on startup: the summary and every journal exist', async () => {
    const g = await boot(['summarize_day', 'summarize_journal']);
    const { t } = await endDay1();
    await expect.poll(() => g.held(), { timeout: 5_000 }).toBeGreaterThan(0);
    // The server dies mid-summary: the held calls never finish.
    g.fail();
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    expect(summaries()).toEqual([]);
    await server!.close();

    await boot();
    await enter(t.a);
    await expect.poll(() => [summaries(), journals()], { timeout: 5_000 }).toEqual([[{ day: 1 }], 3]);
  });
});
