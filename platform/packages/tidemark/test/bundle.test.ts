import { describe, expect, test, setDefaultTimeout } from 'bun:test';
import { build } from 'esbuild';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

/**
 * The core and its stores must bundle the way Convex bundles an action
 * (browser platform, ESM) with nothing left to resolve: no Node built-in, no
 * dependency. The ./agent subpath is the one door to @platform/agent and is
 * checked apart.
 */
const entries = ['src/index.ts', 'src/tree.ts', 'src/stores/memory.ts', 'src/stores/postgres.ts', 'src/stores/contract.ts'].map((p) => new URL(`../${p}`, import.meta.url).pathname);

describe('runtime neutrality', () => {
  test('the core and its stores bundle for the browser with zero imports outside the package', async () => {
    const result = await build({ entryPoints: entries, bundle: true, platform: 'browser', format: 'esm', splitting: true, outdir: '/tmp/tidemark-bundle', write: false, metafile: true, logLevel: 'silent' });
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.every((p) => p.startsWith('src/') || p.includes('/tidemark/src/'))).toBe(true);
    const external = Object.values(result.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path));
    expect(external).toEqual([]);
  });

  test('the ./stores/convex subpath reaches only convex itself', async () => {
    const result = await build({ entryPoints: [new URL('../src/stores/convex.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent', external: ['convex', 'convex/*'] });
    expect(result.errors).toEqual([]);
    const external = [...new Set(Object.values(result.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path)))].sort();
    expect(external).toEqual(['convex/server', 'convex/values']);
  });

  test('only the ./agent subpath reaches @platform/agent, and nothing in the core imports it', async () => {
    const result = await build({ entryPoints: [new URL('../src/agent/index.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent', external: ['@platform/agent'] });
    const importers = Object.entries(result.metafile.inputs).filter(([, input]) => input.imports.some((i) => i.path === '@platform/agent')).map(([file]) => file);
    expect(importers).toEqual(['src/agent/index.ts']);
  });
});
