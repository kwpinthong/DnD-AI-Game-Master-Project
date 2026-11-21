import { loadConfig } from '../config.ts';
import { openDatabase } from './client.ts';

// `pnpm db:migrate`: apply pending migrations without starting the server.
try {
  const { sqlite, dbPath, migrationsApplied } = openDatabase(loadConfig(process.env).dataDir);
  sqlite.close();
  console.log(`[isekai-server] ${dbPath}: applied ${migrationsApplied} migration(s)`);
} catch (error) {
  console.error(`[isekai-server] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
