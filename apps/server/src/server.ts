import cors from '@fastify/cors';
import type { HealthResponse } from '@isekai/protocol';
import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './config.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import type { Clock } from './auth/join.ts';
import { openDatabase, type Db } from './db/client.ts';
import { ensureGame } from './db/bootstrap.ts';

export interface RunningServer {
  url: string;
  dbPath: string;
  migrationsApplied: number;
  /** Raw SQLite handle (tests and admin scripts). */
  db: Database.Database;
  orm: Db;
  close(): Promise<void>;
}

/**
 * Opens and migrates the database first, then listens. If the database is unusable this rejects
 * with a DatabaseUnavailableError naming the path, and nothing is listening.
 */
export interface ServerOptions {
  /** Current time in epoch ms (tests move it to check lockout and session expiry). */
  now?: Clock;
}

export async function startServer(config: ServerConfig, options: ServerOptions = {}): Promise<RunningServer> {
  const { sqlite, db, dbPath, migrationsApplied } = openDatabase(config.dbPath);
  if (config.bootstrapInviteCode) ensureGame(db, config.bootstrapInviteCode, (options.now ?? Date.now)());

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: config.webOrigins ?? [] });

  app.get('/health', async (_req, reply) => {
    let body: HealthResponse;
    try {
      sqlite.prepare('select 1').get();
      body = { ok: true, db: 'connected' };
    } catch {
      body = { ok: false, db: 'error' };
    }
    return reply.code(body.ok ? 200 : 503).send(body);
  });

  registerAuthRoutes(app, db, options.now ?? Date.now);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const { port } = app.server.address() as AddressInfo;
  const urlHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;

  return {
    url: `http://${urlHost}:${port}`,
    dbPath,
    migrationsApplied,
    db: sqlite,
    orm: db,
    async close() {
      await app.close();
      if (sqlite.open) sqlite.close();
    },
  };
}
