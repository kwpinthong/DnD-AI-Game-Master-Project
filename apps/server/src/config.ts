import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  host: string;
  port: number;
  /** Directory holding isekai.sqlite. */
  dataDir: string;
  /** Browser origins allowed to call the API (CORS). The web app is hosted separately (Q-031). */
  webOrigins?: string[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Reads HOST, PORT, DATA_DIR and WEB_ORIGIN. Defaults: 127.0.0.1, 3000, <repo>/data, the Vite dev origin. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, got "${env.PORT}"`);
  }
  const webOrigins = (env.WEB_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    dataDir: env.DATA_DIR ? resolve(env.DATA_DIR) : resolve(repoRoot, 'data'),
    webOrigins,
  };
}
