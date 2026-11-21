import type { HealthResponse } from '@isekai/protocol';
import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './config.ts';
import { openDatabase, type Db } from './db/client.ts';

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
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const { sqlite, db, dbPath, migrationsApplied } = openDatabase(config.dataDir);

  const app = Fastify({ logger: false });

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
