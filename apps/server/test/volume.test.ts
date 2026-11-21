import { JoinResponse, MeResponse } from '@isekai/protocol';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

const journalPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', 'meta', '_journal.json');
const migrationCount = (JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] }).entries.length;

function count(dbPath: string, table: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

// C5 (local part): a new version starts on the same volume file. Migrations run once in total,
// and members and sessions written by the old version are still there.
describe('DB on a volume path (DB_PATH) across deploys', { timeout: 30_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  // Like Railway's /data mount: a directory that only holds the DB, at a path the config names.
  const dbPath = () => join(dir, 'volume', 'isekai.sqlite');

  async function deploy(bootstrapInviteCode?: string) {
    await server?.close();
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      dbPath: dbPath(),
      ...(bootstrapInviteCode ? { bootstrapInviteCode } : {}),
    });
    return server;
  }

  async function postJoin(running: RunningServer, body: unknown) {
    const res = await fetch(`${running.url}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  }

  async function me(running: RunningServer, token: string) {
    const res = await fetch(`${running.url}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as unknown };
  }

  it('creates the DB at DB_PATH (directory included) and applies every migration once', async () => {
    const first = await deploy();
    expect(first.dbPath).toBe(dbPath());
    expect(first.migrationsApplied).toBe(migrationCount);

    const second = await deploy();
    const third = await deploy();

    expect(second.migrationsApplied).toBe(0);
    expect(third.migrationsApplied).toBe(0);
    await server?.close();
    server = undefined;
    expect(count(dbPath(), '__drizzle_migrations')).toBe(migrationCount);
  });

  it('keeps members and sessions: the token from the old version still logs in after redeploy', async () => {
    const v1 = await deploy('ab12-cd');
    const joined = await postJoin(v1, { inviteCode: 'AB12CD', name: 'Nok', pin: '1234' });
    expect(joined.status).toBe(200);
    const { token, member } = JoinResponse.parse(joined.body);

    const v2 = await deploy('ab12-cd');
    const after = await me(v2, token);

    expect(v2.migrationsApplied).toBe(0);
    expect(after.status).toBe(200);
    expect(MeResponse.parse(after.body).member).toEqual(member);
    await server?.close();
    server = undefined;
    expect(count(dbPath(), 'member')).toBe(1);
    expect(count(dbPath(), 'session')).toBe(1);
  });

  it('BOOTSTRAP_INVITE_CODE creates one game, normalised, and never a second one on later starts', async () => {
    await deploy(' ab12-cd ');
    await deploy('AB12CD');
    const running = await deploy('ab-12-cd');

    const joined = await postJoin(running, { inviteCode: 'ab12cd', name: 'Mint', pin: '4321' });

    expect(joined.status).toBe(200);
    await server?.close();
    server = undefined;
    expect(count(dbPath(), 'game')).toBe(1);
  });

  it('without BOOTSTRAP_INVITE_CODE no game is created', async () => {
    await deploy();
    await server?.close();
    server = undefined;
    expect(count(dbPath(), 'game')).toBe(0);
  });
});
