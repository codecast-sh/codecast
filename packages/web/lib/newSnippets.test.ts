import { describe, expect, test } from "bun:test";
import { SNIPPET_CATALOG, TEAM_FEATURES } from "@codecast/shared/contracts";
import { isRecentlyShipped, newSnippetsFor, snippetIntroKey } from "./newSnippets";

const DAY = 24 * 60 * 60 * 1000;

// Pin the clock relative to a real catalog entry so the tests keep passing as
// the catalog ages: "now" is 10 days after the newest ship date.
const newest = SNIPPET_CATALOG.reduce((m, s) => Math.max(m, Date.parse(s.shipped)), 0);
const NOW = newest + 10 * DAY;
const newestSlugs = SNIPPET_CATALOG.filter(
  (s) => NOW - Date.parse(s.shipped) < 45 * DAY,
).map((s) => s.slug);
const aSlug = newestSlugs[0];

const oldAccount = newest - 200 * DAY;
// A team with every opt-in feature on, so gated snippets (chat, calls) count
// as available in the "offers everything new" case.
const allOn = [{ features: Object.fromEntries(TEAM_FEATURES.map((f) => [f.key, true])) }];
const device = (snippets: Record<string, boolean> = {}) => ({ settings: { snippets } });

describe("newSnippetsFor", () => {
  test("offers recently shipped snippets to an account that predates them", () => {
    const got = newSnippetsFor({
      userCreatedAt: oldAccount,
      devices: [device()],
      dismissed: undefined,
      teams: allOn,
      now: NOW,
    });
    expect(got.map((s) => s.slug).sort()).toEqual([...newestSlugs].sort());
  });

  test("a team-gated snippet is only news while some team has the feature on", () => {
    const gated = TEAM_FEATURES.flatMap((f) => f.snippets);
    const got = newSnippetsFor({
      userCreatedAt: oldAccount,
      devices: [device()],
      dismissed: undefined,
      teams: [{ features: {} }],
      now: NOW,
    });
    for (const slug of gated) expect(got.map((s) => s.slug)).not.toContain(slug);
    expect(got.map((s) => s.slug).sort()).toEqual(newestSlugs.filter((s) => !gated.includes(s)).sort());
  });

  test("offers nothing to a brand-new account", () => {
    const got = newSnippetsFor({
      userCreatedAt: NOW - DAY,
      devices: [device()],
      dismissed: undefined,
      now: NOW,
    });
    expect(got).toEqual([]);
  });

  test("offers nothing without devices", () => {
    const got = newSnippetsFor({
      userCreatedAt: oldAccount,
      devices: [],
      dismissed: undefined,
      now: NOW,
    });
    expect(got).toEqual([]);
  });

  test("skips a snippet enabled on any device", () => {
    const got = newSnippetsFor({
      userCreatedAt: oldAccount,
      devices: [device(), device({ [aSlug]: true })],
      dismissed: undefined,
      now: NOW,
    });
    expect(got.map((s) => s.slug)).not.toContain(aSlug);
  });

  test("honors a pre-rename wireSlug when checking enablement", () => {
    const renamed = SNIPPET_CATALOG.find((s) => s.wireSlug);
    if (!renamed) return;
    const got = newSnippetsFor({
      // Account older than everything, window ignores age of old ships anyway.
      userCreatedAt: 0,
      devices: [device({ [renamed.wireSlug!]: true })],
      dismissed: undefined,
      now: Date.parse(renamed.shipped) + DAY,
    });
    expect(got.map((s) => s.slug)).not.toContain(renamed.slug);
  });

  test("skips a dismissed snippet", () => {
    const got = newSnippetsFor({
      userCreatedAt: oldAccount,
      devices: [device()],
      dismissed: { [snippetIntroKey(aSlug)]: NOW - DAY },
      now: NOW,
    });
    expect(got.map((s) => s.slug)).not.toContain(aSlug);
  });

  test("stops offering after the upsell window closes", () => {
    const got = newSnippetsFor({
      userCreatedAt: oldAccount,
      devices: [device()],
      dismissed: undefined,
      now: newest + 46 * DAY,
    });
    expect(got).toEqual([]);
  });

  test("unknown account age counts as an existing account", () => {
    const got = newSnippetsFor({
      userCreatedAt: undefined,
      devices: [device()],
      dismissed: undefined,
      now: NOW,
    });
    expect(got.length).toBeGreaterThan(0);
  });
});

describe("isRecentlyShipped", () => {
  test("marks only snippets inside the window", () => {
    const s = SNIPPET_CATALOG.find((x) => x.slug === aSlug)!;
    expect(isRecentlyShipped(s, NOW)).toBe(true);
    expect(isRecentlyShipped(s, newest + 46 * DAY)).toBe(false);
  });
});
