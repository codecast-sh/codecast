// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { buildBreadcrumbs, SECTION_LABELS } from "../breadcrumbs";

const lookups = {
  project: (id) => ({ p1: { title: "Codecast: Product", color: "cyan" } })[id],
  task: (id) => ({ t1: { short_id: "ct-4102", title: "Fix the auth race" } })[id],
  doc: (id) => ({ d1: { title: "Sync design notes" } })[id],
  plan: (id) => ({ pl1: { title: "Restore acquisition", short_id: "pl-306" } })[id],
  channel: (id) => ({ c1: { name: "general" } })[id],
};

const labels = (path, l = lookups) => buildBreadcrumbs(path, l).map((c) => c.label);
const ids = (path, l = lookups) => buildBreadcrumbs(path, l).map((c) => c.shortId);

describe("buildBreadcrumbs", () => {
  it("names a bare section", () => {
    expect(labels("/tasks")).toEqual(["Tasks"]);
    expect(labels("/projects")).toEqual(["Projects"]);
  });

  it("returns nothing for the root or an unknown section", () => {
    expect(buildBreadcrumbs("/")).toEqual([]);
    expect(buildBreadcrumbs("")).toEqual([]);
    expect(buildBreadcrumbs("/nonsense/x")).toEqual([]);
  });

  it("puts a task under its section", () => {
    expect(labels("/tasks/t1")).toEqual(["Tasks", "Fix the auth race"]);
    expect(ids("/tasks/t1")).toEqual([undefined, "ct-4102"]);
  });

  it("puts a task opened inside a project under THAT project, not under Tasks", () => {
    expect(labels("/projects/p1/t1")).toEqual([
      "Projects",
      "Codecast: Product",
      "Fix the auth race",
    ]);
  });

  it("links every crumb but the last, which is where you already are", () => {
    const crumbs = buildBreadcrumbs("/projects/p1/t1", lookups);
    expect(crumbs.map((c) => c.href)).toEqual(["/projects", "/projects/p1", undefined]);
  });

  it("leaves a lone section crumb unlinked too", () => {
    expect(buildBreadcrumbs("/tasks", lookups)[0].href).toBeUndefined();
  });

  it("carries kind and id so the bar can mark a crumb", () => {
    const crumbs = buildBreadcrumbs("/projects/p1/t1", lookups);
    expect(crumbs.map((c) => c.kind)).toEqual(["section", "project", "task"]);
    expect(crumbs[1].id).toBe("p1");
  });

  it("falls back to the raw id when the entity isn't loaded yet", () => {
    // A crumb must never render blank while the store catches up.
    expect(labels("/tasks/unknown-id", {})).toEqual(["Tasks", "unknown-id"]);
    expect(labels("/projects/p9/t9", {})).toEqual(["Projects", "p9", "t9"]);
  });

  it("never renders a raw Convex id — the crumb names the kind until the row loads", () => {
    const raw = "jx7bpagx1jct409wgrkdqcn4558d7560";
    const [, task] = buildBreadcrumbs(`/tasks/${raw}`, {});
    expect(task.label).toBe("Task");
    expect(task.shortId).toBeUndefined();
  });

  it("uses whichever name field the entity carries", () => {
    expect(labels("/chat/c1")).toEqual(["Chat", "general"]);
    expect(labels("/docs/d1")).toEqual(["Docs", "Sync design notes"]);
  });

  it("keeps the short id beside the name, not spliced into it", () => {
    const [, leaf] = buildBreadcrumbs("/plans/pl1", lookups);
    expect(leaf.label).toBe("Restore acquisition");
    expect(leaf.shortId).toBe("pl-306");
  });

  it("uses the short id as the label when there is no name yet", () => {
    const [, leaf] = buildBreadcrumbs("/tasks/t9", { task: () => ({ short_id: "ct-9" }) });
    expect(leaf.label).toBe("ct-9");
  });

  it("truncates a long title rather than letting it run the width", () => {
    const long = "x".repeat(200);
    const [, leaf] = buildBreadcrumbs("/docs/d9", { doc: () => ({ title: long }) });
    expect(leaf.label.length).toBeLessThanOrEqual(70);
    expect(leaf.label.endsWith("…")).toBe(true);
  });

  it("collapses whitespace so a wrapped title stays one line", () => {
    const [, leaf] = buildBreadcrumbs("/docs/d9", { doc: () => ({ title: "a\n  b   c" }) });
    expect(leaf.label).toBe("a b c");
  });

  it("reads the feed as its own section, not as a child of Team", () => {
    expect(labels("/team/activity")).toEqual(["Feed"]);
  });

  it("stops at the section for surfaces with no detail route", () => {
    expect(labels("/sessions")).toEqual(["Sessions"]);
    expect(labels("/files")).toEqual(["Files"]);
    expect(labels("/triggers")).toEqual(["Triggers"]);
  });

  it("names every section the rail can reach", () => {
    for (const [seg, label] of Object.entries(SECTION_LABELS)) {
      expect(labels(`/${seg}`)).toEqual([label]);
    }
  });
});
