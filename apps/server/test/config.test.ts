import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('loadConfig', () => {
  it('defaults to loopback:3000, <repo>/data and the Vite dev origin', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3000,
      dataDir: join(repoRoot, 'data'),
      webOrigins: ['http://localhost:5173'],
    });
  });

  it('reads HOST, PORT, DATA_DIR and a comma-separated WEB_ORIGIN from the environment', () => {
    expect(
      loadConfig({
        HOST: '0.0.0.0',
        PORT: '4100',
        DATA_DIR: 'C:/isekai/data',
        WEB_ORIGIN: 'https://isekai.netlify.app, http://localhost:5173',
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 4100,
      dataDir: resolve('C:/isekai/data'),
      webOrigins: ['https://isekai.netlify.app', 'http://localhost:5173'],
    });
  });

  it('refuses a PORT that is not a port number and names the variable', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });
});
