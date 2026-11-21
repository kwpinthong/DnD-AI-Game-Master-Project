import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(serverRoot, '..', '..');

/** SDKs of AI providers. Adding a provider (e.g. Gemini) adds its SDK here. */
const PROVIDER_SDK = /^(?:@anthropic-ai\/|openai$|@google\/genai|@google\/generative-ai|@mistralai\/|cohere-ai)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

/** Every module specifier in `import ... from 'x'`, `export ... from 'x'`, `import('x')`, `require('x')`. */
function importsOf(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) specs.push(match[1]!);
  return specs;
}

const rel = (file: string) => relative(repoRoot, file).replaceAll('\\', '/');

// GEN-038 C3: Given the server source / When a test scans imports / Then only src/ai/providers/*
// imports a provider SDK.
describe('C3 provider SDK imports', () => {
  const serverFiles = sourceFiles(join(serverRoot, 'src'));

  it('the import scanner sees static, dynamic and re-export forms', () => {
    expect(
      importsOf(`import A from '@anthropic-ai/sdk';\nexport * from "./x.ts";\nconst m = await import('openai');\nrequire("cohere-ai")`),
    ).toEqual(['@anthropic-ai/sdk', './x.ts', 'openai', 'cohere-ai']);
  });

  it('only apps/server/src/ai/providers/* imports a provider SDK', () => {
    const importers = serverFiles
      .filter((file) => importsOf(readFileSync(file, 'utf8')).some((spec) => PROVIDER_SDK.test(spec)))
      .map(rel);
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((file) => !file.startsWith('apps/server/src/ai/providers/'))).toEqual([]);
  });

  it('no other package (web, protocol, rules) imports a provider SDK', () => {
    const others = ['apps/web/src', 'packages/protocol/src', 'packages/rules/src'].flatMap((dir) => {
      try {
        return sourceFiles(join(repoRoot, dir));
      } catch {
        return [];
      }
    });
    const importers = others.filter((file) => importsOf(readFileSync(file, 'utf8')).some((spec) => PROVIDER_SDK.test(spec)));
    expect(importers.map(rel)).toEqual([]);
  });

  it('only the registry imports providers/*, and providers import nothing of the server but provider.ts', () => {
    const offending: string[] = [];
    for (const file of serverFiles) {
      const name = rel(file);
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const inProviders = name.startsWith('apps/server/src/ai/providers/');
        if (spec.includes('providers/') && name !== 'apps/server/src/ai/registry.ts') offending.push(`${name} -> ${spec}`);
        if (inProviders && !/^\.\.\/(?:provider|config)\.ts$|^\.\/[\w-]+\.ts$/.test(spec)) offending.push(`${name} -> ${spec}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
