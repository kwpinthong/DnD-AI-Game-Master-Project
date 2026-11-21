import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

try {
  const server = await startServer(loadConfig(process.env));
  console.log(`[isekai-server] database ${server.dbPath} (migrations applied: ${server.migrationsApplied})`);
  console.log(`[isekai-server] listening on ${server.url}`);

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(`[isekai-server] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
