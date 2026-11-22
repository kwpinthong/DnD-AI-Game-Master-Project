import { fileURLToPath } from 'node:url';
import { loadAiConfig } from './ai/config.ts';
import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

try {
  const config = loadConfig(process.env);
  // The built web app, served from the same origin (Q-162); WEB_DIST_DIR overrides the default apps/web/dist.
  const webDistDir = process.env.WEB_DIST_DIR?.trim() || fileURLToPath(new URL('../../web/dist', import.meta.url));
  const server = await startServer(config, { ai: loadAiConfig(process.env), webDistDir });
  console.log(`[isekai-server] database ${server.dbPath} (migrations applied: ${server.migrationsApplied})`);
  console.log(
    config.backup
      ? `[isekai-server] backups: every ${config.backup.intervalMs / 3_600_000} h + at shutdown into ${config.backup.dir}, keep ${config.backup.keep}`
      : '[isekai-server] backups: off (BACKUP_INTERVAL_HOURS=0)',
  );
  const ai = server.ai.ready();
  console.log(
    ai.ok
      ? `[isekai-server] AI GM: provider ${ai.provider}, model ${ai.model} (ready)`
      : `[isekai-server] AI GM: not ready: ${ai.message}`,
  );
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
