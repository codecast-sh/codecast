import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TabParamsCtx } from "../../../lib/tabParams";
import { EMPTY_URL, changesHref, parseChangesUrl, serializeChangesUrl, useChangesUrlState, type ChangesUrl } from "../useChangesUrlState";
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
    const h = mountUrlState("area=web&d=2026-10-02");
    expect(h.url).toEqual({ ...EMPTY_URL, d: "2026-10-02", areas: ["web"] });
    h.setUrl({ risk: true });
    h.setUrl({ story: "s_1" });
    h.setUrl((s) => ({ ...s, areas: [...s.areas, "cli"] }));
    h.setUrl({ d: "2026-10-01", story: undefined }, "push");
    expect(h.calls).toEqual([
      ["/changes?d=2026-10-02&area=web&risk=1", "replace"],
      ["/changes?d=2026-10-02&area=web&story=s_1", "replace"],
      ["/changes?d=2026-10-02&area=cli,web", "replace"],
      ["/changes?d=2026-10-01&area=web", "push"],
    ]);
  });

  test("a write that changes nothing makes no history entry", () => {
    const h = mountUrlState("d=2026-10-02&area=web,cli");
    h.setUrl({ areas: ["web", "cli"] });
    h.setUrl((s) => ({ ...s, q: "  ".trim() || undefined }));
    h.setUrl({ d: "2026-10-02" }, "push");
    expect(h.calls).toEqual([]);
  });

  test("the page pushes exactly the writes that move to another day, week or repo", () => {
    const calls = setUrlCalls();
    const travel = calls.filter((c) => setsKey(c.args, "d|w|repo"));
    // The scan sees the page: day and week travel, the repo picker, and the story and filter writes.
    expect(travel.length).toBeGreaterThanOrEqual(5);
    expect(calls.length - travel.length).toBeGreaterThanOrEqual(8);
    const wrong = calls
      .filter((c) => pushes(c.args) !== setsKey(c.args, "d|w|repo"))
      .map((c) => `${c.file}: setUrl(${c.args})`);
    expect(wrong).toEqual([]);
  });
});
