import type { ActionOutcome } from '@isekai/rules';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameAssets } from '../src/assets/load.ts';
import { migrationsFolder, openDatabase, type OpenedDatabase } from '../src/db/client.ts';
import type { GmWorld } from '../src/gm/context.ts';
import { MEMORY_LIMITS, npcMemoriesOf, recordNpcMemories } from '../src/gm/npc-memory.ts';
import { npcPrompt } from '../src/gm/npc-lines.ts';
import { makeTempDir } from './helpers.ts';

/**
 * GEN-146: NPC memory. One line per event that involves an NPC, made from the resolve result (no AI call);
 * the newest few of an NPC + player pair go into the narration / dialogue context.
 */

const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };

describe('migration npc_memory (GEN-146)', () => {
  it('is additive: no DROP, DELETE or ALTER … DROP', () => {
    const entry = journal.entries.find((e) => e.tag.endsWith('_npc_memory'));
    expect(entry).toBeDefined();
    const code = readFileSync(join(migrationsFolder, `${entry!.tag}.sql`), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b/i);
  });
});

const ARON = { memberId: 'm1', ref: 'p1', name: 'อารอน', appearance: 'ชายหนุ่มผมดำสวมเสื้อคลุมสีเทา', socialTitle: 'นักเดินทาง', locationId: 'market' };
const BEA = { memberId: 'm2', ref: 'p2', name: 'เบียทริซ', appearance: 'หญิงสาวผมแดงถือไม้เท้า', socialTitle: 'นักเวท', locationId: 'market' };
const world = {
  gameId: 'g1',
  players: new Map([ARON, BEA].map((p) => [p.memberId, p])),
  byRef: new Map([ARON, BEA].map((p) => [p.ref, p])),
  npcs: [
    { id: 'malcolm', name: 'มัลคอล์ม', alias: 'คนทำขนมปัง', rank: 'C', locationId: 'market', names: ['มัลคอล์ม'] },
    { id: 'lucia', name: 'ลูเซีย', alias: 'หญิงสาว', rank: 'B', locationId: 'temple', names: ['ลูเซีย'] },
    { id: 'guard', name: 'การ์เร็ต', alias: 'ทหารยาม', rank: 'C', locationId: 'market', names: ['การ์เร็ต'] },
  ],
  places: [],
  knownNames: () => new Set<string>(),
  tokenise: (t: string) => t.split('อารอน').join('{{p:p1}}').split('เบียทริซ').join('{{p:p2}}').split('มัลคอล์ม').join('{{n:malcolm}}'),
} as unknown as GmWorld;

const noEffects = { before: 0, delta: 0, after: 0 };
/** A resolved action of `actorId` at the market (both players there), aimed at `npc`. */
function outcome(o: {
  actorId?: string;
  npc?: string | null;
  degree?: 'crit' | 'success' | 'fail' | 'fumble';
  visibility?: 'public' | 'secret';
  check?: boolean;
  caught?: boolean;
  observer?: string | null;
  affinity?: { npcId: string; delta: number }[];
  npcDamage?: number;
  actionId?: string;
}): ActionOutcome {
  return {
    status: 'resolved',
    actionId: o.actionId ?? 'act-1',
    actorId: o.actorId ?? 'm1',
    visibility: o.visibility ?? 'public',
    locationId: 'market',
    locations: { m1: 'market', m2: 'market' },
    target: null,
    moved: null,
    log: {
      input: { proposal: { target: o.npc === null ? null : { npc: o.npc ?? 'malcolm' } } },
      check: o.check === false ? null : { total: 12 },
      degree: o.degree ?? 'success',
      caught: o.caught ?? false,
      observation: o.observer ? { npcId: o.observer, d20: 15, total: 18 } : null,
      affinity: (o.affinity ?? []).map((a) => ({ npcId: a.npcId, before: 0, delta: a.delta, after: a.delta })),
      hp: { actor: { before: 10, damage: 0, heal: 0, after: 10 }, target: o.npcDamage ? { npcId: o.npc ?? 'malcolm', before: 10, damage: o.npcDamage, heal: 0, after: 10 - o.npcDamage } : null },
      rep: noEffects,
      karma: noEffects,
    },
  } as unknown as ActionOutcome;
}

describe('GEN-146 NPC memory', () => {
  let dir = '';
  let cleanup = () => {};
  let opened: OpenedDatabase;

  const open = () => {
    opened = openDatabase(join(dir, 'isekai.sqlite'));
    opened.sqlite.pragma('foreign_keys = OFF');
  };
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    open();
  });
  afterEach(() => {
    opened.sqlite.close();
    cleanup();
  });

  const rows = () => opened.sqlite.prepare('select npc_id, member_id, day, phase, text, weight, witnesses from npc_memory order by id').all() as {
    npc_id: string;
    member_id: string;
    day: number;
    phase: string;
    text: string;
    weight: string;
    witnesses: string;
  }[];
  const record = (outcomes: ActionOutcome[], summaries: Record<string, string>, day = 1, phase: 'EOSORIA' | 'SOLARION' | 'HESPERION' | 'NOCTHERION' = 'EOSORIA') =>
    recordNpcMemories(opened.db, world, outcomes, new Map(Object.entries(summaries)), { day, phase }, 1);
  const bond = (memberId: string, npcId: string, o: { affinity?: number; revealed?: boolean; companion?: number | null } = {}) =>
    opened.sqlite
      .prepare('insert into npc_bond (member_id, npc_id, affinity, name_revealed, updated_at, companion_seq) values (?, ?, ?, ?, 1, ?)')
      .run(memberId, npcId, o.affinity ?? 0, o.revealed ? 1 : 0, o.companion ?? null);

  it('C1: taking bread from Malcolm on day 1 morning leaves one line for Malcolm + that player, with the players who saw it', () => {
    record([outcome({})], { 'act-1': 'หยิบขนมปังของ {{n:malcolm}}' });
    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ npc_id: 'malcolm', member_id: 'm1', day: 1, phase: 'EOSORIA', weight: 'normal' });
    expect(row!.text).toContain('หยิบขนมปังของ {{n:malcolm}}');
    expect(JSON.parse(row!.witnesses)).toEqual(['m2']);
  });

  it('an action that involves no NPC leaves no line', () => {
    record([outcome({ npc: null })], { 'act-1': 'เดินดูตลาด' });
    expect(rows()).toEqual([]);
  });

  it('C2: meeting him again, the context has at most 5 lines of the pair, newest first, within the token limit', () => {
    for (let turn = 1; turn <= 7; turn++) record([outcome({})], { 'act-1': `ซื้อขนมปังครั้งที่ ${turn}` }, 1, turn <= 4 ? 'EOSORIA' : 'SOLARION');
    const lines = npcMemoriesOf(opened.db, 'g1', 'm1', 'malcolm');
    expect(lines).toHaveLength(MEMORY_LIMITS.perPair);
    expect(lines[0]).toContain('ครั้งที่ 7');
    expect(lines[4]).toContain('ครั้งที่ 3');

    // What the narration / dialogue AI is given for the NPC here: the same lines on the bond of the pair.
    const assets = { npc: () => undefined } as unknown as GameAssets;
    const [malcolm] = npcPrompt(opened.db, assets, world, [world.npcs[0]!], new Set(['malcolm']), ['m1', 'm2']);
    expect(malcolm!.bonds.find((b) => b.player === 'p1')!.memories).toEqual(lines);
    // Nothing for a player with no memory of him (the key is left out, not an empty list).
    expect(malcolm!.bonds.find((b) => b.player === 'p2')).not.toHaveProperty('memories');
  });

  it('C2: a pair of long lines stays within the token limit', () => {
    for (let turn = 1; turn <= 5; turn++) record([outcome({})], { 'act-1': 'ก'.repeat(190) });
    const lines = npcMemoriesOf(opened.db, 'g1', 'm1', 'malcolm');
    expect(lines.join('').length).toBeLessThanOrEqual(MEMORY_LIMITS.pairTokens);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('C3: an important event reaches the NPCs close to the player too; a normal one does not', () => {
    bond('m1', 'lucia', { affinity: 30 });
    bond('m1', 'guard', { affinity: 0 });
    record([outcome({ actionId: 'act-1' })], { 'act-1': 'ซื้อขนมปัง' });
    expect(rows().map((r) => r.npc_id)).toEqual(['malcolm']);

    record([outcome({ actionId: 'act-2', npcDamage: 5, degree: 'success' })], { 'act-2': 'ต่อย {{n:malcolm}}' }, 1, 'SOLARION');
    const hit = rows().filter((r) => r.text.includes('ต่อย'));
    expect(hit.map((r) => [r.npc_id, r.weight])).toEqual([
      ['malcolm', 'important'],
      ['lucia', 'important'],
    ]);
    expect(npcMemoriesOf(opened.db, 'g1', 'm1', 'lucia')[0]).toContain('ต่อย');
  });

  it('C3: a big affinity swing is important; a companion is close whatever the affinity', () => {
    bond('m1', 'guard', { affinity: -5, companion: 1 });
    record([outcome({ affinity: [{ npcId: 'malcolm', delta: -10 }] })], { 'act-1': 'ดูถูก {{n:malcolm}}' });
    expect(rows().map((r) => [r.npc_id, r.weight])).toEqual([
      ['malcolm', 'important'],
      ['guard', 'important'],
    ]);
  });

  it('C4: a Secret action nobody saw leaves no line; one a witness caught is remembered by that witness and the target only', () => {
    record([outcome({ visibility: 'secret' })], { 'act-1': 'ล้วงกระเป๋า {{n:malcolm}}' });
    expect(rows()).toEqual([]);

    record([outcome({ visibility: 'secret', caught: true, observer: 'guard' })], { 'act-1': 'ล้วงกระเป๋า {{n:malcolm}}' }, 1, 'SOLARION');
    expect(rows().map((r) => r.npc_id).sort()).toEqual(['guard', 'malcolm']);
    // Nobody else watched a Secret: no player witnesses.
    for (const r of rows()) expect(JSON.parse(r.witnesses)).toEqual([]);
    expect(rows().every((r) => r.weight === 'important')).toBe(true);
  });

  it('C4: a Secret action has no NPC line spread to the player\'s close NPCs when nobody saw it', () => {
    bond('m1', 'lucia', { affinity: 50 });
    record([outcome({ visibility: 'secret', npcDamage: 5 })], { 'act-1': 'แทง {{n:malcolm}} ในความมืด' });
    expect(rows()).toEqual([]);
  });

  it('C5: not acquainted, the line names the player by how they look, never the real name or token; acquainted, by token', () => {
    record([outcome({})], { 'act-1': 'อารอน หยิบขนมปังของ {{n:malcolm}}' });
    const stranger = rows()[0]!.text;
    expect(stranger).toContain('ชายหนุ่มผมดำ');
    expect(stranger).not.toContain('อารอน');
    expect(stranger).not.toContain('{{p:p1}}');

    bond('m1', 'malcolm', { revealed: true });
    record([outcome({})], { 'act-1': '{{p:p1}} หยิบขนมปังของ {{n:malcolm}}' }, 1, 'SOLARION');
    const known = rows()[1]!.text;
    expect(known).toContain('{{p:p1}}');
    expect(known).not.toContain('อารอน');
  });

  it('C5: another player named in the line is also by look when the NPC does not know them', () => {
    record([outcome({})], { 'act-1': 'ช่วย {{p:p2}} ซื้อขนมปังจาก {{n:malcolm}}' });
    const text = rows()[0]!.text;
    expect(text).toContain('หญิงสาวผมแดง');
    expect(text).not.toContain('{{p:p2}}');
    expect(text).not.toContain('เบียทริซ');
  });

  it('C6: normal lines more than 2 game days old fold into one summary line; important ones stay', () => {
    record([outcome({ actionId: 'a' }), outcome({ actionId: 'b', npcDamage: 3 })], { a: 'ซื้อขนมปัง', b: 'ผลัก {{n:malcolm}}' }, 1);
    record([outcome({ actionId: 'c' })], { c: 'ชมขนมปัง' }, 1, 'SOLARION');
    record([outcome({ actionId: 'd' })], { d: 'ถามทาง' }, 3);
    expect(rows().filter((r) => r.weight === 'summary')).toEqual([]);

    record([outcome({ actionId: 'e' })], { e: 'ทักทาย' }, 4);
    const after = rows();
    const summary = after.filter((r) => r.weight === 'summary');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.text).toContain('ซื้อขนมปัง');
    expect(summary[0]!.text).toContain('ชมขนมปัง');
    expect(after.filter((r) => r.weight === 'normal' && r.day === 1)).toEqual([]);
    expect(after.filter((r) => r.weight === 'important').map((r) => r.day)).toEqual([1]);
    // Day 3 is 1 day old on day 4: kept as it is.
    expect(after.some((r) => r.weight === 'normal' && r.text.includes('ถามทาง'))).toBe(true);

    // A later fold adds to the same summary line.
    record([outcome({ actionId: 'f' })], { f: 'เดินผ่าน' }, 6);
    const again = rows().filter((r) => r.weight === 'summary');
    expect(again).toHaveLength(1);
    expect(again[0]!.text).toContain('ซื้อขนมปัง');
    expect(again[0]!.text).toContain('ถามทาง');
  });

  it('C7: two players acting differently toward one NPC keep separate memories', () => {
    record([outcome({ actorId: 'm1', actionId: 'act-1' }), outcome({ actorId: 'm2', actionId: 'act-2', affinity: [{ npcId: 'malcolm', delta: 3 }] })], {
      'act-1': 'ขโมยขนมปัง',
      'act-2': 'ช่วยนวดแป้ง',
    });
    const aron = npcMemoriesOf(opened.db, 'g1', 'm1', 'malcolm');
    const bea = npcMemoriesOf(opened.db, 'g1', 'm2', 'malcolm');
    expect(aron).toHaveLength(1);
    expect(aron[0]).toContain('ขโมยขนมปัง');
    expect(bea).toHaveLength(1);
    expect(bea[0]).toContain('ช่วยนวดแป้ง');
  });

  it('C8: the memories are the same after the database is closed and opened again', () => {
    record([outcome({})], { 'act-1': 'หยิบขนมปังของ {{n:malcolm}}' });
    const before = npcMemoriesOf(opened.db, 'g1', 'm1', 'malcolm');
    opened.sqlite.close();
    open();
    expect(npcMemoriesOf(opened.db, 'g1', 'm1', 'malcolm')).toEqual(before);
    expect(before).toHaveLength(1);
  });
});
