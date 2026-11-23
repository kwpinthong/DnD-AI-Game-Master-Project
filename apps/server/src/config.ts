import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSecretHash } from './auth/pin.ts';
import type { BackupConfig } from './backup/schedule.ts';

export interface ServerConfig {
  host: string;
  port: number;
  /** The SQLite file. On Railway it must be on the volume (e.g. /data/isekai.sqlite). */
  dbPath: string;
  /** Browser origins allowed to call the API (CORS). The web app is hosted separately (Q-031). */
  webOrigins?: string[];
  /**
   * scrypt hash of the create code needed to create a game (Q-021). The code itself never reaches
   * the server's config. Without it, POST /api/games answers 503 and nobody can create a game.
   */
  createCodeHash?: string;
  /**
   * scrypt hash of the server owner's admin code (GEN-061, Q-058): it opens the AI usage dashboard.
   * Without it the dashboard is closed for everyone (POST /api/admin/session answers 503).
   */
  adminCodeHash?: string;
  /** Scheduled backups of the DB (GEN-037); none when left out (tests) or BACKUP_INTERVAL_HOURS=0. */
  backup?: BackupConfig;
  /** Q-364: extract an ended game's lore + feedback this long after it ended (LEARNING_AUTO_EXTRACT_HOURS); none = off (tests). */
  learningAutoExtractMs?: number;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Variables a production start cannot guess: a wrong guess loses data (DB_PATH) or blocks the web (WEB_ORIGIN). */
const REQUIRED_IN_PRODUCTION = ['WEB_ORIGIN', 'DB_PATH'] as const;

/**
 * Reads HOST, PORT, DB_PATH, WEB_ORIGIN and CREATE_CODE_HASH.
 * Dev defaults: 127.0.0.1, 3000, <repo>/data/isekai.sqlite, the Vite dev origin.
 * NODE_ENV=production: HOST defaults to 0.0.0.0, and WEB_ORIGIN and DB_PATH are required.
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const value = (name: string) => env[name]?.trim() || undefined;

  if (production) {
    const missing = REQUIRED_IN_PRODUCTION.filter((name) => value(name) === undefined);
    if (missing.length > 0) {
      throw new Error(`NODE_ENV=production needs these environment variables: ${missing.join(', ')}`);
    }
  }

  const port = Number(value('PORT') ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, got "${env.PORT}"`);
  }

  const webOrigins = (value('WEB_ORIGIN') ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const origin of webOrigins) {
    if (!isOrigin(origin)) {
      throw new Error(`WEB_ORIGIN must be origins like https://<site>.netlify.app (no path), got "${origin}"`);
    }
  }

  const dbPath = value('DB_PATH');
  const createCodeHash = value('CREATE_CODE_HASH');
  if (createCodeHash !== undefined && !isSecretHash(createCodeHash)) {
    // The value is not printed: it may be the create code itself pasted by mistake.
    throw new Error(
      'CREATE_CODE_HASH must be a hash from "pnpm --filter @isekai/server run create-code:hash" (scrypt$...), not the create code itself',
    );
  }
  const adminCodeHash = value('ADMIN_CODE_HASH');
  if (adminCodeHash !== undefined && !isSecretHash(adminCodeHash)) {
    throw new Error(
      'ADMIN_CODE_HASH must be a hash from "pnpm --filter @isekai/server run admin-code:hash" (scrypt$...), not the admin code itself',
    );
  }
  const resolvedDbPath = dbPath ? resolve(dbPath) : resolve(repoRoot, 'data', 'isekai.sqlite');
  const backup = backupConfig(value, resolvedDbPath);
  const extractText = value('LEARNING_AUTO_EXTRACT_HOURS') ?? '24';
  const extractHours = Number(extractText);
  if (!Number.isFinite(extractHours) || extractHours < 0) {
    throw new Error(`LEARNING_AUTO_EXTRACT_HOURS must be a number of hours, 0 or more (0 = off), got "${extractText}"`);
  }
  return {
    host: value('HOST') ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port,
    dbPath: resolvedDbPath,
    webOrigins,
    ...(createCodeHash ? { createCodeHash } : {}),
    ...(adminCodeHash ? { adminCodeHash } : {}),
    ...(backup ? { backup } : {}),
    ...(extractHours > 0 ? { learningAutoExtractMs: Math.round(extractHours * 3_600_000) } : {}),
  };
}

/** Default every 6 hours (ADR Hosting) and keep 28 = 7 days of them. */
export const BACKUP_DEFAULTS = { intervalHours: 6, keep: 28 } as const;

/**
 * BACKUP_DIR (default `backups/` next to the DB, so on the Railway volume), BACKUP_INTERVAL_HOURS
 * (0 = no backup job) and BACKUP_KEEP (how many to keep).
 */
function backupConfig(value: (name: string) => string | undefined, dbPath: string): BackupConfig | undefined {
  const hoursText = value('BACKUP_INTERVAL_HOURS') ?? String(BACKUP_DEFAULTS.intervalHours);
  const hours = Number(hoursText);
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`BACKUP_INTERVAL_HOURS must be a number of hours, 0 or more (0 = no backups), got "${hoursText}"`);
  }
  const keepText = value('BACKUP_KEEP') ?? String(BACKUP_DEFAULTS.keep);
  const keep = Number(keepText);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`BACKUP_KEEP must be a whole number, 1 or more, got "${keepText}"`);
  if (hours === 0) return undefined;
  const dir = value('BACKUP_DIR');
  return { dir: dir ? resolve(dir) : resolve(dirname(dbPath), 'backups'), intervalMs: Math.round(hours * 3_600_000), keep };
}

function isOrigin(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === candidate;
  } catch {
    return false;
  }
}
