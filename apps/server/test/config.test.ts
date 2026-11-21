import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const production = {
  NODE_ENV: 'production',
  PORT: '8080',
  DB_PATH: '/data/isekai.sqlite',
  WEB_ORIGIN: 'https://isekai.netlify.app',
};

describe('loadConfig (dev)', () => {
  it('defaults to loopback:3000, <repo>/data/isekai.sqlite and the Vite dev origin', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3000,
      dbPath: join(repoRoot, 'data', 'isekai.sqlite'),
      webOrigins: ['http://localhost:5173'],
    });
  });

  it('reads HOST, PORT, DB_PATH and a comma-separated WEB_ORIGIN from the environment', () => {
    expect(
      loadConfig({
        HOST: '0.0.0.0',
        PORT: '4100',
        DB_PATH: 'C:/isekai/volume/game.sqlite',
        WEB_ORIGIN: 'https://isekai.netlify.app, http://localhost:5173',
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 4100,
      dbPath: resolve('C:/isekai/volume/game.sqlite'),
      webOrigins: ['https://isekai.netlify.app', 'http://localhost:5173'],
    });
  });

  it('refuses a PORT that is not a port number and names the variable', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('accepts a WEB_ORIGIN pasted with a trailing slash (browsers send the origin without it)', () => {
    expect(loadConfig({ WEB_ORIGIN: 'https://isekai.netlify.app/' }).webOrigins).toEqual([
      'https://isekai.netlify.app',
    ]);
  });

  it('refuses a WEB_ORIGIN that is not an origin and names the variable', () => {
    expect(() => loadConfig({ WEB_ORIGIN: 'isekai.netlify.app' })).toThrow(/WEB_ORIGIN/);
    expect(() => loadConfig({ WEB_ORIGIN: 'https://isekai.netlify.app/join' })).toThrow(/WEB_ORIGIN/);
  });
});

describe('loadConfig (NODE_ENV=production, Railway)', () => {
  it('listens on 0.0.0.0 and the PORT Railway injects, with the DB on the volume path', () => {
    expect(loadConfig(production)).toEqual({
      host: '0.0.0.0',
      port: 8080,
      dbPath: resolve('/data/isekai.sqlite'),
      webOrigins: ['https://isekai.netlify.app'],
    });
  });

  it('fails fast naming WEB_ORIGIN when it is missing (no silent fallback to localhost)', () => {
    const { WEB_ORIGIN: _omit, ...env } = production;
    expect(() => loadConfig(env)).toThrow(/WEB_ORIGIN/);
    expect(() => loadConfig({ ...env, WEB_ORIGIN: '  ' })).toThrow(/WEB_ORIGIN/);
  });

  it('fails fast naming DB_PATH when it is missing (the default path is not on the volume)', () => {
    const { DB_PATH: _omit, ...env } = production;
    expect(() => loadConfig(env)).toThrow(/DB_PATH/);
  });

  it('names every missing variable at once', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/WEB_ORIGIN.*DB_PATH|DB_PATH.*WEB_ORIGIN/);
  });

  it('keeps an explicit HOST', () => {
    expect(loadConfig({ ...production, HOST: '::' }).host).toBe('::');
  });

  it('reads BOOTSTRAP_INVITE_CODE (first game until GEN-025 adds game creation)', () => {
    expect(loadConfig({ ...production, BOOTSTRAP_INVITE_CODE: 'ab12-cd' }).bootstrapInviteCode).toBe('ab12-cd');
    expect(loadConfig(production)).not.toHaveProperty('bootstrapInviteCode');
  });
});
