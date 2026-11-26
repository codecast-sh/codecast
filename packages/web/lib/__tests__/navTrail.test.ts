// The trail behind Modern's back control (lib/navTrail) and the place every
// page sits in (lib/navPlace). A trail is the way back, not browser history:
// moving on pushes, going back pops, stepping through a list replaces, a
// cold link has no trail and goes up to the page's parent instead, a reload
// keeps the trail, and each app tab (and each browser tab) has its own.
// Run: cd packages/web && bun test --isolate lib/__tests__/navTrail.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh/inbox" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage });
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const { stepTrail, backEntry, recordTrail, trailOf, _resetTrailForTests, TRAIL_CAP } = await import("../navTrail");
const { placeOf, placeSection, placeKey, crumbsForTitle } = await import("../navPlace");

const walk = (paths: Array<[string, "push" | "traverse" | "back" | "up"]>) =>
  paths.reduce((trail, [path, move], i) => stepTrail(trail, path, move, i), [] as ReturnType<typeof stepTrail>);
const paths = (t: { path: string }[]) => t.map((e) => e.path);

beforeEach(() => {
  dom.window.sessionStorage.clear();
  _resetTrailForTests();
});

describe("stepTrail", () => {
  test("a move pushes, and back names the page before", () => {
    const t = walk([["/inbox", "push"], ["/inbox?s=s1", "push"], ["/tasks/ct-1", "push"]]);
    expect(paths(t)).toEqual(["/inbox", "/inbox?s=s1", "/tasks/ct-1"]);
    expect(backEntry(t, "/tasks/ct-1")?.path).toBe("/inbox?s=s1");
  });

  test("the back control pops to the entry it named, however deep", () => {
    const t = walk([["/docs", "push"], ["/tasks", "push"], ["/tasks/ct-1", "push"], ["/docs", "back"]]);
    expect(paths(t)).toEqual(["/docs"]);
  });

  test("a browser history step onto the entry below pops; any other step pushes", () => {
    const base = walk([["/tasks", "push"], ["/tasks/ct-1", "push"]]);
    expect(paths(stepTrail(base, "/tasks", "traverse", 9))).toEqual(["/tasks"]);
    expect(paths(stepTrail(base, "/docs", "traverse", 9))).toEqual(["/tasks", "/tasks/ct-1", "/docs"]);
  });

  test("going up from an item to the list it was opened from pops, as closing it does", () => {
    const t = walk([["/inbox", "push"], ["/tasks", "push"], ["/tasks/ct-1", "push"], ["/tasks", "push"]]);
    expect(paths(t)).toEqual(["/inbox", "/tasks"]);
  });

  test("a link back to the page you came from is a move, not a step back", () => {
    const t = walk([["/docs/d1", "push"], ["/inbox?s=s1", "push"], ["/docs/d1", "push"]]);
    expect(paths(t)).toEqual(["/docs/d1", "/inbox?s=s1", "/docs/d1"]);
    expect(backEntry(t, "/docs/d1")?.path).toBe("/inbox?s=s1");
  });

  test("stepping through the list you came from replaces: Back still says the list", () => {
    const t = walk([["/tasks", "push"], ["/tasks/ct-1", "push"], ["/tasks/ct-2", "push"], ["/tasks/ct-3", "push"]]);
    expect(paths(t)).toEqual(["/tasks", "/tasks/ct-3"]);
    const inbox = walk([["/inbox", "push"], ["/inbox?s=a", "push"], ["/inbox?s=b", "push"]]);
    expect(paths(inbox)).toEqual(["/inbox", "/inbox?s=b"]);
  });

  test("a subtask opened from a task opened elsewhere pushes: Back returns to the task", () => {
    const t = walk([["/inbox?s=s1", "push"], ["/tasks/ct-1", "push"], ["/tasks/ct-2", "push"]]);
    expect(paths(t)).toEqual(["/inbox?s=s1", "/tasks/ct-1", "/tasks/ct-2"]);
  });

  test("the same place in another spelling or view takes the newer address", () => {
    const t = walk([["/tasks", "push"], ["/tasks?view=board", "push"]]);
    expect(paths(t)).toEqual(["/tasks?view=board"]);
    const conv = walk([["/conversation/s1", "push"], ["/inbox?s=s1", "push"]]);
    expect(paths(conv)).toEqual(["/inbox?s=s1"]);
    const plan = walk([["/plans", "push"], ["/plans?plan=pl-1", "push"]]);
    expect(paths(plan)).toEqual(["/plans", "/plans?plan=pl-1"]);
  });

  test("a cold link has no trail; going up replaces the page with its parent", () => {
    const cold = walk([["/tasks/ct-9", "push"]]);
    expect(backEntry(cold, "/tasks/ct-9")).toBeNull();
    expect(placeOf("/tasks/ct-9").parent).toEqual({ label: "Tasks", href: "/tasks" });
    expect(paths(stepTrail(cold, "/tasks", "up", 2))).toEqual(["/tasks"]);
  });

  test("a trail that has not caught up with the page yet points at its last step", () => {
    const t = walk([["/tasks", "push"]]);
    expect(backEntry(t, "/tasks/ct-1")?.path).toBe("/tasks");
  });

  test("the oldest steps fall off past the cap", () => {
    const t = walk(Array.from({ length: TRAIL_CAP + 5 }, (_, i) => [`/docs/d${i}`, "push"] as [string, "push"]));
    expect(t.length).toBe(TRAIL_CAP);
    expect(t[0].path).toBe("/docs/d5");
  });
});

describe("the per-tab store", () => {
  test("each app tab keeps its own trail, and a closed tab's trail goes", () => {
    recordTrail("tab-a", "/tasks", "push", "Tasks", ["tab-a", "tab-b"]);
    recordTrail("tab-a", "/tasks/ct-1", "push", "Fix login", ["tab-a", "tab-b"]);
    recordTrail("tab-b", "/docs", "push", "Docs", ["tab-a", "tab-b"]);
    expect(paths(trailOf("tab-a") as any)).toEqual(["/tasks", "/tasks/ct-1"]);
    expect(paths(trailOf("tab-b") as any)).toEqual(["/docs"]);
    recordTrail("tab-a", "/inbox", "push", "Inbox", ["tab-a"]);
    expect(trailOf("tab-b")).toEqual([]);
  });

  test("a reload of the browser tab keeps the trail (sessionStorage), and nothing else holds it", () => {
    recordTrail("tab-a", "/tasks", "push", "Tasks");
    recordTrail("tab-a", "/tasks/ct-1", "push", "Fix login");
    _resetTrailForTests();
    expect(trailOf("tab-a").map((e) => [e.path, e.title])).toEqual([["/tasks", "Tasks"], ["/tasks/ct-1", "Fix login"]]);
    expect(dom.window.localStorage.length).toBe(0);
  });

  test("another browser tab starts with no trail", () => {
    recordTrail("tab-a", "/tasks", "push", "Tasks");
    dom.window.sessionStorage.clear();
    _resetTrailForTests();
    expect(trailOf("tab-a")).toEqual([]);
  });
});

describe("placeOf", () => {
  test("Section › Parent for nested things, the parent being where Back goes up to", () => {
    const names = { title: (type: string, id: string) => (type === "project" && id === "pj-1" ? "Onboarding" : undefined) } as const;
    const projectTask = placeOf("/projects/pj-1/ct-4", names as any);
    expect(projectTask.crumbs.map((c) => c.label)).toEqual(["Projects", "Onboarding"]);
    expect(projectTask.parent).toEqual({ label: "Onboarding", href: "/projects/pj-1" });
    const planTask = placeOf("/tasks/ct-4", { taskPlan: () => ({ id: "p1", short_id: "pl-7", title: "Launch" }) });
    expect(planTask.crumbs.map((c) => [c.label, c.href])).toEqual([["Tasks", "/tasks"], ["Launch", "/plans/pl-7"]]);
    expect(placeOf("/pr/acme/web/42").crumbs.map((c) => c.label)).toEqual(["Code", "acme/web", "Pull requests"]);
    expect(placeOf("/ops/issues/eg-3").crumbs.map((c) => c.label)).toEqual(["Ops", "Issues"]);
    expect(placeOf("/memory").crumbs).toEqual([{ label: "More", more: true }]);
    expect(placeOf("/memory").parent).toBeNull();
  });

  test("a session's place is the inbox, in either spelling", () => {
    expect(placeKey("/conversation/s1")).toBe(placeKey("/inbox?s=s1"));
    expect(placeOf("/inbox?s=s1").parent).toEqual({ label: "Inbox", href: "/inbox" });
    expect(placeOf("/inbox").parent).toBeNull();
  });

  test("every object page lights the section that holds it", () => {
    expect(placeSection("/conversation/s1")).toBe("inbox");
    expect(placeSection("/pr/acme/web/42")).toBe("code");
    expect(placeSection("/workflows/runs/r1")).toBe("workflows");
    expect(placeSection("/team/ada")).toBe("org");
    expect(placeSection("/team/activity")).toBe("activity");
    expect(placeSection("/o/obj-1")).toBe("mods");
    expect(placeSection("/memory")).toBe("memory");
  });

  test("a header whose title already names a crumb draws no crumbs", () => {
    expect(crumbsForTitle(placeOf("/ops/issues/eg-3").crumbs, "Ops")).toEqual([]);
    expect(crumbsForTitle(placeOf("/tasks/ct-1").crumbs, "Fix login").map((c) => c.label)).toEqual(["Tasks"]);
  });
});
