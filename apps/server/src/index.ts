import { loadAiConfig } from './ai/config.ts';
import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

try {
  const server = await startServer(loadConfig(process.env), { ai: loadAiConfig(process.env) });
  console.log(`[isekai-server] database ${server.dbPath} (migrations applied: ${server.migrationsApplied})`);
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
