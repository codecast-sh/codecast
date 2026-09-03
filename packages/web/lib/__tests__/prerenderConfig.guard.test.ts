import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import prerenderConfig from "../../vite.prerender.config";
import { sharedResolve } from "../../vite.shared";

/**
 * Guard for the SSR build's path aliases.
 *
 * The marketing prerender and the share-page renderer are both built by
 * vite.prerender.config.ts, and every file they pull in imports through "@/…".
 * When that config lost its aliases, the SSR build failed on the first import,
 * the prerender step failed open (by design — SEO must never block a deploy),
 * and crawlers silently got the empty SPA shell for a week while every deploy
 * stayed green. Nothing else in the suite watches this, so it is watched here.
 */
describe("SSR build config", () => {
  const config = prerenderConfig as { resolve?: { alias?: Record<string, string> } };
  const alias = config.resolve?.alias;

  test("carries path aliases", () => {
    expect(alias, "SSR config has no resolve.alias — every @/… import will fail to resolve").toBeDefined();
    expect(Object.keys(alias!).length).toBeGreaterThan(0);
  });

  test("resolves @ to this package, and the compat shims to real files", () => {
    expect(alias!["@"]).toBe(join(import.meta.dir, "..", ".."));
    for (const key of ["@", "next/link", "next/navigation"]) {
      expect(alias![key], `alias "${key}" missing from the SSR build`).toBeDefined();
      expect(existsSync(alias![key]), `alias "${key}" points at ${alias![key]}, which does not exist`).toBe(true);
    }
  });

  test("shares one alias source with the app config", () => {
    // Both configs import vite.shared.ts. Reading them off each other's default
    // export is what broke: the app config is a function, so the property was
    // undefined and the aliases vanished without any error until build time.
    expect(alias).toEqual(sharedResolve.alias);
  });
});
