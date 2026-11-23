/**
 * GEN-147 (Q-305 a / Q-306 / Q-307 / Q-319): the game data lives in the DB. A data set with no row yet is seeded
 * from its asset file (an empty DB gets all of them); a row is never overwritten by the files, so a restart or a
 * new deploy keeps the server owner's edits. Every edit is checked by the same builder as the files
 * (buildGameAssets), backed up to a file first, logged in game_data_audit and can be undone.
 *
 * `assets` is one object for the whole server: its fields read the latest saved data, so new games and the next
 * turn of a running game use an edit at once.
 * shortcut: a turn already running while an edit is saved may read old and new data mixed; upgrade to a per-turn
 * snapshot if that ever matters.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Clock } from '../auth/join.ts';
import type { Db } from '../db/client.ts';
import { gameDataAudit, gameDataSet } from '../db/schema.ts';
import { AssetLoadError, buildGameAssets, DATA_SET_FILES, DATA_SETS, type DataSetName, type GameAssets, type RawDataSets } from './load.ts';

export const isDataSetName = (name: string): name is DataSetName => (DATA_SETS as readonly string[]).includes(name);

export interface DataSetSummary {
  name: DataSetName;
  file: string;
  records: number;
  updatedAt: number;
  canUndo: boolean;
}

export interface AuditEntry {
  id: number;
  name: string;
  action: 'edit' | 'undo';
  at: number;
  backupFile: string;
  /** Records whose JSON differs, by position; `null` = no record there on that side. */
  changes: { index: number; old: unknown; new: unknown }[];
}

export type SaveOutcome = { ok: true } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'invalid'; message: string; fields: Record<string, string> };
export type UndoOutcome = SaveOutcome | { ok: false; reason: 'nothing_to_undo' };

export interface GameDataStore {
  /** Always the latest saved data (see the file comment). */
  readonly assets: GameAssets;
  list(): DataSetSummary[];
  get(name: DataSetName): { summary: DataSetSummary; value: unknown } | undefined;
  save(name: DataSetName, value: unknown): SaveOutcome;
  undo(name: DataSetName): UndoOutcome;
  audit(limit?: number): AuditEntry[];
  /** File name → JSON: write each to a folder and `loadGameAssets(folder)` loads it. */
  exportFiles(): Record<string, unknown>;
}

/** Reads every property of the current data on each access, so holders of this object see edits. */
function liveView(current: () => GameAssets): GameAssets {
  return new Proxy({} as GameAssets, {
    get: (_t, key) => Reflect.get(current(), key),
    has: (_t, key) => Reflect.has(current(), key),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(current(), key);
      return d && { ...d, configurable: true };
    },
  });
}

function changesOf(oldJson: string, newJson: string): AuditEntry['changes'] {
  const before = JSON.parse(oldJson) as unknown;
  const after = JSON.parse(newJson) as unknown;
  if (!Array.isArray(before) || !Array.isArray(after)) return [{ index: 0, old: before, new: after }];
  const out: AuditEntry['changes'] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) out.push({ index: i, old: before[i] ?? null, new: after[i] ?? null });
  }
  return out;
}

/**
 * Seeds the missing data sets from `seed` (the asset files, already checked), then builds the assets from the DB.
 * Throws AssetLoadError when a saved row no longer passes the schema (nothing is changed then).
 */
export function openGameData(db: Db, seed: RawDataSets, options: { backupDir: string; now: Clock }): GameDataStore {
  const { backupDir, now } = options;
  db.transaction((tx) => {
    for (const name of DATA_SETS) {
      if (seed[name] === undefined) continue;
      tx.insert(gameDataSet).values({ name, json: JSON.stringify(seed[name]), updatedAt: now() }).onConflictDoNothing().run();
    }
  });

  const rows = () => new Map(db.select().from(gameDataSet).all().map((r) => [r.name, r]));
  const rawOf = (map: ReturnType<typeof rows>): RawDataSets =>
    Object.fromEntries([...map].filter(([name]) => isDataSetName(name)).map(([name, r]) => [name, JSON.parse(r.json) as unknown]));

  let current = buildGameAssets(rawOf(rows()));

  const lastEdit = (name: DataSetName) =>
    db
      .select()
      .from(gameDataAudit)
      .where(and(eq(gameDataAudit.name, name), eq(gameDataAudit.action, 'edit'), isNull(gameDataAudit.undoneAt)))
      .orderBy(desc(gameDataAudit.id))
      .get();

  const summaryOf = (name: DataSetName, row: { json: string; updatedAt: number }): DataSetSummary => {
    const value = JSON.parse(row.json) as unknown;
    return { name, file: DATA_SET_FILES[name], records: Array.isArray(value) ? value.length : 0, updatedAt: row.updatedAt, canUndo: lastEdit(name) !== undefined };
  };

  /** Checks `value` for `name` against every other set, backs up the old value, writes, logs. */
  function apply(name: DataSetName, value: unknown, action: 'edit' | 'undo', undoes?: number): SaveOutcome {
    const map = rows();
    const old = map.get(name);
    if (!old) return { ok: false, reason: 'not_found' };
    const raw = { ...rawOf(map), [name]: value };
    let next: GameAssets;
    try {
      next = buildGameAssets(raw);
    } catch (error) {
      if (error instanceof AssetLoadError) return { ok: false, reason: 'invalid', message: error.message, fields: { ...error.fields } };
      throw error;
    }
    const at = now();
    const json = JSON.stringify(value);
    // The backup comes first: if it cannot be written, nothing is saved.
    mkdirSync(backupDir, { recursive: true });
    const backupFile = `${name}-${new Date(at).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
    writeFileSync(join(backupDir, backupFile), JSON.stringify(JSON.parse(old.json), null, 2));
    db.transaction((tx) => {
      tx.update(gameDataSet).set({ json, updatedAt: at }).where(eq(gameDataSet.name, name)).run();
      if (undoes !== undefined) tx.update(gameDataAudit).set({ undoneAt: at }).where(eq(gameDataAudit.id, undoes)).run();
      tx.insert(gameDataAudit).values({ name, action, oldJson: old.json, newJson: json, backupFile, at }).run();
    });
    current = next;
    return { ok: true };
  }

  return {
    assets: liveView(() => current),
    list() {
      const map = rows();
      return DATA_SETS.flatMap((name) => {
        const row = map.get(name);
        return row ? [summaryOf(name, row)] : [];
      });
    },
    get(name) {
      const row = rows().get(name);
      return row ? { summary: summaryOf(name, row), value: JSON.parse(row.json) as unknown } : undefined;
    },
    save: (name, value) => apply(name, value, 'edit'),
    undo(name) {
      const edit = lastEdit(name);
      if (!edit) return rows().has(name) ? { ok: false, reason: 'nothing_to_undo' } : { ok: false, reason: 'not_found' };
      return apply(name, JSON.parse(edit.oldJson), 'undo', edit.id);
    },
    audit(limit = 100) {
      return db
        .select()
        .from(gameDataAudit)
        .orderBy(desc(gameDataAudit.id))
        .limit(limit)
        .all()
        .map((r) => ({ id: r.id, name: r.name, action: r.action, at: r.at, backupFile: r.backupFile, changes: changesOf(r.oldJson, r.newJson) }));
    },
    exportFiles() {
      const map = rows();
      return Object.fromEntries(DATA_SETS.flatMap((name) => (map.has(name) ? [[DATA_SET_FILES[name], JSON.parse(map.get(name)!.json) as unknown]] : [])));
    },
  };
}
