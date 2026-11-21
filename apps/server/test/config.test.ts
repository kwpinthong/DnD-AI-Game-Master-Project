import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('loadConfig', () => {
  it('defaults to loopback:3000 and <repo>/data', () => {
    expect(loadConfig({})).toEqual({ host: '127.0.0.1', port: 3000, dataDir: join(repoRoot, 'data') });
  });

  it('reads HOST, PORT and DATA_DIR from the environment', () => {
    expect(loadConfig({ HOST: '0.0.0.0', PORT: '4100', DATA_DIR: 'C:/dnd-web/data' })).toEqual({
      host: '0.0.0.0',
      port: 4100,
      dataDir: resolve('C:/dnd-web/data'),
    });
  });

  it('refuses a PORT that is not a port number and names the variable', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });
});
