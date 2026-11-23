import type { RoomEntry, RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import type { NarrationContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf } from '../src/gm/mock-gm.ts';
import { setStyleSettings, styleFlagStats } from '../src/gm/style-check.ts';
import type { RunningServer } from '../src/server.ts';
import { presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { startedTable, startTestServer, type Seat } from './visibility-fixture.ts';

// GEN-169: the style check runs on each narration before it is published: it flags, it never drops the message.

type Handler = (req: AiCallRequest) => Promise<AiCallResult | undefined> | AiCallResult | undefined;

const isNarration = (req: AiCallRequest) => req.output.name === 'gm_narration';
const BAD = 'คุณได้ทำการเปิดประตูโรงเตี๊ยม';

describe('style check in the AI GM turn (GEN-169)', { timeout: 60_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];
  const requests: AiCallRequest[] = [];
  const logs: string[] = [];

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    requests.length = 0;
    logs.length = 0;
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function boot(handler: Handler, env: Record<string, string> = {}) {
    const provider: AiProvider = {
      id: 'mock',
      ready: () => ({ ok: true }),
      estimateTokens: (text) => Math.ceil(text.length / 3),
      async call(req) {
        requests.push(req);
        const scripted = await handler(req);
        if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
        return mockReply.ok(await cannedGmAnswer(req));
      },
    };
    server = await startTestServer(dir, {
      aiProvider: provider,
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0', ...env }),
      aiLog: (line) => logs.push(line),
    });
  }

  async function playOneTurn(seats: Seat[]) {
    const clients: RoomClient[] = [];
    for (const seat of seats) {
      const c = await openRoom(server!, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      clients.push(c);
    }
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(['เปิดประตู', 'ดื่มชา', 'อ่านประกาศ'][i]!, 'public');
      await c.waitFor((m) => m.type === 'action_accepted', from);
    }
    for (const c of clients) await c.waitFor((m: RoomServerMessage) => m.type === 'room' && m.turn === 2 && m.status === 'collecting');
    return clients;
  }

  /** A's own narration gets the bad phrase (the first time, or every time with `always`). */
  const badFor = (refA: () => string, always: boolean): Handler => async (req) => {
    if (!isNarration(req)) return undefined;
    const audience = contextOf<NarrationContext>(req).audience;
    if (!('player' in audience) || audience.player !== refA()) return undefined;
    const rewriteAsk = req.messages.length > 1 && req.messages.at(-1)!.text.includes('styleIssues');
    const answer = (await cannedGmAnswer(req)) as { segments: { actionId: string; text: string }[] };
    if (always || !rewriteAsk) answer.segments[0]!.text = `${BAD} ${answer.segments[0]!.text}`;
    return mockReply.ok(answer);
  };
  const forA = (refA: string) => requests.filter((r) => isNarration(r) && (contextOf<NarrationContext>(r).audience as { player?: string }).player === refA);
  const narrationOf = (c: RoomClient) => c.entries().filter((e: RoomEntry) => e.kind === 'narration' && e.turn === 1);

  it('C1: a narration over the threshold is flagged and still reaches the player as written (rewrite off)', async () => {
    let refA = '';
    await boot(badFor(() => refA, true));
    const t = await startedTable(server!, false);
    refA = presenceOf(server!.orm, t.a.memberId)!.ref;
    const [a] = await playOneTurn([t.a, t.b, t.c]);
    expect(forA(refA)).toHaveLength(1);
    expect(narrationOf(a!)[0]!.text).toContain(BAD);
    expect(styleFlagStats(server!.orm)).toContainEqual({ npc: null, reason: 'dai_tham_kan', count: 1 });
    const flagLine = logs.find((l) => l.startsWith('[style]'));
    expect(flagLine).toContain('dai_tham_kan');
    expect(flagLine).not.toContain(BAD);
  });

  it('C3: rewrite on + a block hit: the AI rewrites once and the fixed text goes out', async () => {
    let refA = '';
    await boot(badFor(() => refA, false));
    const t = await startedTable(server!, false);
    setStyleSettings(server!.orm, { rewrite: true });
    refA = presenceOf(server!.orm, t.a.memberId)!.ref;
    const [a] = await playOneTurn([t.a, t.b, t.c]);
    expect(forA(refA)).toHaveLength(2);
    expect(narrationOf(a!)[0]!.text).not.toContain(BAD);
  });

  it('C3: rewrite on but the rewrite fails too: one rewrite only, the original goes out, and a hung rewrite is cut at the budget', async () => {
    let refA = '';
    let hang = false;
    const bad = badFor(() => refA, true);
    await boot(async (req) => {
      if (hang && isNarration(req) && req.messages.at(-1)!.text.includes('styleIssues')) await new Promise((r) => setTimeout(r, 20_000));
      return bad(req);
    }, { AI_STYLE_REWRITE_MS: '300' });
    const t = await startedTable(server!, false);
    setStyleSettings(server!.orm, { rewrite: true });
    refA = presenceOf(server!.orm, t.a.memberId)!.ref;
    const [a] = await playOneTurn([t.a, t.b, t.c]);
    expect(forA(refA)).toHaveLength(2);
    expect(narrationOf(a!)[0]!.text).toContain(BAD);

    // A second game whose rewrite hangs: the turn still ends well inside the test time.
    hang = true;
    requests.length = 0;
    const t2 = await startedTable(server!, false);
    refA = presenceOf(server!.orm, t2.a.memberId)!.ref;
    const started = performance.now();
    const [a2] = await playOneTurn([t2.a, t2.b, t2.c]);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(narrationOf(a2!)[0]!.text).toContain(BAD);
  });
});
