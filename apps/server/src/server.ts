import cors from '@fastify/cors';
import type { HealthResponse } from '@isekai/protocol';
import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './config.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import type { Clock } from './auth/join.ts';
import { openDatabase, type Db } from './db/client.ts';
import { registerGameRoutes } from './game/routes.ts';

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

  const app = Fastify({ logger: false });
  // PATCH and DELETE are not in @fastify/cors's default methods; the lobby uses both.
  await app.register(cors, { origin: config.webOrigins ?? [], methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'] });

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

  const now = options.now ?? Date.now;
  registerAuthRoutes(app, db, now);
  registerGameRoutes(app, db, now, config.createCodeHash ? { createCodeHash: config.createCodeHash } : {});

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
