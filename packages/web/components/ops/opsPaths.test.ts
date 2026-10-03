import { describe, expect, test } from "bun:test";
import { OPS_TABS, isOpsPath, opsHref, opsTabLabel, parseOpsPath } from "./opsPaths";

describe("parseOpsPath", () => {
  test("/ops is the timeline; each tab has its own segment", () => {
    expect(parseOpsPath("/ops")).toEqual({ view: "tab", tab: "timeline", source: null, app: null });
    expect(parseOpsPath("/ops/")).toEqual({ view: "tab", tab: "timeline", source: null, app: null });
    expect(parseOpsPath("/ops/issues", "source=union")).toEqual({ view: "tab", tab: "issues", source: "union", app: null });
    expect(parseOpsPath("/ops/apps", "app=src-4")).toEqual({ view: "tab", tab: "apps", source: null, app: "src-4" });
  });

  test("detail pages carry their id, and a replay its scrubber time", () => {
    expect(parseOpsPath("/ops/issues/eg-12")).toEqual({ view: "issue", id: "eg-12" });
    expect(parseOpsPath("/ops/replays/rp-3", "t=4200")).toEqual({ view: "replay", id: "rp-3", t: 4200 });
    expect(parseOpsPath("/ops/replays/rp-3", "t=-1")).toEqual({ view: "replay", id: "rp-3", t: null });
    expect(parseOpsPath("/ops/replays/rp-3")).toEqual({ view: "replay", id: "rp-3", t: null });
  });

  test("anything else names no view", () => {
    expect(parseOpsPath("/ops/timeline").view).toBe("not-found");
    expect(parseOpsPath("/ops/nope").view).toBe("not-found");
    expect(parseOpsPath("/ops/issues/eg-1/extra").view).toBe("not-found");
    expect(parseOpsPath("/ops/metrics/x").view).toBe("not-found");
    expect(parseOpsPath("/ops/issues/%E0%A4%A").view).toBe("not-found");
    expect(parseOpsPath("/line").view).toBe("not-found");
  });
});

describe("opsHref", () => {
  test("every href parses back to the view it was built from", () => {
    for (const tab of OPS_TABS) {
      expect(parseOpsPath(...split(opsHref.tab(tab, { source: "web" })))).toEqual({ view: "tab", tab, source: "web", app: null });
    }
    expect(parseOpsPath(...split(opsHref.issue("eg-7")))).toEqual({ view: "issue", id: "eg-7" });
    expect(parseOpsPath(...split(opsHref.replay("rp 9", 1500)))).toEqual({ view: "replay", id: "rp 9", t: 1500 });
    expect(opsHref.tab("timeline")).toBe("/ops");
  });

  test("tab labels name the place", () => {
    expect(opsTabLabel("/ops")).toBe("Ops");
    expect(opsTabLabel("/ops/issues?source=x")).toBe("Ops · Issues");
    expect(opsTabLabel("/ops/issues/eg-3")).toBe("eg-3");
  });
});

function split(href: string): [string, string] {
  const [p, q] = href.split("?");
  return [p, q ?? ""];
}

describe("isOpsPath", () => {
  test("the area and nothing that only starts with its letters", () => {
    expect(["/ops", "/ops/issues", "/ops?source=x", "/ops/replays/rp-1"].every(isOpsPath)).toBe(true);
    expect(["/opsx", "/optics", "/", "", null].some((p) => isOpsPath(p))).toBe(false);
  });
});
