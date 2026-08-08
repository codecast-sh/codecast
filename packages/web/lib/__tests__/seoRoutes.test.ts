import { describe, expect, test } from "bun:test";
import { SEO_ROUTES, seoFor, SITE_URL } from "../seoRoutes";
import { ROUTES } from "../../src/routes.manifest";

/**
 * Parity guard: every marketing route must be represented in the SEO manifest,
 * or it ships invisible to crawlers (no prerendered snapshot, no sitemap entry,
 * no title). Dynamic routes (":param") pass when at least one concrete SEO
 * entry instantiates them — guide/blog entries derive from their content
 * registries, so an empty expansion means the derivation broke.
 */
describe("seoRoutes", () => {
  const marketingPaths = ROUTES.filter((r) => r.layout === "marketing").map((r) => `/${r.path}`);

  test("covers every marketing route in routes.manifest", () => {
    for (const path of marketingPaths) {
      if (path.includes(":")) {
        const prefix = path.slice(0, path.indexOf(":"));
        const concrete = SEO_ROUTES.filter((e) => e.path.startsWith(prefix) && e.path !== prefix.replace(/\/$/, ""));
        expect(concrete.length, `no SEO entries instantiate dynamic route ${path}`).toBeGreaterThan(0);
      } else {
        expect(seoFor(path === "/" ? "/" : path), `marketing route ${path} missing from SEO_ROUTES`).toBeDefined();
      }
    }
  });

  test("every SEO entry maps to a real marketing route", () => {
    const staticPaths = new Set(marketingPaths.filter((p) => !p.includes(":")));
    const dynamicPrefixes = marketingPaths
      .filter((p) => p.includes(":"))
      .map((p) => p.slice(0, p.indexOf(":")));
    for (const entry of SEO_ROUTES) {
      const ok =
        staticPaths.has(entry.path) ||
        (entry.path === "/" && staticPaths.has("/")) ||
        dynamicPrefixes.some((prefix) => entry.path.startsWith(prefix));
      expect(ok, `SEO entry ${entry.path} matches no marketing route — it would prerender a 404`).toBe(true);
    }
  });

  test("titles are unique and descriptions non-empty", () => {
    const titles = new Set<string>();
    for (const entry of SEO_ROUTES) {
      expect(titles.has(entry.title), `duplicate title: ${entry.title}`).toBe(false);
      titles.add(entry.title);
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.path.startsWith("/")).toBe(true);
      expect(entry.path === "/" || !entry.path.endsWith("/")).toBe(true);
    }
  });

  test("seoFor normalizes trailing slashes", () => {
    expect(seoFor("/about/")).toBe(seoFor("/about"));
    expect(seoFor("/")).toBeDefined();
  });

  test("site url has no trailing slash", () => {
    expect(SITE_URL.endsWith("/")).toBe(false);
  });
});
