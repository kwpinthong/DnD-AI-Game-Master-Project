import { defaultScenario } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGameData, type GameDataStore } from '../src/assets/game-data.ts';
import { buildGameAssets, readRawDataSets, type GameAssets, type RawDataSets } from '../src/assets/load.ts';
import { withEnglishDrafts, type AbilityRecord, type ItemRecord, type NpcRecord } from '../src/assets/model.ts';
import { openDatabase, type OpenedDatabase } from '../src/db/client.ts';
import { gameDataSet } from '../src/db/schema.ts';
import { lootCatalogue, offerFrom } from '../src/game/loot.ts';
import { estimateTokens, npcToken, type GmWorld } from '../src/gm/context.ts';
import { npcPrompt } from '../src/gm/npc-lines.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { makeTempDir } from './helpers.ts';

// GEN-165: NPC / skill / item rows carry an AI-only English text (loreEn / descriptionEn / effectEn). The prompt reads
// it when filled, the Thai otherwise; real names stay Thai inside it and are swapped for tokens; players never get it.

const MALCOLM = defaultScenario().npcs.find((n) => n.name === 'อาร์คบิชอป มัลคอล์ม')!;
const SHEET_NAME = 'อาร์คบิชอป มัลคอล์ม (ผู้นำนักบวชลัทธิประจำเมือง)';

const seed = () => structuredClone(readRawDataSets()) as RawDataSets & { NPC: NpcRecord[]; Ability: AbilityRecord[]; Item: ItemRecord[] };
const withNpc = (raw: ReturnType<typeof seed>, patch: (n: NpcRecord) => NpcRecord) => ({ ...raw, NPC: raw.NPC.map((n) => (n.name === SHEET_NAME ? patch(n) : n)) });

/** The persona the narration prompt carries for มัลคอล์ม when he is here. */
function personaOf(assets: GameAssets): string | null {
  const n = { id: MALCOLM.id, name: MALCOLM.name, alias: MALCOLM.alias, rank: MALCOLM.rank, locationId: MALCOLM.locationId, names: [MALCOLM.name, ...(MALCOLM.otherNames ?? [])] };
  const world = { gameId: 'g', players: new Map(), byRef: new Map(), npcs: [n], places: [], knownNames: () => new Set(), tokenise: (t: string) => t } as unknown as GmWorld;
  // No members: the bonds (the only DB read) are empty.
  return npcPrompt(undefined as never, assets, world, [n], new Set([n.id]), [])[0]!.persona;
}

describe('GEN-165 English game data for the AI', () => {
  it('C1: the persona is the NPC\'s loreEn when filled, the Thai lore when not', () => {
    const raw = seed();
    const thai = raw.NPC.find((n) => n.name === SHEET_NAME)!.lore;
    const english = buildGameAssets(withNpc(raw, (n) => ({ ...n, loreEn: 'A kind archbishop who hands out bread on day 1.' })));
    expect(personaOf(english)).toBe('A kind archbishop who hands out bread on day 1.');
    const { loreEn: _none, ...rest } = raw.NPC.find((n) => n.name === SHEET_NAME)!;
    expect(personaOf(buildGameAssets(withNpc(raw, () => rest)))).toBe(thai);
    // A blank loreEn ("" or spaces) falls back to the Thai too.
    expect(personaOf(buildGameAssets(withNpc(raw, (n) => ({ ...n, loreEn: '  ' }))))).toBe(thai);
  });

  it('C1: the loot catalogue reads descriptionEn / effectEn when filled, the Thai when not', () => {
    const raw = seed();
    const skill = raw.Ability.find((a) => a.rank === 'B')!;
    const item = raw.Item.find((i) => i.rank === 'B')!;
    const english = buildGameAssets({
      ...raw,
      Ability: raw.Ability.map((a) => (a === skill ? { ...a, descriptionEn: 'SKILL-EN-TEXT' } : a)),
      Item: raw.Item.map((i) => (i === item ? { ...i, effectEn: 'ITEM-EN-TEXT' } : i)),
    });
    expect(lootCatalogue(english)).toContain(`skill: ${skill.name} |`);
    expect(lootCatalogue(english)).toMatch(new RegExp(`${skill.name} \\|.*\\| SKILL-EN-TEXT`));
    expect(lootCatalogue(english)).toMatch(new RegExp(`${item.nameEn} \\|.*\\| ITEM-EN-TEXT`));
    const thai = buildGameAssets({
      ...raw,
      Ability: raw.Ability.map(({ descriptionEn: _d, ...a }) => a),
      Item: raw.Item.map(({ effectEn: _e, ...i }) => i),
    });
    expect(lootCatalogue(thai)).toContain(skill.description.replace(/\s+/g, ' ').trim());
  });

  it('C2: a real name inside loreEn becomes the NPC token, as in the Thai lore', () => {
    const raw = seed();
    const assets = buildGameAssets(withNpc(raw, (n) => ({ ...n, loreEn: 'มัลคอล์ม is a kind archbishop; อาร์คบิชอป มัลคอล์ม hands out bread. Truly มัลคอล์ม ผู้ทรงศาสตราแห่งเงามืด.' })));
    const persona = personaOf(assets)!;
    expect(persona).toContain(`${npcToken(MALCOLM.id)} is a kind archbishop`);
    expect(persona).not.toContain('มัลคอล์ม');
  });

  it('C3: what a player gets never holds the English fields (Thai description in the loot offer; the keys are forbidden)', () => {
    const raw = seed();
    const skill = raw.Ability.find((a) => a.rank === 'B')!;
    const item = raw.Item.find((i) => i.rank === 'B')!;
    const assets = buildGameAssets({
      ...raw,
      Ability: raw.Ability.map((a) => (a === skill ? { ...a, descriptionEn: 'SKILL-EN-TEXT' } : a)),
      Item: raw.Item.map((i) => (i === item ? { ...i, effectEn: 'ITEM-EN-TEXT' } : i)),
    });
    const trait = { label: 'กล้า', scope: 'general', description: 'ใจสู้' };
    const offer = offerFrom({ strength: trait, weakness: trait, skills: [skill.name], items: [item.nameEn] }, assets);
    expect(offer.ok).toBe(true);
    if (!offer.ok) return;
    expect(offer.offer.skills[0]!.description).toBe(skill.description);
    expect(offer.offer.items[0]!.description).toBe(item.effect);
    expect(JSON.stringify(offer.offer)).not.toMatch(/EN-TEXT/);
    // The visibility scan (every HTTP route, every socket frame) refuses these keys anywhere in a player's payload.
    expect(forbiddenKeysIn({ a: [{ loreEn: '' }, { descriptionEn: '' }, { effectEn: '' }] })).toEqual(['a.0.loreEn', 'a.1.descriptionEn', 'a.2.effectEn']);
  });

  describe('the DB (GEN-147 store)', () => {
    let dir = '';
    let cleanup = () => {};
    let opened: OpenedDatabase;
    const open = (raw: RawDataSets): GameDataStore =>
      openGameData(opened.db, raw, { backupDir: join(dir, 'backups'), now: () => 1_000, assetsDir: join(dir, 'assets'), log: () => {} });

    beforeEach(() => {
      ({ dir, cleanup } = makeTempDir());
      opened = openDatabase(join(dir, 'isekai.sqlite'));
    });
    afterEach(() => {
      opened.sqlite.close();
      cleanup();
    });

    it('C4: an admin edit of loreEn reaches the next prompt and is in the audit log', () => {
      const store = open(seed());
      const npcs = store.get('NPC')!.value as NpcRecord[];
      const saved = store.save('NPC', npcs.map((n) => (n.name === SHEET_NAME ? { ...n, loreEn: 'Edited by the owner.' } : n)));
      expect(saved).toEqual({ ok: true });
      expect(personaOf(store.assets)).toBe('Edited by the owner.');
      const [entry] = store.audit();
      expect(entry).toMatchObject({ name: 'NPC', action: 'edit' });
      expect(entry!.changes.map((c) => (c.new as NpcRecord).loreEn)).toEqual(['Edited by the owner.']);
    });

    it('C5: an old DB (rows without English fields) keeps its data and gets only the drafts it lacks, never over an edit', () => {
      const full = seed();
      const old = structuredClone(full);
      // The DB as GEN-147 seeded it before GEN-165: no English keys anywhere, plus two owner edits.
      old.NPC = old.NPC.map(({ loreEn: _l, ...n }) => (n.name === SHEET_NAME ? { ...n, lore: 'ลอร์ที่นกแก้ไว้' } : n));
      old.Ability = old.Ability.map(({ descriptionEn: _d, ...a }) => a);
      old.Item = old.Item.map(({ effectEn: _e, ...i }) => i);
      const cleared = old.NPC.findIndex((n) => n.name !== SHEET_NAME);
      old.NPC[cleared] = { ...old.NPC[cleared]!, loreEn: '' };
      const mine = old.NPC.findIndex((n, i) => i !== cleared && n.name !== SHEET_NAME);
      old.NPC[mine] = { ...old.NPC[mine]!, loreEn: 'My own English.' };
      open(old);
      opened.sqlite.close();
      opened = openDatabase(join(dir, 'isekai.sqlite'));

      const store = open(full);
      const npcs = store.get('NPC')!.value as NpcRecord[];
      // Old data is all there (the owner's Thai edit too).
      expect(npcs.map(({ loreEn: _l, ...n }) => n)).toEqual(old.NPC.map(({ loreEn: _l, ...n }) => n));
      expect(npcs.find((n) => n.name === SHEET_NAME)!.loreEn).toBe(full.NPC.find((n) => n.name === SHEET_NAME)!.loreEn);
      expect(npcs[cleared]!.loreEn).toBe('');
      expect(npcs[mine]!.loreEn).toBe('My own English.');
      expect((store.get('Ability')!.value as AbilityRecord[]).every((a) => (a.descriptionEn ?? '').length > 0)).toBe(true);
      // Logged (and undoable) as an edit of each set it touched.
      expect(store.audit().map((e) => e.name).sort()).toEqual(['Ability', 'Item', 'NPC']);
      // A second start changes nothing.
      const rows = opened.db.select().from(gameDataSet).all();
      open(full);
      expect(opened.db.select().from(gameDataSet).all()).toEqual(rows);
    });
  });

  it('C5: a sheet import keeps the English drafts of the file it replaces (the sheet has no English columns)', () => {
    const file = [{ name: 'ก', lore: 'เก่า', loreEn: 'old en' }, { name: 'ข', lore: 'x', loreEn: '' }];
    const imported = [{ name: 'ก', lore: 'ใหม่' }, { name: 'ข', lore: 'y' }, { name: 'ค', lore: 'z' }];
    expect(withEnglishDrafts('NPC', imported, file)).toEqual([
      { name: 'ก', lore: 'ใหม่', loreEn: 'old en' },
      { name: 'ข', lore: 'y', loreEn: '' },
      { name: 'ค', lore: 'z' },
    ]);
    expect(withEnglishDrafts('Location', imported, file)).toBe(imported);
  });

  it('C6: every NPC / skill / item has an English draft, and the AI text it replaces shrinks (estimate, no AI call)', () => {
    const raw = seed();
    for (const n of raw.NPC) expect(n.loreEn, n.name).toMatch(/\S/);
    for (const a of raw.Ability) expect(a.descriptionEn, a.name).toMatch(/\S/);
    for (const i of raw.Item) expect(i.effectEn, i.nameEn).toMatch(/\S/);
    const tokens = (texts: string[]) => texts.reduce((sum, t) => sum + estimateTokens(t), 0);
    const before = tokens([...raw.NPC.map((n) => n.lore), ...raw.Ability.map((a) => a.description), ...raw.Item.map((i) => i.effect)]);
    const after = tokens([...raw.NPC.map((n) => n.loreEn!), ...raw.Ability.map((a) => a.descriptionEn!), ...raw.Item.map((i) => i.effectEn!)]);
    expect(after).toBeLessThan(before);
  });
});
