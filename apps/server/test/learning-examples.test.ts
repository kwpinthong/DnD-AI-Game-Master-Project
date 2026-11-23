import { CharacterResponse, CreateGameResponse, JoinResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteLearningEntry, examplesFor, npcCandidates, syncExamples } from '../src/learning/examples.ts';
import { ensurePhaseState, insertEntry, recordAction, savePhaseState, type EntryMeta } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir, seedChosenLoot, withLooks } from './helpers.ts';
import { caller, CLOCK, CREATE_CODE, DARIN, LIN, MEKHA, readyAll, startTestServer, type Call } from './visibility-fixture.ts';

/**
 * GEN-081: good_example / avoid entries from the per-message votes of ended games (voteVerdict, Q-286 / Q-287), stored
 * with kind, NPC, scrubbed text and tags, kept in step with votes after the end, capped per game, retrieved by tag
 * for GEN-083, and the good NPC lines handed to GEN-151 as candidates.
 */
const PIM = withLooks({ name: 'พิม', appearance: 'หญิงสาวผมเปียถือตะเกียง', personality: 'ร่าเริง' });
const AT = { day: 1, phase: 'EOSORIA', turn: 1 } as const;

interface Seat {
  token: string;
  memberId: string;
}

describe('GEN-081 good examples + avoid from per-message votes', { timeout: 120_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    server = await startTestServer(tmp.dir);
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  /** A started 4-player game (A owns it); `seats` in join order. */
  async function fourTable(): Promise<{ call: Call; gameId: string; seats: Seat[] }> {
    const call = caller(server!);
    const created = await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm: false, name: 'นก', pin: '1234' } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const game = CreateGameResponse.parse(created.body);
    const owner = { token: game.token, memberId: game.member.id };
    const join = async (name: string) => {
      const res = await call('POST', '/api/join', { body: { inviteCode: game.game.inviteCode, name, pin: '1111' } });
      const joined = JoinResponse.parse(res.body);
      return { token: joined.token, memberId: joined.member.id };
    };
    const seats = [owner, await join('บี'), await join('ซี'), await join('ดี')];
    const identities = [LIN, DARIN, MEKHA, PIM];
    for (const [i, s] of seats.entries()) {
      const res = await call('POST', '/api/game/character', { token: s.token, body: identities[i] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      CharacterResponse.parse(res.body);
      seedChosenLoot(server!.db, s.memberId);
    }
    await readyAll(call, seats);
    return { call, gameId: game.game.id, seats };
  }

  const end = (gameId: string) => savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, CLOCK);
  const refOf = (memberId: string) => (server!.db.prepare('select ref from character_presence where member_id = ?').get(memberId) as { ref: string }).ref;

  /** An AI message to `to` (default everyone); returns its seq. */
  function message(gameId: string, seats: Seat[], text: string, options: { to?: Seat[]; npc?: string } = {}) {
    const meta: EntryMeta | undefined = options.npc ? { npc: { id: options.npc, kind: 'dialogue' } } : undefined;
    return insertEntry(server!.orm, gameId, { kind: options.npc ? 'npc' : 'narration', ...(meta ? { meta } : {}), at: AT, locationId: null, text }, (options.to ?? seats).map((s) => s.memberId), CLOCK).id;
  }

  /** Votes stored as the vote route stores them (`entry-<seq>`). */
  function votes(gameId: string, seq: number, list: { seat: Seat; vote: 'up' | 'down' }[]) {
    for (const { seat, vote } of list) {
      server!.db.prepare("insert into response_vote (game_id, member_id, source_ref, vote, updated_at, reasons) values (?, ?, ?, ?, 0, '[]')").run(gameId, seat.memberId, `entry-${seq}`, vote);
    }
  }
  const ups = (seats: Seat[], n: number) => seats.slice(0, n).map((seat) => ({ seat, vote: 'up' as const }));
  const downs = (seats: Seat[], n: number) => seats.slice(0, n).map((seat) => ({ seat, vote: 'down' as const }));

  const rows = (gameId: string) =>
    (server!.db.prepare("select id, type, source_ref as sourceRef, content, tags, detail, status from learning_entry where source_game_id = ? and type in ('good_example', 'avoid') order by id").all(gameId) as {
      id: number;
      type: string;
      sourceRef: string;
      content: string;
      tags: string;
      detail: string;
      status: string;
    }[]).map((r) => ({ ...r, tags: JSON.parse(r.tags) as string[], detail: JSON.parse(r.detail) as Record<string, unknown> }));

  /** The AI GM's tagging of the player's action this turn (the only part of a proposal learning reads). */
  function tagged(gameId: string, seat: Seat, text: string, verbTags: string[], targetTags: string[] = [], visibility: 'public' | 'secret' = 'public') {
    recordAction(server!.orm, gameId, AT, seat.memberId, { text, visibility, rest: false }, CLOCK);
    const proposal = { gmNote: 'ห้ามหลุด', actions: [{ actionId: 'act-1', actor: refOf(seat.memberId), check: { type: 'dc', dc: 17 }, tagging: { verbTags, targetTags, activate: [] } }] };
    server!.db
      .prepare("insert into gm_turn (game_id, day, phase, turn, status, proposal, rolls, updated_at) values (?, 1, 'EOSORIA', 1, 'applied', ?, '[]', 0) on conflict do update set proposal = excluded.proposal")
      .run(gameId, JSON.stringify(proposal));
    return (server!.db.prepare('select seq from phase_action where game_id = ? and member_id = ?').get(gameId, seat.memberId) as { seq: number }).seq;
  }

  it('C1: a 4-player ended game, a narration 👍3 → 1 good_example kind narration, content without "{{p:"', async () => {
    const { gameId, seats } = await fourTable();
    const seq = message(gameId, seats, `{{p:${refOf(seats[0]!.memberId)}}} เดินเข้าลานตลาดพร้อม ดาริน ท่ามกลางแสงเช้า`);
    votes(gameId, seq, ups(seats, 3));
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    const kept = rows(gameId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ type: 'good_example', sourceRef: `entry-${seq}`, status: 'active', detail: { kind: 'narration', npcId: null, up: 3, down: 0, players: 4 } });
    expect(kept[0]!.content).not.toContain('{{p:');
    expect(kept[0]!.content).not.toContain('ดาริน');
    expect(kept[0]!.content).toContain('ผู้เล่น');
  });

  it('C2 / C3 / C4: 👍2 👎2, no votes, 👍2 + 2 not voting → no entry', async () => {
    const { gameId, seats } = await fourTable();
    votes(gameId, message(gameId, seats, 'เสมอ'), [...ups(seats, 2), ...downs(seats.slice(2), 2)]);
    message(gameId, seats, 'ไม่มีใครกด');
    votes(gameId, message(gameId, seats, 'ครึ่งพอดี'), ups(seats, 2));
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    expect(rows(gameId)).toEqual([]);
  });

  it('C5 / C6: 👎3 of 4 → 1 avoid even in a game averaging 3.00; 👎2 + 2 not voting → none', async () => {
    const { call, gameId, seats } = await fourTable();
    const bad = message(gameId, seats, 'บรรยายยืดยาวน่าเบื่อ');
    votes(gameId, bad, downs(seats, 3));
    votes(gameId, message(gameId, seats, 'ครึ่งพอดี'), downs(seats, 2));
    end(gameId);
    for (const s of seats) expect((await call('PUT', '/api/game/rating', { token: s.token, body: { score: 3 } })).status).toBe(200);
    syncExamples(server!.orm, gameId, CLOCK);
    expect(rows(gameId).map((r) => [r.type, r.sourceRef, r.detail.down])).toEqual([['avoid', `entry-${bad}`, 3]]);
  });

  it('C7: a private message to 1 of 4 players with 👍1 → no entry', async () => {
    const { gameId, seats } = await fourTable();
    votes(gameId, message(gameId, seats, 'กระซิบถึงคนเดียว', { to: [seats[0]!] }), ups(seats, 1));
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    expect(rows(gameId)).toEqual([]);
  });

  it("C8: Malcolm's line 👍3 of 4 → good_example kind dialogue npcId archbishop, one GEN-151 candidate (not twice)", async () => {
    const { gameId, seats } = await fourTable();
    const seq = message(gameId, seats, 'มัลคอล์มยิ้มบาง ๆ "ลูกหลงทางมาไกลนะ"', { npc: 'archbishop' });
    votes(gameId, seq, ups(seats, 3));
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    expect(rows(gameId)).toEqual([expect.objectContaining({ type: 'good_example', detail: expect.objectContaining({ kind: 'dialogue', npcId: 'archbishop', up: 3 }), tags: expect.arrayContaining(['npc']) })]);
    expect(rows(gameId)[0]!.content).not.toContain('มัลคอล์ม');
    expect(npcCandidates(server!.orm)).toEqual([{ gameId, seq, npc: { id: 'archbishop', name: 'อาร์คบิชอป มัลคอล์ม' }, text: rows(gameId)[0]!.content, up: 3 }]);
    expect(server!.styleReview.state().goodCandidates.filter((c) => c.gameId === gameId && c.seq === seq)).toHaveLength(1);
  });

  it('C9: an end-page ruling 👍3 of 4 → good_example kind ruling with dcLabel and no DC number', async () => {
    const { call, gameId, seats } = await fourTable();
    const actor = seats[1]!;
    const seq = tagged(gameId, actor, 'แอบขโมยถุงเงินพ่อค้า 2 ใบ', ['STEAL'], ['NPC'], 'secret');
    insertEntry(server!.orm, gameId, { kind: 'narration', meta: { roll: { d20: 14, difficulty: 'ยาก', outcome: 'success', factors: [] } }, at: AT, locationId: null, text: 'มือคุณเร็วกว่าตา' }, [actor.memberId], CLOCK);
    end(gameId);
    const ref = `1-EOSORIA-1-${seq}`;
    for (const s of seats.slice(0, 3)) {
      const res = await call('PUT', `/api/game/rating/votes/${encodeURIComponent(ref)}`, { token: s.token, body: { vote: 'up' } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const kept = rows(gameId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ type: 'good_example', sourceRef: `ruling-${ref}`, tags: ['steal', 'npc'], detail: { kind: 'ruling', dcLabel: 'ยาก', d20: 14, result: 'success', up: 3, players: 4 } });
    expect(kept[0]!.content).toContain('ยาก');
    expect(kept[0]!.content).not.toContain('17');
    expect(JSON.stringify(kept[0])).not.toMatch(/"dc"|gmNote|ห้ามหลุด/);
  });

  it('C10: building again adds no duplicate', async () => {
    const { gameId, seats } = await fourTable();
    votes(gameId, message(gameId, seats, 'ดีมาก'), ups(seats, 4));
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    syncExamples(server!.orm, gameId, CLOCK);
    expect(rows(gameId)).toHaveLength(1);
  });

  it('C11: votes changing after the end: no longer passing → suspended and not retrieved; passing again → active', async () => {
    const { call, gameId, seats } = await fourTable();
    tagged(gameId, seats[0]!, 'แอบขโมยของ', ['STEAL']);
    const seq = message(gameId, seats, 'ฉากขโมยที่ลุ้นมาก');
    votes(gameId, seq, ups(seats, 3));
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    const query = { tags: ['steal'], sourceGameIds: [gameId], good: 3, avoid: 3 };
    expect(examplesFor(server!.orm, query).good).toHaveLength(1);
    // Two players switch to 👎 through the vote route, which keeps the entries in step.
    for (const s of seats.slice(0, 2)) expect((await call('PUT', `/api/game/entries/${seq}/vote`, { token: s.token, body: { vote: 'down' } })).status).toBe(200);
    expect(rows(gameId).map((r) => r.status)).toEqual(['suspended']);
    expect(examplesFor(server!.orm, query).good).toEqual([]);
    for (const s of seats.slice(0, 2)) expect((await call('PUT', `/api/game/entries/${seq}/vote`, { token: s.token, body: { vote: 'up' } })).status).toBe(200);
    expect(rows(gameId).map((r) => r.status)).toEqual(['active']);
    expect(examplesFor(server!.orm, query).good).toHaveLength(1);
  });

  it('C12: query tags [steal, npc] → good ≤ N and avoid ≤ M, most tags matched first, then most 👍 / 👎', async () => {
    const { gameId, seats } = await fourTable();
    tagged(gameId, seats[0]!, 'แอบขโมยของ', ['STEAL']);
    const both = message(gameId, seats, 'ตาม steal + npc', { npc: 'merchant' }); // a line: npc + the turn's steal
    const stealOnly4 = message(gameId, seats, 'ตาม steal อย่างเดียว');
    votes(gameId, both, ups(seats, 3));
    votes(gameId, stealOnly4, ups(seats, 4));
    const avoid = message(gameId, seats, 'แบบที่ควรเลี่ยง');
    votes(gameId, avoid, downs(seats, 4));
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    const got = examplesFor(server!.orm, { tags: ['steal', 'npc'], sourceGameIds: [gameId], good: 2, avoid: 1 });
    expect(got.good.map((e) => e.sourceRef)).toEqual([`entry-${both}`, `entry-${stealOnly4}`]);
    expect(got.avoid.map((e) => e.sourceRef)).toEqual([`entry-${avoid}`]);
    expect(examplesFor(server!.orm, { tags: ['steal', 'npc'], sourceGameIds: [gameId], good: 1, avoid: 0 }).good.map((e) => e.sourceRef)).toEqual([`entry-${both}`]);
  });

  it('C13: no tag match, N = 0 or no source game → empty lists, no error', async () => {
    const { gameId, seats } = await fourTable();
    tagged(gameId, seats[0]!, 'แอบขโมยของ', ['STEAL']);
    votes(gameId, message(gameId, seats, 'ขโมยเก่ง'), ups(seats, 4));
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    expect(examplesFor(server!.orm, { tags: ['heal'], sourceGameIds: [gameId], good: 3, avoid: 3 })).toEqual({ good: [], avoid: [] });
    expect(examplesFor(server!.orm, { tags: ['steal'], sourceGameIds: [gameId], good: 0, avoid: 0 })).toEqual({ good: [], avoid: [] });
    expect(examplesFor(server!.orm, { tags: ['steal'], sourceGameIds: [], good: 3, avoid: 3 })).toEqual({ good: [], avoid: [] });
    expect(examplesFor(server!.orm, { tags: ['steal'], sourceGameIds: [gameId], good: 3, avoid: 3 }).good).toHaveLength(1);
  });

  it('C14: an entry deleted in the library is not retrieved, and building again does not bring it back', async () => {
    const { gameId, seats } = await fourTable();
    tagged(gameId, seats[0]!, 'แอบขโมยของ', ['STEAL']);
    votes(gameId, message(gameId, seats, 'ขโมยเก่ง'), ups(seats, 4));
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    expect(deleteLearningEntry(server!.orm, rows(gameId)[0]!.id)).toBe(true);
    syncExamples(server!.orm, gameId, CLOCK);
    expect(examplesFor(server!.orm, { tags: ['steal'], sourceGameIds: [gameId], good: 3, avoid: 3 }).good).toEqual([]);
    expect(rows(gameId).filter((r) => r.status === 'active')).toEqual([]);
  });

  it('C15: a game with 25 good messages keeps the 20 with the most 👍', async () => {
    const { gameId, seats } = await fourTable();
    const four: number[] = [];
    for (let i = 0; i < 25; i++) {
      const seq = message(gameId, seats, `ฉากที่ ${i + 1}`);
      if (i >= 20) four.push(seq);
      votes(gameId, seq, ups(seats, i >= 20 ? 4 : 3));
    }
    end(gameId);
    syncExamples(server!.orm, gameId, CLOCK);
    const kept = rows(gameId).filter((r) => r.status === 'active');
    expect(kept).toHaveLength(20);
    for (const seq of four) expect(kept.map((r) => r.sourceRef)).toContain(`entry-${seq}`);
  });
});
