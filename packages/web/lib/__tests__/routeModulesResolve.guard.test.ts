import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guard: every page module the routers import actually exists on disk.
 *
 * Registering a route is three edits — the content registry, src/App.tsx, and
 * src/prerender-entry.tsx — and the page file itself is a fourth. Do the three
 * registrations without the fourth and nothing in the suite objected: the SEO
 * parity test compares the route manifest against the router, and both of those
 * were edited correctly. The damage shows up elsewhere. Vite cannot resolve the
 * import, so the dev server returns 500 for src/App.tsx and the whole app stops
 * loading; worse, the SSR build dies on the same import, and because the
 * prerender step fails open on purpose (SEO must never block a deploy) a deploy
 * in that window goes green while every crawler gets the empty SPA shell.
 *
 * That is the 2026-08-27 outage's failure mode reached by a different route, so
 * it is checked here rather than left to a build nobody reads.
 */

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Mirrors the "@" alias in vite.shared.ts: "@/x" is this package's ./x. */
function resolvesOnDisk(specifier: string): boolean {
  const relative = specifier.slice('@/'.length);
  const base = `${packageRoot}${relative}`;
  return [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]
    .some((candidate) => existsSync(candidate));
}

function aliasedImports(file: string): string[] {
  const source = readFileSync(`${packageRoot}${file}`, 'utf8');
  return [...source.matchAll(/["'](@\/[^"']+)["']/g)].map((m) => m[1]);
}

for (const file of ['src/App.tsx', 'src/prerender-entry.tsx']) {
  test(`${file} imports only modules that exist`, () => {
    const specifiers = aliasedImports(file);
    expect(specifiers.length).toBeGreaterThan(10);
    const missing = specifiers.filter((s) => !resolvesOnDisk(s));
    expect(
      missing,
      `${file} imports ${missing.length} module(s) that do not exist on disk. ` +
        `A route was registered without its page file: dev returns 500 for the whole app, ` +
        `and the prerender fails open so crawlers silently get the empty shell.`,
    ).toEqual([]);
  });
}
