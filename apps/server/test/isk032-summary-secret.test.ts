import type { RoomServerMessage } from '@isekai/protocol';
import type { Period, Turn } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { SUMMARY_BLOCK, THAI_OUTPUT, type DayContext, type TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { dayLog } from '../src/gm/store.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/** ISK-032: the day log marks Secret actions, and the summary prompt keeps them out of recap / saga / news. */

// The harness below is copied from ai-gm-loop.test.ts (its helpers are file-local).
type Handler = (req: AiCallRequest, n: number) => AiCallResult | Promise<AiCallResult | undefined> | undefined;

function gmProvider(handler: Handler = () => undefined) {
  const requests: AiCallRequest[] = [];
  const provider: AiProvider & { requests: AiCallRequest[] } = {
    id: 'mock',
    requests,
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      requests.push(req);
      const scripted = await handler(req, requests.length);
      if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
      return mockReply.ok(await cannedGmAnswer(req));
    },
  };
  return provider;
}

const isTurn = (req: AiCallRequest) => req.output.name === 'gm_turn_proposal';

const noRoll: Handler = (req) => {
  if (!isTurn(req)) return undefined;
  const proposal = mockTurnProposal(contextOf<TurnContext>(req));
  for (const a of proposal.actions) a.check = { type: 'none' };
  return mockReply.ok(proposal);
};

const noRollRemember: Handler = (req) => {
  if (!isTurn(req)) return undefined;
  const proposal = mockTurnProposal(contextOf<TurnContext>(req));
  for (const a of proposal.actions) a.check = { type: 'none' };
  proposal.remember = ['โน้ตทดสอบ'];
  return mockReply.ok(proposal);
};

describe('ISK-032 summarize_day keeps Secret actions out', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let provider: ReturnType<typeof gmProvider>;
  const sockets: RoomClient[] = [];
  const logs: string[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }
  async function send(client: RoomClient, text: string, visibility: 'public' | 'secret') {
    const from = client.messages.length;
    client.action(text, visibility);
    const reply = await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
    expect(reply, JSON.stringify(reply)).toEqual({ type: 'action_accepted' });
  }
  const at = (day: number, phase: Period, turn: Turn) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(done: () => boolean, ms = 3_000) {
    for (const end = Date.now() + ms; !done() && Date.now() < end; ) await pause(10);
  }
  const refOf = (who: Seat) => presenceOf(server!.orm, who.memberId)!.ref;

  /** Day 1, NOCTHERION turn 2: A acts in Secret, B and C in public; resolves when day 2 is open. */
  async function dayOneEnds(handler: Handler) {
    provider = gmProvider(handler);
    server = await startTestServer(dataDir, {
      aiProvider: provider,
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }),
      aiLog: (line) => logs.push(line),
    });
    const t: Table = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    savePhaseState(server.orm, gameId, { ...ensurePhaseState(server.orm, gameId, CLOCK), day: 1, phase: 'NOCTHERION', turn: 2 }, CLOCK);
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const texts = ['แอบตามไปที่โบสถ์', 'ซื้อขนมปังที่ตลาด', 'จุดไฟ'];
    const kinds = ['secret', 'public', 'public'] as const;
    const dialogues = () => logs.filter((l) => l.includes('dialogue timing')).length;
    const before = dialogues();
    for (const [i, c] of clients.entries()) await send(c, texts[i]!, kinds[i]!);
    for (const c of clients) await c.waitFor(at(2, 'EOSORIA', 1));
    await until(() => dialogues() > before);
    await pause(30);
    return { t, gameId, lines: dayLog(server.orm, gameId, 1) };
  }
  const lineOf = (lines: string[], who: string) => lines.find((l) => l.includes(`{{p:${who}}}`))!;

  it('ISK-032 C1: the Secret action line carries [Secret], public lines do not', async () => {
    const { t, lines } = await dayOneEnds(noRoll);
    expect(lineOf(lines, refOf(t.a)).startsWith('NOCTHERION เทิร์น 2: [Secret] ')).toBe(true);
    for (const who of [t.b, t.c]) {
      const line = lineOf(lines, refOf(who));
      expect(line.startsWith('NOCTHERION เทิร์น 2: {{p:')).toBe(true);
      expect(line).not.toContain('[Secret]');
    }
  });

  it('ISK-032 C2: a GM note has no marker even in a turn with a Secret action', async () => {
    const { lines } = await dayOneEnds(noRollRemember);
    expect(lines).toContain('NOCTHERION เทิร์น 2 (บันทึก GM): โน้ตทดสอบ');
    for (const l of lines.filter((x) => x.includes('(บันทึก GM)'))) expect(l).not.toContain('[Secret]');
  });

  it('ISK-032 C3: the summary rules keep the old rules and add one [Secret] sentence', () => {
    const text = SUMMARY_BLOCK.text;
    for (const part of [
      'recap = what mattered today, at most 400 characters',
      'saga = the whole story up to today',
      'at most 900 characters',
      'Never an outcome or what will happen, a private clue, a secret or a Secret action',
      THAI_OUTPUT,
    ])
      expect(text).toContain(part);
    expect(text.split('. ').some((s) => s.includes('[Secret]') && s.includes('recap') && s.includes('saga') && s.includes('news'))).toBe(true);
  });

  it('ISK-032 C4: the summarize_day request of day 1 carries the marked line and 3000 output tokens', async () => {
    const { t } = await dayOneEnds(noRoll);
    await until(() => provider.requests.some((r) => r.purpose === 'summarize_day'));
    const req = provider.requests.find((r) => r.purpose === 'summarize_day' && contextOf<DayContext>(r).day === 1)!;
    expect(contextOf<DayContext>(req).log).toContainEqual(expect.stringContaining(`[Secret] {{p:${refOf(t.a)}}} แอบตามไปที่โบสถ์`));
    expect(req.maxOutputTokens).toBe(3_000);
  });
});
