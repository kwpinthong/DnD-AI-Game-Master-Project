import { defaultScenario } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type OpenedDatabase } from '../src/db/client.ts';
import { game } from '../src/db/schema.ts';
import { copyTemplateForGame, getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import { makeTempDir } from './helpers.ts';

describe('per-game scenario copy', () => {
  let opened: OpenedDatabase;
  let cleanup = () => {};

  const insertGame = (id: string) =>
    opened.db.insert(game).values({ id, inviteCode: `CODE-${id}`, createdAt: Date.now() }).run();

  beforeEach(() => {
    const temp = makeTempDir();
    cleanup = temp.cleanup;
    opened = openDatabase(join(temp.dir, 'isekai.sqlite'));
    insertGame('game-a');
    insertGame('game-b');
  });

  afterEach(() => {
    opened.sqlite.close();
    cleanup();
  });

  // C5
  it('C5: editing one game copy leaves the default template and other games unchanged', () => {
    const template = defaultScenario();
    copyTemplateForGame(opened.db, 'game-a');
    copyTemplateForGame(opened.db, 'game-b');

    const edited = getGameScenario(opened.db, 'game-a')!;
    edited.timeline[0]!.title = 'นักบวชลัทธิแจกซุปแทนขนมปัง';
    edited.npcs[0]!.name = 'ชื่อที่ GM ตั้ง';
    const result = updateGameScenario(opened.db, 'game-a', edited);
    expect(result.ok).toBe(true);

    expect(getGameScenario(opened.db, 'game-a')?.timeline[0]?.title).toBe('นักบวชลัทธิแจกซุปแทนขนมปัง');
    expect(getGameScenario(opened.db, 'game-a')?.npcs[0]?.name).toBe('ชื่อที่ GM ตั้ง');
    expect(getGameScenario(opened.db, 'game-b')).toEqual(template);
    expect(defaultScenario()).toEqual(template);
  });

  it('copying twice keeps the first copy and its edits', () => {
    copyTemplateForGame(opened.db, 'game-a');
    const edited = getGameScenario(opened.db, 'game-a')!;
    edited.name = 'เมืองของเรา';
    updateGameScenario(opened.db, 'game-a', edited);

    const again = copyTemplateForGame(opened.db, 'game-a');

    expect(again.name).toBe('เมืองของเรา');
  });

  it('refuses an invalid update with field errors and keeps the stored copy', () => {
    copyTemplateForGame(opened.db, 'game-a');
    const bad = getGameScenario(opened.db, 'game-a')!;
    bad.timeline[0]!.day = 13;

    const result = updateGameScenario(opened.db, 'game-a', bad);

    expect(result).toMatchObject({ ok: false, code: 'invalid', errors: [{ path: 'timeline.0.day' }] });
    expect(getGameScenario(opened.db, 'game-a')?.timeline[0]?.day).toBe(1);
  });

  it('has no scenario for a game that was never copied, and cannot update one', () => {
    expect(getGameScenario(opened.db, 'game-a')).toBeNull();
    expect(updateGameScenario(opened.db, 'game-a', defaultScenario())).toEqual({ ok: false, code: 'not_found' });
  });

  it('cannot copy for a game that does not exist', () => {
    expect(() => copyTemplateForGame(opened.db, 'no-such-game')).toThrow();
  });

  it('loads a stored copy saved before newer fields existed, with their defaults (C6)', () => {
    copyTemplateForGame(opened.db, 'game-a');
    const old = JSON.parse(JSON.stringify(defaultScenario()));
    for (const location of old.locations) delete location.safety;
    opened.sqlite.prepare('update game_scenario set data = ? where game_id = ?').run(JSON.stringify(old), 'game-a');

    expect(getGameScenario(opened.db, 'game-a')?.locations.every((l) => l.safety === 'normal')).toBe(true);
  });

  it('drops the copy when its game is deleted', () => {
    copyTemplateForGame(opened.db, 'game-a');
    opened.sqlite.prepare('delete from game where id = ?').run('game-a');
    expect(getGameScenario(opened.db, 'game-a')).toBeNull();
  });
});
