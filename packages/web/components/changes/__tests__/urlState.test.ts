import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TabParamsCtx } from "../../../lib/tabParams";
import { EMPTY_URL, changesHref, clearFilters, parseChangesUrl, serializeChangesUrl, useChangesUrlState, type ChangesUrl } from "../useChangesUrlState";
import { pageSources } from "./pageSources";

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
  areas: ["cli", "convex", "web"],
  person: "jd7a1b2c3d4e5f6g7h8j9k0",
  branches: "all",
  risk: true,
  q: "fix sync",
  story: "s_9f3a1c0e7b2d",
  zoom: "weeks",
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
    const b = serializeChangesUrl(read("zoom=weeks&story=s_9f3a1c0e7b2d&q=fix+sync&surface=desktop&waiting=1&risk=1&branches=all&person=jd7a1b2c3d4e5f6g7h8j9k0&area=web,cli,convex&w=2026-W40&d=2026-10-02&repo=codecast-sh/codecast"));
    expect(a).toBe(b);
    expect(a).toBe(serializeChangesUrl(FULL));
  });

  test("a messy pasted link normalizes once, then stays put", () => {
    const messy = "area=web,%20cli,,web&q=%20%20&person=&risk=yes&waiting=1&branches=feature&repo=%20codecast-sh/codecast%20&d=2026-02-30&story=abc";
    const first = read(messy);
    expect(first).toEqual({ ...EMPTY_URL, repo: "codecast-sh/codecast", areas: ["cli", "web"], story: "abc" });
    const once = serializeChangesUrl(first);
    expect(serializeChangesUrl(read(once))).toBe(once);
  });
});

// The hook writes through the router of the pane it renders in, and the
// history entry it makes is the contract of 6.3: moving to another day, week
// or repo pushes, so Back returns to the day before; everything else (the
// focused story, the open drawer, filters) replaces, so Back never walks
// through a reader's clicks.

/** The hook mounted in a pane on `/changes?<qs>`, with the pane's navigations recorded. */
function mountUrlState(qs: string) {
  const calls: [string, "push" | "replace"][] = [];
  let hook!: ReturnType<typeof useChangesUrlState>;
  const Probe = () => {
    hook = useChangesUrlState();
    return null;
  };
  const pane = { tabId: "t1", pathname: "/changes", params: {}, searchParams: new URLSearchParams(qs), isActive: true, navigate: (path: string, mode: "push" | "replace") => void calls.push([path, mode]) };
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TabParamsCtx.Provider, { value: pane }, createElement(Probe))));
  return { ...hook, calls };
}

/** Every `setUrl(...)` call in the page's sources, with its file and argument text. */
function setUrlCalls(): { file: string; args: string }[] {
  return pageSources().flatMap(({ file, code }) => {
    const out: { file: string; args: string }[] = [];
    for (const m of code.matchAll(/\bsetUrl\(/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      for (; i < code.length && depth > 0; i += 1) depth += code[i] === "(" ? 1 : code[i] === ")" ? -1 : 0;
      out.push({ file, args: code.slice(m.index! + m[0].length, i - 1).replace(/\s+/g, " ").trim() });
    }
    return out;
  });
}

const setsKey = (args: string, keys: string) => new RegExp(`[{,]\\s*(?:${keys})\\s*[:,}]`).test(args);
const pushes = (args: string) => /,\s*["']push["']\s*$/.test(args);

describe("the Changes URL in history", () => {
  test("the hook reads the pane's query and writes canonical links, replacing unless told to push", () => {
    const h = mountUrlState("area=web&repo=a/b");
    expect(h.url).toEqual({ ...EMPTY_URL, repo: "a/b", areas: ["web"] });
    h.setUrl({ risk: true });
    h.setUrl({ story: "s_1" });
    h.setUrl((s) => ({ ...s, areas: [...s.areas, "cli"] }));
    h.setUrl({ repo: "c/d", story: undefined }, "push");
    // Each write builds on the one before it, though the router has not committed any of them yet.
    expect(h.calls).toEqual([
      ["/changes?repo=a/b&area=web&risk=1", "replace"],
      ["/changes?repo=a/b&area=web&risk=1&story=s_1", "replace"],
      ["/changes?repo=a/b&area=cli,web&risk=1&story=s_1", "replace"],
      ["/changes?repo=c/d&area=cli,web&risk=1", "push"],
    ]);
  });

  test("rapid presses are not lost: two toggles both stick, and the same key twice toggles back", () => {
    const h = mountUrlState("repo=a/b");
    h.setUrl((s) => ({ ...s, risk: !s.risk }));
    h.setUrl((s) => ({ ...s, branches: s.branches === "all" ? "main" : "all" }));
    expect(h.calls.at(-1)).toEqual(["/changes?repo=a/b&branches=all&risk=1", "replace"]);
    h.setUrl((s) => ({ ...s, risk: !s.risk }));
    expect(h.calls.at(-1)).toEqual(["/changes?repo=a/b&branches=all", "replace"]);
    // Clearing filters keeps the repository and returns to main.
    h.setUrl((s) => ({ ...s, q: "sync" }));
    h.setUrl(clearFilters);
    expect(h.calls.at(-1)).toEqual(["/changes?repo=a/b", "replace"]);
  });

  test("a write that changes nothing makes no history entry", () => {
    const h = mountUrlState("repo=a/b&area=web,cli");
    h.setUrl({ areas: ["web", "cli"] });
    h.setUrl((s) => ({ ...s, q: "  ".trim() || undefined }));
    h.setUrl({ repo: "a/b" }, "push");
    expect(h.calls).toEqual([]);
  });

  test("the page pushes exactly the writes that move to another repository", () => {
    // Pinning the default repository into the URL names the repository already
    // on screen: it moves nothing, so it replaces and Back never stops on it.
    const calls = setUrlCalls().filter((c) => !/^\{ repo: defaultRepo \}/.test(c.args));
    const travels = (args: string) => setsKey(args, "repo");
    const travel = calls.filter((c) => travels(c.args));
    expect(travel.length).toBeGreaterThanOrEqual(1);
    expect(calls.length - travel.length).toBeGreaterThanOrEqual(5);
    const wrong = calls
      .filter((c) => pushes(c.args) !== travels(c.args))
      .map((c) => `${c.file}: setUrl(${c.args})`);
    expect(wrong).toEqual([]);
  });
});
