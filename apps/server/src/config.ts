import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSecretHash } from './auth/pin.ts';

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
  return {
    host: value('HOST') ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port,
    dbPath: dbPath ? resolve(dbPath) : resolve(repoRoot, 'data', 'isekai.sqlite'),
    webOrigins,
    ...(createCodeHash ? { createCodeHash } : {}),
  };
}

function isOrigin(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === candidate;
  } catch {
    return false;
  }
}
