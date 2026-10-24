import { describe, expect, test } from "bun:test";
import { grantPagePath } from "@codecast/shared/contracts/appConnector";
import { OPS_TABS, isOpsPath, opsHref, opsTabLabel, opsViewHref, opsViewOf, parseOpsPath } from "./opsPaths";

describe("parseOpsPath", () => {
  test("/ops is the timeline; each tab has its own segment", () => {
    expect(parseOpsPath("/ops")).toEqual({ view: "tab", tab: "timeline", source: null, app: null });
    expect(parseOpsPath("/ops/")).toEqual({ view: "tab", tab: "timeline", source: null, app: null });
    expect(parseOpsPath("/ops/issues", "source=union")).toEqual({ view: "tab", tab: "issues", source: "union", app: null });
    expect(parseOpsPath("/ops/apps", "app=src-4")).toEqual({ view: "tab", tab: "apps", source: null, app: "src-4" });
  });

  test("the grant page a refusal or the CLI names is the Apps tab on that source", () => {
    expect(grantPagePath("src-4")).toBe(opsHref.tab("apps", { app: "src-4" }));
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
  test("every view lives under Signals, and its address reads back as the same view", () => {
    for (const tab of OPS_TABS) {
      expect(read(opsHref.tab(tab, { source: "web" }))).toEqual({ view: "tab", tab, source: "web", app: null });
    }
    expect(read(opsHref.issue("eg-7"))).toEqual({ view: "issue", id: "eg-7" });
    expect(read(opsHref.replay("rp 9", 1500))).toEqual({ view: "replay", id: "rp 9", t: 1500 });
    expect(opsHref.tab("issues", { source: "web" })).toBe("/flows?view=signals&sig=issues&source=web");
  });

  test("an old /ops address goes to the same view under Signals", () => {
    expect(opsViewHref(parseOpsPath("/ops/issues", "source=union"))).toBe(opsHref.tab("issues", { source: "union" }));
    expect(opsViewHref(parseOpsPath("/ops/issues/eg-3"))).toBe(opsHref.issue("eg-3"));
    expect(opsViewHref(parseOpsPath("/ops/replays/rp-1", "t=20"))).toBe(opsHref.replay("rp-1", 20));
    expect(opsViewHref(parseOpsPath("/ops/nope"))).toBe("/flows?view=signals");
  });

  test("Signals' own list names no source view", () => {
    expect(opsViewOf({ sig: null, source: null, app: null, item: null, t: null })).toBeNull();
    expect(opsViewOf({ sig: "nope", source: null, app: null, item: null, t: null })).toBeNull();
  });

  test("tab labels name the place", () => {
    expect(opsTabLabel("/ops/issues?source=x")).toBe("Signals · Issues");
    expect(opsTabLabel(opsHref.tab("replays"))).toBe("Signals · Replays");
    expect(opsTabLabel("/ops/issues/eg-3")).toBe("eg-3");
    expect(opsTabLabel(opsHref.issue("eg-4"))).toBe("eg-4");
  });
});

function read(href: string) {
  const q = new URL(href, "https://x").searchParams;
  return opsViewOf({ sig: q.get("sig"), source: q.get("source"), app: q.get("app"), item: q.get("item"), t: q.get("t") });
}

describe("isOpsPath", () => {
  test("the area and nothing that only starts with its letters", () => {
    expect(["/ops", "/ops/issues", "/ops?source=x", "/ops/replays/rp-1", opsHref.tab("metrics")].every(isOpsPath)).toBe(true);
    expect(["/flows", "/flows?view=signals"].some((p) => isOpsPath(p))).toBe(false);
    expect(["/opsx", "/optics", "/", "", null].some((p) => isOpsPath(p))).toBe(false);
  });
});
