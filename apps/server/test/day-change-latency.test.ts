import type { RoomServerMessage } from '@isekai/protocol';
import type { Period, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import type { DayContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf } from '../src/gm/mock-gm.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startTestServer, startedTable } from './visibility-fixture.ts';

/**
 * GEN-190: the first turn after a day change, with the Mock answering after the time a real call takes (seconds
 * scaled to UNIT ms). The players act as soon as the new day opens, so every background job of the day change
 * (scene, weather, day summary, journals) is still running when the turn closes. No real AI (Q-378 = B).
 */

const UNIT = 50;
/** Seconds per call, modelled on the real-AI runs of GEN-161 / GEN-180 (adjudicate 5-7 s, a narration ~6 s). */
const SECONDS: Partial<Record<AiCallRequest['purpose'], number>> = {
  gm_adjudicate: 6,
  narrate_player: 6,
  narrate_place: 6,
  summarize_day: 8,
  summarize_journal: 8,
  gm_weather: 2,
  npc_dialogue: 4,
};
const SCENE_SECONDS = 3;
const secondsOf = (req: AiCallRequest) => (req.output.name === 'gm_scene' ? SCENE_SECONDS : (SECONDS[req.purpose] ?? 0));

function slowMock() {
  const requests: AiCallRequest[] = [];
  const provider: AiProvider & { requests: AiCallRequest[] } = {
    id: 'mock',
    requests,
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req): Promise<AiCallResult> {
      requests.push(req);
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), secondsOf(req) * UNIT);
        req.signal?.addEventListener('abort', () => (clearTimeout(timer), resolve(true)), { once: true });
      });
      if (aborted) return mockReply.fail('timeout');
      return { ...mockReply.ok(await cannedGmAnswer(req)), model: req.model };
    },
  };
  return provider;
}

describe('GEN-190 the first turn after a day change', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];
  const logs: string[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    logs.length = 0;
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  const at = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';

  async function sendAll(clients: RoomClient[], texts: string[]) {
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(texts[i]!, 'public');
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
  }

  /** Plays day 1's last turn, then day 2's first turn at once; the first turn's time in (scaled) seconds. */
  async function play(): Promise<{ provider: ReturnType<typeof slowMock>; seconds: number; timing: string }> {
    const provider = slowMock();
    server = await startTestServer(dataDir, {
      aiProvider: provider,
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }),
      aiLog: (line) => logs.push(line),
    });
    const t = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    savePhaseState(server.orm, gameId, { ...ensurePhaseState(server.orm, gameId, CLOCK), day: 1, phase: 'NOCTHERION', turn: 2 }, CLOCK);
    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const c = await openRoom(server, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      clients.push(c);
    }
    await sendAll(clients, ['เฝ้ายามทั้งคืน', 'นับดาว', 'จุดไฟ']);
    for (const c of clients) await c.waitFor(at(2, 'EOSORIA', 1));
    // The players act the moment day 2 opens.
    await sendAll(clients, ['ล้างหน้า', 'กินข้าว', 'ยืดเส้น']);
    const start = performance.now();
    for (const c of clients) await c.waitFor(at(2, 'EOSORIA', 2));
    const seconds = (performance.now() - start) / UNIT;
    const timing = logs.find((l) => l.includes('day=2 phase=EOSORIA turn=1 timing'))!;
    // C2: the report's numbers (stage ms back to scaled seconds).
    console.log(`[GEN-190] first turn after the day change: ${seconds.toFixed(1)} s | ${timing.replace(/(\w+)_ms=(\d+)/g, (_, s: string, ms: string) => `${s}=${(Number(ms) / UNIT).toFixed(1)}s`)}`);
    return { provider, seconds, timing };
  }

  it('C1 (simulated): the turn is resolved and published within 16 s of the modelled call times (was ~20 s)', async () => {
    const { seconds } = await play();
    expect(seconds).toBeLessThanOrEqual(16.5);
  });

  it('C2: the adjudicate no longer waits for the day summary: it was asked while the last turn of the day was narrated', async () => {
    const { timing } = await play();
    const memoryWait = Number(/memory_wait_ms=(\d+)/.exec(timing)?.[1] ?? '0') / UNIT;
    expect(memoryWait).toBeLessThan(1);
  });

  it('C3: the game reads the same: one day summary of day 1, from every turn of day 1 including its last one', async () => {
    const { provider } = await play();
    const summaries = provider.requests.filter((r) => r.purpose === 'summarize_day');
    expect(summaries).toHaveLength(1);
    const ctx = contextOf<DayContext>(summaries[0]!);
    expect(ctx.day).toBe(1);
    expect(ctx.log.some((l) => l.startsWith('NOCTHERION เทิร์น 2'))).toBe(true);
    expect(server!.db.prepare("select day from gm_memory where kind = 'day'").all()).toEqual([{ day: 1 }]);
  });
});
