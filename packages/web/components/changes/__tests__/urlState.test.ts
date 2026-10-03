import { describe, expect, test } from "bun:test";
import { EMPTY_URL, changesHref, parseChangesUrl, serializeChangesUrl, type ChangesUrl } from "../useChangesUrlState";

// The whole view lives in the query string (changes-page.md 6.3), so a link
// pasted in team chat must land on the same view. The contract is a round
// trip: serializing a view and reading it back gives the same view, and the
// string is canonical, so two equal views share one link.

const read = (qs: string) => parseChangesUrl(new URLSearchParams(qs.replace(/^\?/, "")));
const roundTrip = (s: ChangesUrl) => read(serializeChangesUrl(s));

// Every field set away from its default. Typed as Required for the editor;
// test files sit outside the app typecheck, so the first test also holds its
// keys to the ones parse returns. A field parse learns must be added here,
// and the round trip then proves serialize knows it too.
const FULL = {
  repo: "codecast-sh/codecast",
  d: "2026-10-02",
  w: "2026-W40",
  areas: ["cli", "convex", "web"],
  person: "jd7a1b2c3d4e5f6g7h8j9k0",
  branches: "all",
  risk: true,
  waiting: true,
  surface: "desktop",
  q: "fix sync",
  story: "s_9f3a1c0e7b2d",
} satisfies Required<ChangesUrl>;

/** One view per field: the default view with just that field set as in FULL. */
const single = (Object.keys(FULL) as (keyof ChangesUrl)[]).map((k) => [k, { ...EMPTY_URL, [k]: FULL[k] } as ChangesUrl] as const);

describe("the Changes URL round trip", () => {
  test("the default view is the bare path", () => {
    expect(serializeChangesUrl(EMPTY_URL)).toBe("");
    expect(changesHref(EMPTY_URL)).toBe("/changes");
    expect(read("")).toEqual(EMPTY_URL);
  });

  test("a view with every field set reads back whole", () => {
    expect(Object.keys(FULL).sort()).toEqual(Object.keys(read("")).sort());
    expect(roundTrip(FULL)).toEqual(FULL);
    expect(changesHref(FULL)).toBe(`/changes${serializeChangesUrl(FULL)}`);
  });

  test.each(single)("%s alone reaches the URL and reads back", (_key, view) => {
    expect(serializeChangesUrl(view)).not.toBe("");
    expect(roundTrip(view)).toEqual(view);
  });

  test("text that needs escaping survives: spaces, separators, percent signs, unicode", () => {
    for (const q of ["a & b = c", "50% off, 100%2C done", "#412 + /path?x=1", "naïve café 🚀", "comma,in,query"]) {
      const view = { ...EMPTY_URL, q, person: "Ada Lovelace", story: "k/with/slash" };
      expect(roundTrip(view)).toEqual(view);
    }
  });

  test("readable links: repo slashes and area commas stay literal", () => {
    expect(serializeChangesUrl({ ...EMPTY_URL, repo: "codecast-sh/codecast", areas: ["web", "cli"] })).toBe("?repo=codecast-sh/codecast&area=cli,web");
  });

  test("the string is canonical: equal views share one link whatever order they were built in", () => {
    const a = serializeChangesUrl({ ...FULL, areas: ["web", "cli", "convex"] });
    const b = serializeChangesUrl(read("story=s_9f3a1c0e7b2d&q=fix+sync&surface=desktop&waiting=1&risk=1&branches=all&person=jd7a1b2c3d4e5f6g7h8j9k0&area=web,cli,convex&w=2026-W40&d=2026-10-02&repo=codecast-sh/codecast"));
    expect(a).toBe(b);
    expect(a).toBe(serializeChangesUrl(FULL));
  });

  test("a messy pasted link normalizes once, then stays put", () => {
    const messy = "area=web,%20cli,,web&q=%20%20&person=&risk=yes&waiting=1&branches=feature&repo=%20codecast-sh/codecast%20&d=2026-02-30&story=abc";
    const first = read(messy);
    expect(first).toEqual({ ...EMPTY_URL, repo: "codecast-sh/codecast", areas: ["cli", "web"], waiting: true, story: "abc" });
    const once = serializeChangesUrl(first);
    expect(serializeChangesUrl(read(once))).toBe(once);
  });
});
