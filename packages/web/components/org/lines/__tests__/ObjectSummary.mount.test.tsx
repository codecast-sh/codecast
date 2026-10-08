// One summary per kind (cohesive build spec D13, D14), mounted against the
// Union fixture: each kind's name, its head line facts in the one order
// (owner · state · measure · date) and the same words its line says, what it
// serves as names that open, and how much carries it. ObjectSummary finds
// each by its ref, a person by handle.
// Run: cd packages/web && bun test components/org/lines
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../../../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";

async function verifySummaries() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  const fx = await import("../../../company/companyFixture");
  const tree = fx.COMPANY_FIXTURE_TREE;
  const collections: Record<string, any[]> = { initiatives: fx.COMPANY_FIXTURE_INITIATIVES, projects: fx.COMPANY_FIXTURE_PROJECTS, tasks: fx.COMPANY_FIXTURE_TASKS };
  const state: any = { currentUser: { _id: "fixture-user-me" }, orgTree: tree, teamMembers: fx.COMPANY_FIXTURE_ROSTER };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });
  mock.module("../../../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  const realWorkspace = { ...(await import("../../../../hooks/useWorkspaceCollection")) };
  mock.module("../../../../hooks/useWorkspaceCollection", () => ({ ...realWorkspace, useWorkspaceCollection: (key: string) => collections[key] ?? [] }));
  const realInitiatives = { ...(await import("../../../../hooks/useInitiatives")) };
  mock.module("../../../../hooks/useInitiatives", () => ({ ...realInitiatives, useInitiatives: () => collections.initiatives, useBoardTasks: () => collections.tasks, useTasksBackfilled: () => true }));
  const realNow = { ...(await import("../../../../hooks/useCoarseNow")) };
  mock.module("../../../../hooks/useCoarseNow", () => ({ ...realNow, useCoarseNow: () => fx.COMPANY_FIXTURE_NOW, useNowWhen: () => fx.COMPANY_FIXTURE_NOW }));
  const realOrgRoles = { ...(await import("../../../../hooks/useOrgRoles")) };
  mock.module("../../../../hooks/useOrgRoles", () => ({ ...realOrgRoles, useOrgRoles: () => ({ roles: tree.roles, workspace: tree.workspace, roleBotUserIds: new Set<string>() }) }));
  const realRoster = await import("../../../../hooks/useTeamRoster");
  mock.module("../../../../hooks/useTeamRoster", () => ({ ...realRoster, useTeamRosterIdentity: () => fx.COMPANY_FIXTURE_ROSTER }));
  const realNav = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ replace: () => {}, push: () => {} }), usePathname: () => "/org" }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const realRoleFace = { ...(await import("../../RoleFace")) };
  mock.module("../../RoleFace", () => ({ ...realRoleFace, RoleFace: ({ role }: any) => React.createElement("span", { "data-role-face": role.handle }) }));
  const realAssignee = { ...(await import("../../../identity/AssigneeFace")) };
  mock.module("../../../identity/AssigneeFace", () => ({ ...realAssignee, AssigneeFace: ({ info }: any) => React.createElement("span", { "data-face": info.kind === "role" ? `role:${info.handle}` : `person:${info.name}` }) }));

  const { createRoot } = await import("react-dom/client");
  const { ObjectSummary } = await import("../ObjectSummary");
  const { OrgOpenContext } = await import("../../company/orgOpenContext");
  let root = createRoot(document.getElementById("root")!);
  const opened: string[] = [];
  const show = async (kind: string, ref: string, inScreen = false) => {
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    const el = React.createElement(ObjectSummary, { kind: kind as any, ref });
    await act(async () => root.render(inScreen ? React.createElement(OrgOpenContext.Provider, { value: { open: (k: string, r: string) => opened.push(`${k}:${r}`) } }, el) : el));
  };
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  const facts = () => [...q("[data-summary-facts]")!.children].filter((c) => c.tagName !== "SPAN" || c.getAttribute("aria-hidden") !== "true").map((c) => c.textContent);
  const serves = () => [...document.querySelectorAll("[data-summary-serves-item]")].map((a) => a.getAttribute("href"));

  // A goal: owner, health and when it was said, the number now of target, the target day.
  await show("initiative", "in-2");
  assert.equal(q("[data-object-summary]")!.getAttribute("data-object-summary"), "initiative");
  assert.equal(q("[data-summary-title]")!.textContent, "Win the private network");
  const goalFacts = facts();
  assert.equal(goalFacts.length, 4);
  assert.match(goalFacts[0]!, /Ashot Petrosian/);
  assert.match(goalFacts[1]!, /on track/);
  assert.match(goalFacts[2]!, /^17 of 40/);
  assert.ok(q("[data-summary-facts] [data-initiative-target]"));
  assert.equal(q("[data-initiative-pick]"), null, "read only: the pickers live on the line and the sheet");
  assert.deepEqual(serves(), [], "a top level goal serves the mission the header names");
  // What carries it, by name: its projects, then the goals under it, two and a count.
  assert.match(q("[data-summary-carried]")!.textContent!, /^Carried by.+, .+ \+1$/);
  // A goal that feeds another serves it, by a name that opens it.
  await show("initiative", "in-5", true);
  assert.deepEqual(serves(), ["/org/in-2"]);
  await act(async () => { q("[data-summary-serves-item]")!.dispatchEvent(new (dom.window as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
  assert.deepEqual(opened, ["initiative:in-2"], "inside the screen a name opens its sheet");

  // A role, named as the map names it with its title beside: who it reports
  // to, its own word, since when; the goals it drives, and what it carries by
  // name. The facts leave the project it leads to Carries rather than say it twice.
  await show("role", "or-36");
  const { roleWords } = await import("../../orgStaffingTypes");
  const quality = tree.roles.find((r: any) => r.short_id === "or-36")!;
  assert.equal(q("[data-summary-title]")!.textContent, roleWords(quality).name);
  assert.equal(q("[data-summary-sub]")!.textContent, "Agent Quality");
  assert.deepEqual(facts(), ["↳ Ashot Petrosian", "dormant", facts()[2]]);
  assert.match(facts()[2]!, /^since /);
  assert.deepEqual(serves(), ["/org/in-4", "/org/in-1"], "the goal it owns first, then the one its project carries");
  assert.equal(q("[data-summary-carried]")!.textContent, "CarriesAgent Quality");

  // A project: its lead, what is moving, its board's count; the goal it serves; the roles working it.
  await show("project", "pr-12");
  assert.equal(q("[data-summary-title]")!.textContent, "Agent Quality");
  const projectFacts = facts();
  assert.match(projectFacts[0]!, /Agent Quality/);
  assert.match(projectFacts[1]!, /needs input/);
  assert.equal(projectFacts[2], "10 of 18 tasks");
  assert.deepEqual(serves(), ["/org/in-1"]);
  assert.equal(q("[data-summary-carried]")!.textContent, `Carried by${roleWords(quality).name}`);

  // A person, found by handle: their place, presence, what they answer for, since when; the goals they own.
  await show("person", "@ashot");
  assert.match(q("[data-summary-title]")!.textContent!, /^Ashot Petrosian/);
  assert.equal(q("[data-summary-id]")!.textContent, "@ashot", "their handle beside their name");
  // Goals and roles are named on Serves and Carries; the facts keep only what is live now.
  assert.deepEqual(facts().filter((f) => !/^since /.test(f!)), ["owner", "online", ...facts().filter((f) => /at work|waiting on input/.test(f!))]);
  assert.ok(facts().every((f) => !/\bgoal|\brole/.test(f!)), "no goal or role count in the facts");
  assert.deepEqual(serves(), ["/org/in-2"]);
  // The roles they host or that report to them, by name.
  assert.match(q("[data-summary-carried]")!.textContent!, /^Carries\S/);

  // Nothing by that ref: nothing drawn.
  await show("initiative", "in-404");
  assert.equal(q("[data-object-summary]"), null);

  await act(async () => root.unmount());
}

test("object summaries: one per kind, the line's facts in the one order, what it serves and what carries it", async () => {
  await verifySummaries();
}, 300_000);
