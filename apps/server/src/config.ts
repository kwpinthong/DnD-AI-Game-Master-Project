import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  host: string;
  port: number;
  /** Directory holding isekai.sqlite. */
  dataDir: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Reads HOST, PORT and DATA_DIR. Defaults: 127.0.0.1, 3000, <repo>/data. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, got "${env.PORT}"`);
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    dataDir: env.DATA_DIR ? resolve(env.DATA_DIR) : resolve(repoRoot, 'data'),
  };
}
