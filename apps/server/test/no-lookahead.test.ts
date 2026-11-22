import { defaultScenario } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGameAssets } from '../src/assets/load.ts';
import { crossPlayerState } from '../src/crossplayer/phase.ts';
import { buildTurnContext, loadWorld } from '../src/gm/context.ts';
import type { RunningServer } from '../src/server.ts';
import { advanceTimeline, getTimeline } from '../src/timeline/store.ts';
import { makeTempDir } from './helpers.ts';
import { startedTable, startTestServer } from './visibility-fixture.ts';

/** GEN-111: the AI GM sees only the events of the period it is in, never what later days hold (Q-290: first turn). */

const assets = loadGameAssets();

describe('GEN-111 the AI prompt does not look ahead', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function contextAt(day: number, phase: 'EOSORIA' | 'NOCTHERION', turn: 1 | 2) {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    if (day > 1) advanceTimeline(server.orm, gameId, { day, phase, turn });
    const world = loadWorld(server.orm, gameId, assets);
    const ctx = buildTurnContext(server.orm, {
      world,
      state: crossPlayerState(server.orm, gameId),
      tags: {},
      vocabulary: [],
      drowsy: new Set(),
      at: { day, phase, turn },
      actions: [],
      resting: [],
      assets,
    });
    return { ctx, gameId };
  }

  it('C6: the first turn of a new game carries day 1 news only, and no text about later days', async () => {
    const { ctx } = await contextAt(1, 'EOSORIA', 1);
    expect(ctx.events.active.map((e) => e.id)).toEqual(['d1-bread']);
    expect(ctx.events.past).toEqual([]);
    const text = JSON.stringify(ctx.events);
    for (const other of defaultScenario().timeline.filter((e) => e.id !== 'd1-bread')) expect(text).not.toContain(other.title);
    // The drift outcome of day 1 names days 7 and 10: the AI must not read it while narrating day 1.
    expect(text).not.toContain('วันที่ 7');
  });

  it('C1 / C5: the last turn of the last night of day 11 shows no day 12 event; day 12 is the last day', async () => {
    const { ctx, gameId } = await contextAt(1, 'EOSORIA', 1);
    advanceTimeline(server!.orm, gameId, { day: 11, phase: 'NOCTHERION', turn: 2 });
    const timeline = getTimeline(server!.orm, gameId)!;
    expect(timeline.events.find((e) => e.id === 'd12-meteor')!.status).toBe('pending');
    expect(ctx.events.active.map((e) => e.id)).not.toContain('d12-meteor');
  });
});
