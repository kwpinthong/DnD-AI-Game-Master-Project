/**
 * GEN-147 (Q-305 a / Q-306 / Q-307 / Q-319): the game data lives in the DB. A data set with no row yet is seeded
 * from its asset file (an empty DB gets all of them); a row is never overwritten by the files, so a restart or a
 * new deploy keeps the server owner's edits. Every edit is checked by the same builder as the files
 * (buildGameAssets), backed up to a file first, logged in game_data_audit and can be undone.
 *
 * `assets` is one object for the whole server: its fields read the latest saved data, so new games and the next
 * turn of a running game use an edit at once. GEN-174: the AI GM resolver pins it per turn (`pinAssets`), so a turn
 * already running while an edit is saved reads only the old data to its end.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /** GEN-179: the DB row fails the schema, so the server runs on the asset file until a valid save. */
  fallback?: { message: string; fields: Record<string, string> };
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
export type ImportPreviewOutcome =
  | { ok: true; summary: DataSetSummary; value: unknown; changes: AuditEntry['changes'] }
  | Exclude<SaveOutcome, { ok: true }>;

export interface GameDataStore {
  /** The latest saved data, or the snapshot of a `pinAssets` run (see the file comment). */
  readonly assets: GameAssets;
  list(): DataSetSummary[];
  get(name: DataSetName): { summary: DataSetSummary; value: unknown } | undefined;
  save(name: DataSetName, value: unknown): SaveOutcome;
  /**
   * GEN-173: the set's asset file as it is now, checked like a save, with its diff against the DB. Changes
   * nothing; the admin confirms by saving `value` (backup + audit + undo as any edit).
   */
  importPreview(name: DataSetName): ImportPreviewOutcome;
  undo(name: DataSetName): UndoOutcome;
  audit(limit?: number): AuditEntry[];
  /** File name → JSON: write each to a folder and `loadGameAssets(folder)` loads it. */
  exportFiles(): Record<string, unknown>;
}

/** GEN-174: live view → the data it reads inside a `pinAssets` run. */
const pinned = new AsyncLocalStorage<ReadonlyMap<GameAssets, GameAssets>>();
/** Live view → its latest data (so `pinAssets` can take a snapshot of it). */
const latestOf = new WeakMap<GameAssets, () => GameAssets>();

/** Reads every property of the current data on each access, so holders of this object see edits (unless pinned). */
function liveView(latest: () => GameAssets): GameAssets {
  const current = () => pinned.getStore()?.get(view) ?? latest();
  const view: GameAssets = new Proxy({} as GameAssets, {
    get: (_t, key) => Reflect.get(current(), key),
    has: (_t, key) => Reflect.has(current(), key),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(current(), key);
      return d && { ...d, configurable: true };
    },
  });
  latestOf.set(view, latest);
  return view;
}

/**
 * GEN-174: takes a snapshot of `assets` now. Whatever runs through the returned function, including the async work
 * it starts (a turn's background dialogue and summaries), reads that snapshot through the same `assets` object; an
 * admin edit saved meanwhile shows only outside it. A pin inside a pin keeps the outer snapshot. A plain GameAssets
 * (not the live view) is already fixed and passes through.
 */
export function pinAssets(assets: GameAssets): <R>(fn: () => R) => R {
  const latest = latestOf.get(assets);
  const outer = pinned.getStore();
  if (!latest || outer?.has(assets)) return (fn) => fn();
  const map = new Map(outer);
  map.set(assets, latest());
  return (fn) => pinned.run(map, fn);
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
 * GEN-179: a saved row that no longer passes the schema (a deploy changed it) is left as it is and its set runs on
 * the asset file until a valid save; the log and the admin list name it. Only a set with no usable file still throws.
 */
export function openGameData(
  db: Db,
  seed: RawDataSets,
  options: { backupDir: string; now: Clock; assetsDir: string; log?: (line: string) => void },
): GameDataStore {
  const { backupDir, now, assetsDir, log = (line) => console.warn(line) } = options;
  db.transaction((tx) => {
    for (const name of DATA_SETS) {
      if (seed[name] === undefined) continue;
      tx.insert(gameDataSet).values({ name, json: JSON.stringify(seed[name]), updatedAt: now() }).onConflictDoNothing().run();
    }
  });

  const rows = () => new Map(db.select().from(gameDataSet).all().map((r) => [r.name, r]));
  const rawOf = (map: ReturnType<typeof rows>): RawDataSets =>
    Object.fromEntries([...map].filter(([name]) => isDataSetName(name)).map(([name, r]) => [name, JSON.parse(r.json) as unknown]));

  const fallbacks = new Map<DataSetName, NonNullable<DataSetSummary['fallback']>>();
  /** The DB, with the asset file for each set that fell back. */
  const effective = (map: ReturnType<typeof rows>): RawDataSets => ({ ...rawOf(map), ...Object.fromEntries([...fallbacks.keys()].map((n) => [n, seed[n]])) });

  function startAssets(): GameAssets {
    for (;;) {
      try {
        return buildGameAssets(effective(rows()));
      } catch (error) {
        // No set to blame, no file to use, or the file already failed: refuse to start as before.
        if (!(error instanceof AssetLoadError) || !error.set || fallbacks.has(error.set) || seed[error.set] === undefined) throw error;
        fallbacks.set(error.set, { message: error.message, fields: { ...error.fields } });
        log(`[game-data] ${error.message}; using ${DATA_SET_FILES[error.set]} for ${error.set} until a valid save in /admin (DB row unchanged)`);
      }
    }
  }
  let current = startAssets();

  const lastEdit = (name: DataSetName) =>
    db
      .select()
      .from(gameDataAudit)
      .where(and(eq(gameDataAudit.name, name), eq(gameDataAudit.action, 'edit'), isNull(gameDataAudit.undoneAt)))
      .orderBy(desc(gameDataAudit.id))
      .get();

  const summaryOf = (name: DataSetName, row: { json: string; updatedAt: number }): DataSetSummary => {
    const value = JSON.parse(row.json) as unknown;
    const fallback = fallbacks.get(name);
    return {
      name,
      file: DATA_SET_FILES[name],
      records: Array.isArray(value) ? value.length : 0,
      updatedAt: row.updatedAt,
      canUndo: lastEdit(name) !== undefined,
      ...(fallback ? { fallback } : {}),
    };
  };

  /** Checks `value` for `name` against every other set, backs up the old value, writes, logs. */
  /** The assets with `value` for `name` and the DB for the rest, or why that is refused. */
  function check(map: ReturnType<typeof rows>, name: DataSetName, value: unknown): { ok: true; next: GameAssets } | Exclude<SaveOutcome, { ok: true }> {
    if (!map.has(name)) return { ok: false, reason: 'not_found' };
    try {
      return { ok: true, next: buildGameAssets({ ...effective(map), [name]: value }) };
    } catch (error) {
      if (error instanceof AssetLoadError) return { ok: false, reason: 'invalid', message: error.message, fields: { ...error.fields } };
      throw error;
    }
  }

  function apply(name: DataSetName, value: unknown, action: 'edit' | 'undo', undoes?: number): SaveOutcome {
    const map = rows();
    const checked = check(map, name, value);
    if (!checked.ok) return checked;
    const old = map.get(name)!;
    const { next } = checked;
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
    fallbacks.delete(name);
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
    importPreview(name) {
      const file = join(assetsDir, DATA_SET_FILES[name]);
      if (!existsSync(file)) return { ok: false, reason: 'not_found' };
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        const message = `ไฟล์ ${DATA_SET_FILES[name]} ไม่ใช่ JSON: ${error instanceof Error ? error.message : String(error)}`;
        return { ok: false, reason: 'invalid', message, fields: { '(root)': message } };
      }
      const map = rows();
      const checked = check(map, name, value);
      if (!checked.ok) return checked;
      const row = map.get(name)!;
      return { ok: true, summary: summaryOf(name, row), value, changes: changesOf(row.json, JSON.stringify(value)) };
    },
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
