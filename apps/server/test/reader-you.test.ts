import { appearanceParts, type AppearanceTraits } from '@isekai/protocol';
import { socialTitle } from '@isekai/rules';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { character } from '../src/db/schema.ts';
import { youInText } from '../src/game/tokens.ts';
import { NARRATOR_BLOCK, loadWorld, type GmWorld } from '../src/gm/context.ts';
import { finaleEntries } from '../src/gm/finale.ts';
import { renderTokens } from '../src/gm/loop.ts';
import { entryViewOf } from '../src/room/entry-view.ts';
import { insertEntry } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir, seedAppearanceLabels } from './helpers.ts';
import { isReady, openRoom } from './room-client.ts';
import { LIN, startedTable, startTestServer } from './visibility-fixture.ts';

/** ISK-008: what a player reads calls them "คุณ" everywhere, not by their looks or their title. */
const A = { appearance: 'ผมดำยาว', title: 'นักเดินทางเงียบ', parts: [] as string[] };
const B = { appearance: 'ชายร่างสูงสวมเกราะ', title: 'คนแปลกหน้า' };

describe('ISK-008 the reader is "คุณ"', () => {
  const people = {
    npcs: [],
    byRef: new Map([
      ['a', { memberId: 'm-a', name: 'อาริน', socialTitle: A.title }],
      ['b', { memberId: 'm-b', name: 'บี', socialTitle: B.title }],
    ]),
    knownNames: (r: string) => (r === 'm-knows' ? new Set(['m-a']) : new Set<string>()),
  } as unknown as GmWorld;
  const render = (t: string, reader: string | null, shared = false) => renderTokens(null as never, people, t, reader, shared);

  it('C1: {{p:A}} in a narration to A is "คุณ"', () => {
    expect(render('{{p:a}} กวาดสายตามอง', 'm-a')).toBe('คุณกวาดสายตามอง');
  });

  it('C2: A\'s own look written as text in what A reads is "คุณ"', () => {
    expect(youInText('ทหารหันไปมองผมดำยาว', A, [B])).toBe('ทหารหันไปมองคุณ');
    expect(youInText('ทหารหันไปมอง ผมดำยาว อย่างสงสัย', A, [B])).toBe('ทหารหันไปมองคุณอย่างสงสัย');
  });

  it('C3: A\'s title in what A reads is "คุณ"', () => {
    expect(youInText('ชาวบ้านมอง นักเดินทางเงียบ ด้วยความสงสัย', A, [B])).toBe('ชาวบ้านมองคุณด้วยความสงสัย');
    expect(youInText('นักเดินทางเงียบ เดินเข้ามา', A, [B])).toBe('คุณเดินเข้ามา');
    // Social Titles are everyday words: with a word attached after it, it may be someone else (an NPC) and stays.
    const solo = { appearance: 'ผมดำยาว', title: 'คนแปลกหน้า', parts: [] };
    expect(youInText('คนแปลกหน้าในชุดคลุมดำเดินเข้ามา', solo, [])).toBe('คนแปลกหน้าในชุดคลุมดำเดินเข้ามา');
    expect(youInText('ยามจ้องคนแปลกหน้า', solo, [])).toBe('ยามจ้องคุณ');
  });

  it('C4: B reading the place feed sees A\'s title / look; B who knows A sees the name', () => {
    expect(render('{{p:a}} เดินผ่านตลาด', 'm-b', true)).toBe('นักเดินทางเงียบ เดินผ่านตลาด');
    // B's own text is not about A: A's look stays.
    expect(youInText('ผมดำยาวเดินผ่านตลาด', { ...B, parts: [] }, [A])).toBe('ผมดำยาวเดินผ่านตลาด');
    expect(render('{{p:a}} เดินผ่านตลาด', 'm-knows', true)).toBe('อาริน เดินผ่านตลาด');
    // A reading the same feed: their own token is "คุณ".
    expect(render('{{p:a}} เดินผ่านตลาด', 'm-a')).toBe('คุณเดินผ่านตลาด');
  });

  it('C5: words inside quotes (what someone says) are never replaced', () => {
    expect(youInText('ทหารตะโกน "ผมดำยาวคนนั้นมาแล้ว" แล้วชี้มาที่ผมดำยาว', A, [B])).toBe('ทหารตะโกน "ผมดำยาวคนนั้นมาแล้ว" แล้วชี้มาที่คุณ');
    expect(youInText('เขาพึมพำ “นักเดินทางเงียบอีกแล้ว”', A, [B])).toBe('เขาพึมพำ “นักเดินทางเงียบอีกแล้ว”');
    expect(youInText('ชายแก่บอก "ผมจะไปตลาด"', A, [B])).toBe('ชายแก่บอก "ผมจะไปตลาด"');
  });

  it('C6 (Q-379 A): each chip part of A\'s look is "คุณ", unless someone else has it or a word is attached after it', () => {
    const traits: AppearanceTraits = { hairColor: 'black', hairStyle: 'long', eyes: 'blue', build: 'tall', outfit: 'traveler', feature: 'scar' };
    const parts = appearanceParts(traits, seedAppearanceLabels());
    expect(parts).toEqual(['ผมยาวสีดำ', 'ดวงตาสีฟ้า', 'รูปร่างผอมสูง', 'สวมชุดเดินทาง', 'มีแผลเป็นที่แก้ม']);
    const me = { appearance: parts.join(' '), title: 'นักเดินทางเงียบ', parts };
    const other = { appearance: 'ผมสั้นสีทอง ดวงตาสีฟ้า รูปร่างล่ำสัน สวมเกราะหนัง', title: 'คนแปลกหน้า' };
    expect(youInText('ยามมองผมยาวสีดำ', me, [other])).toBe('ยามมองคุณ');
    expect(youInText('ยามมอง ผมยาวสีดำ แล้วหันหนี', me, [other])).toBe('ยามมองคุณแล้วหันหนี');
    expect(youInText('ยามหันไปหาสวมชุดเดินทาง.', me, [other])).toBe('ยามหันไปหาคุณ.');
    // Someone else has this part: it may be them.
    expect(youInText('ยามมองดวงตาสีฟ้า', me, [other])).toBe('ยามมองดวงตาสีฟ้า');
    // A word attached right after it: a description, not the person.
    expect(youInText('ผมยาวสีดำสลวยปลิวไหว', me, [other])).toBe('ผมยาวสีดำสลวยปลิวไหว');
    // The whole sentence still goes in one piece.
    expect(youInText(`ยามมอง${me.appearance}`, me, [other])).toBe('ยามมองคุณ');
  });

  it('C7: A and C look the same: the look stays as text, {{p:A}} is still "คุณ"', () => {
    const C = { appearance: 'ผมดำยาว', title: 'คนแปลกหน้า' };
    expect(youInText('ทหารหันไปมองผมดำยาว', A, [B, C])).toBe('ทหารหันไปมองผมดำยาว');
    expect(render('{{p:a}} กวาดสายตามอง', 'm-a')).toBe('คุณกวาดสายตามอง');
    // Same for a title two players share.
    expect(youInText('ชาวบ้านมองนักเดินทางเงียบ', A, [{ ...B, title: A.title }])).toBe('ชาวบ้านมองนักเดินทางเงียบ');
  });

  it('C9: the narration prompt asks for the player token always, never the look / title in its place', () => {
    expect(NARRATOR_BLOCK.text).toContain('never their looks or title in place of the token');
    expect(NARRATOR_BLOCK.text).not.toContain('write คุณ)');
  });
});

describe('ISK-008 C8: history, replay and the ending read like live', { timeout: 60_000 }, () => {
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

  it('A reads "คุณ" for their look in a narration and a feed (stored raw); B reads the look; the ending names A "คุณ" to A', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    const db = server.orm;
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    const at = { day: 1, phase: 'SOLARION' as const, turn: 1 as const };
    const raw = `ทหารหันไปมอง${LIN.appearance}`;
    const narration = insertEntry(db, gameId, { kind: 'narration', at, locationId: null, text: raw }, [t.a.memberId], 1);
    const feed = insertEntry(db, gameId, { kind: 'feed', at, locationId: null, text: raw }, [t.a.memberId, t.b.memberId], 1);
    const viewOf = (row: typeof feed, memberId: string) => entryViewOf(db, row, { id: memberId, role: 'player' }, server!.assets).text;

    // Stored raw, replaced per reader when read.
    expect(narration.text).toBe(raw);
    expect(viewOf(narration, t.a.memberId)).toBe('ทหารหันไปมองคุณ');
    expect(viewOf(feed, t.a.memberId)).toBe('ทหารหันไปมองคุณ');
    expect(viewOf(feed, t.b.memberId)).toBe(raw);
    expect(entryViewOf(db, feed, { id: 'gm', role: 'gm' }, server.assets).text).toBe(raw);

    // History (GET /api/game/log) and the reconnect replay go through the same view.
    const log = await t.call('GET', '/api/game/log', { token: t.a.token });
    expect((log.body as { entries: { seq: number; text: string }[] }).entries.find((e) => e.seq === feed.id)?.text).toBe('ทหารหันไปมองคุณ');
    const logB = await t.call('GET', '/api/game/log', { token: t.b.token });
    expect((logB.body as { entries: { seq: number; text: string }[] }).entries.find((e) => e.seq === feed.id)?.text).toBe(raw);
    const room = await openRoom(server, { token: t.a.token });
    await room.waitFor(isReady);
    expect(room.entries().find((e) => e.seq === narration.id)?.text).toBe('ทหารหันไปมองคุณ');
    await room.close();

    // The ending: A's own token is "คุณ" in A's ending; B's ending names A (every secret is out).
    const world = loadWorld(db, gameId, server.assets);
    const refOf = (memberId: string) => [...world.byRef].find(([, p]) => p.memberId === memberId)![0];
    const [ra, rb] = [refOf(t.a.memberId), refOf(t.b.memberId)];
    const entries = finaleEntries(db, server.assets, gameId, {
      overall: 'เมืองรอดพ้น',
      players: [
        { player: ra, text: `{{p:${ra}}} ยืนมองฟ้า` },
        { player: rb, text: `{{p:${rb}}} เดินไปหา {{p:${ra}}}` },
      ],
    });
    expect(entries.find((e) => e.kind === 'narration' && e.memberId === t.a.memberId)?.text).toBe('คุณยืนมองฟ้า');
    expect(entries.find((e) => e.kind === 'narration' && e.memberId === t.b.memberId)?.text).toBe(`คุณเดินไปหา ${LIN.name}`);
  });

  it('A whose look the title also shares is not replaced; a player entry (someone else\'s words) never is', async () => {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    const db = server.orm;
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    const at = { day: 1, phase: 'SOLARION' as const, turn: 1 as const };
    // Every fixture player starts with the same title: it may be any of them.
    const title = socialTitle(0);
    expect(db.select().from(character).where(eq(character.memberId, t.a.memberId)).get()?.initialTitle ?? null).toBeNull();
    const feed = insertEntry(db, gameId, { kind: 'feed', at, locationId: null, text: `${title} เดินผ่าน` }, [t.a.memberId], 1);
    expect(entryViewOf(db, feed, { id: t.a.memberId, role: 'player' }, server.assets).text).toBe(`${title} เดินผ่าน`);
    const said = insertEntry(db, gameId, { kind: 'player', at, locationId: null, text: `ชี้ไปที่${LIN.appearance}`, meta: { actor: t.b.memberId } }, [t.a.memberId], 1);
    expect(entryViewOf(db, said, { id: t.a.memberId, role: 'player' }, server.assets).text).toBe(`ชี้ไปที่${LIN.appearance}`);
  });
});
