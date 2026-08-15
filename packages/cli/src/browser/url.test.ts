/**
 * When does `open` reuse the loaded page instead of navigating?
 *
 * Both failure directions are bad and neither is loud. Too loose and `open`
 * decides it is already there when it is not, so the agent can no longer
 * navigate and every later step acts on the wrong page. Too strict and every
 * call reloads a page that was already loaded, which is the slowness this
 * exists to fix. So the rule gets pinned in both directions.
 */

import { describe, expect, test } from "bun:test";
import { sameDocument } from "./url.js";

describe("sameDocument — treated as already loaded", () => {
  test("identical urls", () => {
    expect(sameDocument("https://a.test/x", "https://a.test/x")).toBe(true);
  });

  test("a trailing slash on the root", () => {
    // What `location.href` reports ("https://a.test/") against what an agent
    // types ("https://a.test"). Reloading over this would make the common case
    // — re-opening the site you are on — always cost a full load.
    expect(sameDocument("https://a.test/", "https://a.test")).toBe(true);
  });

  test("a missing scheme, which the CLI fills in", () => {
    expect(sameDocument("https://a.test/", "a.test")).toBe(true);
  });

  test("differing only by fragment", () => {
    // Following #section is a scroll, not a load.
    expect(sameDocument("https://a.test/x", "https://a.test/x#part")).toBe(true);
  });

  test("a trailing slash on any path, not just the root", () => {
    // Servers overwhelmingly serve /docs and /docs/ as the same page, and being
    // wrong costs one skipped navigation rather than a wrong page.
    expect(sameDocument("https://a.test/docs/", "https://a.test/docs")).toBe(true);
  });

  test("host case, which is not significant", () => {
    expect(sameDocument("https://A.TEST/x", "https://a.test/x")).toBe(true);
  });
});

describe("sameDocument — must navigate", () => {
  test("a different path", () => {
    expect(sameDocument("https://a.test/x", "https://a.test/y")).toBe(false);
  });

  test("a different query, which usually selects what is shown", () => {
    expect(sameDocument("https://a.test/s?q=1", "https://a.test/s?q=2")).toBe(false);
  });

  test("gaining a query", () => {
    expect(sameDocument("https://a.test/s", "https://a.test/s?q=1")).toBe(false);
  });

  test("a different host", () => {
    expect(sameDocument("https://a.test/x", "https://b.test/x")).toBe(false);
  });

  test("a different port", () => {
    // localhost:3200 and localhost:3300 are different apps, routinely both open.
    expect(sameDocument("http://localhost:3200/x", "http://localhost:3300/x")).toBe(false);
  });

  test("a different scheme", () => {
    expect(sameDocument("http://a.test/x", "https://a.test/x")).toBe(false);
  });

  test("path case, which servers do treat as significant", () => {
    expect(sameDocument("https://a.test/Foo", "https://a.test/foo")).toBe(false);
  });

  test("anything unparseable, rather than guessing", () => {
    expect(sameDocument("not a url", "not a url")).toBe(false);
    expect(sameDocument("about:blank", "https://a.test")).toBe(false);
  });
});
