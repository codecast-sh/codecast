import { describe, expect, test } from "bun:test";
import { grantPagePath } from "@codecast/shared/contracts/appConnector";
import { OPS_TABS, isOpsPath, opsHref, opsRefHref, opsTabLabel, opsUpHref, opsViewHref, opsViewOf, parseOpsPath, sourceConnectHref } from "./opsPaths";

describe("parseOpsPath", () => {
  test("/ops is the home; each tab has its own segment", () => {
    expect(parseOpsPath("/ops")).toEqual({ view: "home", source: null, show: null });
    expect(parseOpsPath("/ops/")).toEqual({ view: "home", source: null, show: null });
    expect(parseOpsPath("/ops", "show=alerting&source=web")).toEqual({ view: "home", source: "web", show: "alerting" });
    expect(parseOpsPath("/ops", "show=bogus")).toEqual({ view: "home", source: null, show: null });
    // An older link's `spiking` is the Escalating filter, and links are written with the new name.
    expect(parseOpsPath("/ops", "show=spiking")).toEqual({ view: "home", source: null, show: "escalating" });
    expect(opsHref.home({ show: "escalating" })).toBe("/ops?show=escalating");
    // An unknown page under /ops is said, never the home under a wrong address.
    expect(parseOpsPath("/ops/bogus")).toEqual({ view: "not-found", path: "/ops/bogus" });
    expect(parseOpsPath("/ops/timeline")).toEqual({ view: "tab", tab: "timeline", source: null, app: null });
    expect(parseOpsPath("/ops/issues", "source=union")).toEqual({ view: "tab", tab: "issues", source: "union", app: null });
    expect(parseOpsPath("/ops/apps", "app=src-4")).toEqual({ view: "tab", tab: "apps", source: null, app: "src-4" });
  });

  test("the grant page a refusal or the CLI names is the Apps tab on that source", () => {
    expect(grantPagePath("src-4")).toBe(opsHref.tab("apps", { app: "src-4" }));
  });

  test("detail pages carry their id, and a replay its scrubber time", () => {
    expect(parseOpsPath("/ops/issues/eg-12")).toEqual({ view: "issue", id: "eg-12" });
    // Seconds, as the vendors write them; a bare integer also carries its older ms reading for the page to weigh against the length.
    expect(parseOpsPath("/ops/replays/rp-3", "t=4200")).toEqual({ view: "replay", id: "rp-3", t: 4_200_000, t_alt: 4200 });
    expect(parseOpsPath("/ops/replays/rp-3", "t=83.2")).toEqual({ view: "replay", id: "rp-3", t: 83_200 });
    expect(parseOpsPath("/ops/replays/rp-3", "t=2h0m0s")).toEqual({ view: "replay", id: "rp-3", t: 7_200_000 });
    expect(parseOpsPath("/ops/replays/rp-3", "t=1:02:03")).toEqual({ view: "replay", id: "rp-3", t: 3_723_000 });
    expect(parseOpsPath("/ops/replays/rp-3", "t=x")).toEqual({ view: "replay", id: "rp-3", t: null });
    expect(parseOpsPath("/ops/replays/rp-3", "t=-1")).toEqual({ view: "replay", id: "rp-3", t: null });
    expect(parseOpsPath("/ops/replays/rp-3")).toEqual({ view: "replay", id: "rp-3", t: null });
    expect(parseOpsPath("/ops/metrics/mw-8")).toEqual({ view: "metric", id: "mw-8" });
  });

  test("anything else names no view", () => {
    expect(parseOpsPath("/ops/nope").view).toBe("not-found");
    expect(parseOpsPath("/ops/timeline/x").view).toBe("not-found");
    expect(parseOpsPath("/ops/issues/eg-1/extra").view).toBe("not-found");
    expect(parseOpsPath("/ops/metrics/mw-1/extra").view).toBe("not-found");
    expect(parseOpsPath("/ops/issues/%E0%A4%A").view).toBe("not-found");
    expect(parseOpsPath("/line").view).toBe("not-found");
  });
});

describe("opsHref", () => {
  test("every view's address reads back as that view", () => {
    for (const tab of OPS_TABS) {
      expect(read(opsHref.tab(tab, { source: "web" }))).toEqual({ view: "tab", tab, source: "web", app: null });
    }
    expect(read(opsHref.home({ show: "new" }))).toEqual({ view: "home", source: null, show: "new" });
    expect(read(opsHref.issue("eg-7"))).toEqual({ view: "issue", id: "eg-7" });
    expect(read(opsHref.replay("rp 9", 1500))).toEqual({ view: "replay", id: "rp 9", t: 1500 });
    expect(read(opsHref.metric("mw-8"))).toEqual({ view: "metric", id: "mw-8" });
    expect(opsHref.metric("mw-8")).toBe("/ops/metrics/mw-8");
    expect(opsHref.tab("issues", { source: "web" })).toBe("/ops/issues?source=web");
    expect(opsHref.home()).toBe("/ops");
  });

  test("an old Signals address goes to the same view under /ops", () => {
    expect(opsViewHref(oldView("sig=issues&source=union"))).toBe("/ops/issues?source=union");
    expect(opsViewHref(oldView("sig=issues&item=eg-3"))).toBe("/ops/issues/eg-3");
    expect(opsViewHref(oldView("sig=replays&item=rp-1&t=20"))).toBe("/ops/replays/rp-1?t=20");
    expect(opsViewHref(oldView("sig=metrics&item=mw-8"))).toBe("/ops/metrics/mw-8");
    expect(opsViewHref(parseOpsPath("/ops/nope"))).toBe("/ops");
  });

  test("Signals' own list names no source view", () => {
    expect(opsViewOf({ sig: null, source: null, app: null, item: null, t: null })).toBeNull();
    expect(opsViewOf({ sig: "nope", source: null, app: null, item: null, t: null })).toBeNull();
  });

  test("tab labels name the item, its tab and Ops", () => {
    expect(opsTabLabel("/ops")).toBe("Ops");
    expect(opsTabLabel("/ops/issues?source=x")).toBe("Issues · Ops");
    expect(opsTabLabel(opsHref.tab("replays"))).toBe("Replays · Ops");
    expect(opsTabLabel("/ops/issues/eg-3")).toBe("eg-3 · Issues · Ops");
    expect(opsTabLabel("/flows?view=signals&sig=issues&item=eg-4")).toBe("eg-4 · Issues · Ops");
    expect(opsTabLabel(opsHref.metric("mw-2"))).toBe("mw-2 · Metrics · Ops");
  });
});

describe("opsUpHref", () => {
  test("up follows the crumbs: item to tab, tab to its source, source to Ops", () => {
    expect(opsUpHref(parseOpsPath("/ops/issues/eg-3"))).toBe("/ops/issues");
    expect(opsUpHref(parseOpsPath("/ops/metrics/mw-3"))).toBe("/ops/metrics");
    expect(opsUpHref(parseOpsPath("/ops/issues", "source=web"))).toBe("/ops?source=web");
    expect(opsUpHref(parseOpsPath("/ops/apps", "app=src-4&source=web"))).toBe("/ops/apps?source=web");
    expect(opsUpHref(parseOpsPath("/ops/issues"))).toBe("/ops");
    expect(opsUpHref(parseOpsPath("/ops", "show=new&source=web"))).toBe("/ops?source=web");
    expect(opsUpHref(parseOpsPath("/ops", "source=web"))).toBe("/ops");
    expect(opsUpHref(parseOpsPath("/ops", "show=new"))).toBe("/ops");
    expect(opsUpHref(parseOpsPath("/ops"))).toBeNull();
  });
});

function read(href: string) {
  const [pathname, query] = href.split("?");
  return parseOpsPath(pathname, query ?? "");
}

function oldView(query: string) {
  const q = new URLSearchParams(query);
  return opsViewOf({ sig: q.get("sig"), source: q.get("source"), app: q.get("app"), item: q.get("item"), t: q.get("t") })!;
}

describe("isOpsPath", () => {
  test("the area and nothing that only starts with its letters", () => {
    expect(["/ops", "/ops/issues", "/ops?source=x", "/ops/replays/rp-1", opsHref.tab("metrics"), "/flows?view=signals&sig=issues"].every(isOpsPath)).toBe(true);
    expect(["/flows", "/flows?view=signals"].some((p) => isOpsPath(p))).toBe(false);
    expect(["/opsx", "/optics", "/", "", null].some((p) => isOpsPath(p))).toBe(false);
  });
});

describe("opsRefHref", () => {
  test("a typed eg-N, mw-N, rp-N or src-N opens its item; anything else is not a ref", () => {
    expect(opsRefHref(" EG-884 ")).toEqual({ ref: "eg-884", kind: "issue", href: "/ops/issues/eg-884" });
    expect(opsRefHref("mw-3")?.href).toBe("/ops/metrics/mw-3");
    expect(opsRefHref("rp-12")?.href).toBe("/ops/replays/rp-12");
    expect(opsRefHref("src-2")?.href).toBe("/ops?source=src-2");
    expect(opsRefHref("ct-2")).toBeNull();
    expect(opsRefHref("eg-")).toBeNull();
  });
});

test("each provider's connect tile opens its own add form; GitHub opens its connection", () => {
  expect(sourceConnectHref("sentry")).toBe("/settings/integrations?add=sentry#product-sources");
  expect(sourceConnectHref("sdk")).toBe("/settings/integrations?add=sdk#product-sources");
  expect(sourceConnectHref("github")).toBe("/settings/integrations");
});
