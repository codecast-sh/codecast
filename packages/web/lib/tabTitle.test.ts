import { expect, test } from "bun:test";
import { initiativeTabTitle, tabTitle } from "./tabTitle";

const initiatives = {
  team: { title: "Team plan", short_id: "in-1", workspace: "team:a" },
  personal: { title: "Private plan", short_id: "in-2", workspace: "user:me", team_id: "a" },
  other: { title: "Other plan", short_id: "in-3", workspace: "team:b" },
};

test("initiative titles resolve ids and short ids only in the active workspace", () => {
  expect(initiativeTabTitle("/initiatives/team", initiatives, "team:a")).toBe("Team plan");
  expect(initiativeTabTitle("/initiatives/IN-1?tab=tasks", initiatives, "team:a")).toBe("Team plan");
  expect(initiativeTabTitle("/initiatives/personal", initiatives, "team:a")).toBeNull();
  expect(initiativeTabTitle("/initiatives/in-2", initiatives, "team:a")).toBeNull();
  expect(initiativeTabTitle("/initiatives/in-2", initiatives, "user:me")).toBe("Private plan");
  expect(initiativeTabTitle("/initiatives/in-3", initiatives, "team:a")).toBeNull();
  expect(initiativeTabTitle("/initiatives/in-1", initiatives, null)).toBeNull();
  // A goal's sheet, and the old addresses a saved tab still carries.
  expect(initiativeTabTitle("/org/in-1", initiatives, "team:a")).toBe("Team plan");
  expect(initiativeTabTitle("/goals/in-1", initiatives, "team:a")).toBe("Team plan");
  expect(initiativeTabTitle("/org/or-1", initiatives, "team:a")).toBeNull();
  expect(initiativeTabTitle("/goalsx/in-1", initiatives, "team:a")).toBeNull();
});

test("tab titles forward the workspace boundary", () => {
  const tab = { id: "t", path: "/initiatives/in-2" };
  expect(tabTitle(tab as any, {}, {}, [], "me", initiatives, "user:me")).toBe("Private plan");
  expect(tabTitle(tab as any, {}, {}, [], "me", initiatives, "team:a")).not.toBe("Private plan");
});

test("a task, project or run tab reads its record's name, and never its id", () => {
  const RUN = "th75y63rm5emhbrsb3y79g6rv58fn8qq";
  const PROJECT = "sd7dqnq9hny1dtzy83as2av4z18c9z2z";
  const records = { workflowRuns: { [RUN]: { task_short_id: "ct-56750", workflow_name: "line" } }, projects: { [PROJECT]: { title: "Codecast: Product" } } };
  const tab = (path: string) => ({ id: "t", path, title: "", createdAt: 0 }) as any;
  expect(tabTitle(tab(`/workflows/runs/${RUN}`), {}, {}, [], "me", {}, "team:a", records)).toBe("ct-56750 run");
  expect(tabTitle(tab(`/projects/${PROJECT}?tab=line`), {}, {}, [], "me", {}, "team:a", records)).toBe("Codecast: Product");
  expect(tabTitle(tab(`/workflows/runs/${RUN}`), {}, {})).toBe("Run");
  expect(tabTitle(tab(`/projects/${PROJECT}`), {}, {})).toBe("Project");
  expect(tabTitle(tab("/projects/pj-12"), {}, {})).toBe("Project");
});

test("a board by its pj- id, and a role, a person and a project on the Org screen, read their names", () => {
  const PROJECT = "sd7dqnq9hny1dtzy83as2av4z18c9z2z";
  const records = {
    projects: { [PROJECT]: { _id: PROJECT, short_id: "pj-mf3k2a", title: "Lead lists" } },
    orgTree: { roles: [{ _id: "r7", short_id: "or-7", name: "Calling lead", handle: "calling" }] },
    teamMembers: [{ _id: "u1", name: "Samvit", github_username: "samvit" }],
  };
  const tab = (path: string) => ({ id: "t", path, title: "", createdAt: 0 }) as any;
  expect(tabTitle(tab("/projects/pj-mf3k2a"), {}, {}, [], "me", {}, "team:a", records)).toBe("Lead lists");
  expect(tabTitle(tab("/org/pj-mf3k2a"), {}, {}, [], "me", {}, "team:a", records)).toBe("Lead lists");
  expect(tabTitle(tab("/org/or-7"), {}, {}, [], "me", {}, "team:a", records)).toBe("Calling lead");
  expect(tabTitle(tab("/org/@samvit"), {}, {}, [], "me", {}, "team:a", records)).toBe("Samvit");
  expect(tabTitle(tab("/org/or-8"), {}, {}, [], "me", {}, "team:a", records)).toBe("Role or-8");
});
