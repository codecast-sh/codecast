// The company document (docs/architecture/initiatives-projects-role-page.md
// I5), mounted in jsdom against the Union shaped fixture. Proves: the four
// sections in reading order; a goal's heading with its owner, status, health,
// number with its trend, next milestone and target, then why and done when; a
// goal that feeds another under it; projects as rows with lead, status, last
// change and counts; the projects no goal carries; roles and people with what
// they lead and own; the contents list on a wide screen; an open proposal's
// changes drawn in place, with Accept and Skip reaching the store action
// with what that proposal showed; and the phone layout.
// Run: bun test components/company/CompanyDocument.mount.test.tsx
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";
import type { OrgTree } from "../org/orgTypes";

async function verifyCompany() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  // ── the world the document reads ──
  const fx = await import("./companyFixture");
  const env = { phone: false, wide: true, tree: fx.COMPANY_FIXTURE_TREE as OrgTree | null };
  const calls: string[] = [];
  const collections: Record<string, any[]> = { initiatives: fx.COMPANY_FIXTURE_INITIATIVES, projects: fx.COMPANY_FIXTURE_PROJECTS };
  const TEAM = fx.COMPANY_FIXTURE_TREE.workspace.id;
  const state: any = {
    currentUser: { _id: "fixture-user-me", name: "Ashot Petrosian" },
    clientState: { ui: { active_team_id: TEAM } },
    teams: [{ _id: TEAM, name: "Union" }],
    get orgTree() { return env.tree; },
    orgProposals: {} as Record<string, any>,
    orgProposalChanges: {} as Record<string, any>,
    // What the slice's action does to the draft (store/orgSlice.ts).
    decideOrgProposalChange: (id: string, verdict: "accept" | "skip", edits: unknown, seen: { seqs: number[] }) => {
      calls.push(`decide:${id}:${verdict}:${edits === undefined ? "" : "edits"}:${seen.seqs.join(",")}`);
      state.orgProposalChanges = { ...state.orgProposalChanges, [id]: { ...state.orgProposalChanges[id], status: verdict === "accept" ? "accepted" : "skipped" } };
    },
  };
  const propose = () => {
    state.orgProposals = Object.fromEntries(fx.COMPANY_FIXTURE_PROPOSALS.map(({ changes: _changes, ...row }) => [row._id, row]));
    state.orgProposalChanges = Object.fromEntries(fx.COMPANY_FIXTURE_CHANGES.map((c) => [c._id, { ...c }]));
  };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });

  mock.module("../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  const realOrgTree = { ...(await import("../../hooks/useSyncOrgTree")) };
  mock.module("../../hooks/useSyncOrgTree", () => ({ ...realOrgTree, useSyncOrgTree: () => ({ tree: env.tree, ready: true, missing: false, refused: false, retry: () => {} }), useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry: () => {} }) }));
  const realProjects = { ...(await import("../../hooks/useSyncProjects")) };
  mock.module("../../hooks/useSyncProjects", () => ({ ...realProjects, useSyncProjects: () => { calls.push("feed:projects"); } }));
  const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
  mock.module("../../hooks/useSyncOrgProposals", () => ({
    ...realProposals,
    useSyncOrgProposals: () => { calls.push("feed:proposals"); return { ready: true, missing: false }; },
    useSyncOrgProposal: (ref: string | null) => { calls.push(`feed:proposal:${ref}`); return { ready: !!ref, missing: false }; },
  }));
  mock.module("../../hooks/useSyncCollection", () => ({ useSyncCollection: () => ({ ready: true, refused: false, retry: () => {} }) }));
  mock.module("../../hooks/useWorkspaceCollection", () => ({ useWorkspaceCollection: (key: string) => collections[key] ?? [] }));
  mock.module("../../hooks/useIsPhone", () => ({ useIsPhone: () => env.phone, useMinWidth: () => env.wide, PHONE_MAX_WIDTH: 768 }));
  const realNow = { ...(await import("../../hooks/useCoarseNow")) };
  mock.module("../../hooks/useCoarseNow", () => ({ ...realNow, useCoarseNow: () => fx.COMPANY_FIXTURE_NOW, useNowWhen: () => fx.COMPANY_FIXTURE_NOW }));
  mock.module("../../hooks/useOrgRoles", () => ({ useOrgRoles: () => ({ roles: env.tree?.roles ?? [], workspace: env.tree?.workspace ?? null, roleBotUserIds: new Set<string>() }) }));
  const realRoster = await import("../../hooks/useTeamRoster");
  mock.module("../../hooks/useTeamRoster", () => ({ ...realRoster, useTeamRosterIdentity: () => fx.COMPANY_FIXTURE_ROSTER }));
  mock.module("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams(""), usePathname: () => "/company" }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const realPill = { ...(await import("../EntityIdPill")) };
  mock.module("../EntityIdPill", () => ({ ...realPill, EntityIdPill: ({ id, type }: any) => React.createElement("span", { "data-pill": `${type}:${id}` }, id) }));
  const realLeadChip = { ...(await import("../charter/ProjectLeadChip")) };
  mock.module("../charter/ProjectLeadChip", () => ({ ...realLeadChip, ProjectLeadChip: ({ projectId, size }: any) => React.createElement("span", { "data-project-lead-chip": projectId, "data-size": size }) }));
  const realRoleFace = { ...(await import("../org/RoleFace")) };
  mock.module("../org/RoleFace", () => ({ ...realRoleFace, RoleFace: ({ role }: any) => React.createElement("span", { "data-role-face": role.handle }) }));
  const realAssignee = { ...(await import("../identity/AssigneeFace")) };
  mock.module("../identity/AssigneeFace", () => ({ ...realAssignee, AssigneeFace: ({ info }: any) => React.createElement("span", { "data-face": info.kind === "role" ? `role:${info.handle}` : `person:${info.name}` }) }));

  const { createRoot } = await import("react-dom/client");
  const { CompanyDocument } = await import("./CompanyDocument");
  let root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const click = async (el: Element | null) => { assert.ok(el, "missing element"); await act(async () => { (el as HTMLElement).click(); }); };
  const mount = async () => {
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(React.createElement(CompanyDocument)));
  };
  const sections = () => qa("[data-company-section]").map((s) => s.getAttribute("data-company-section"));
  const goalIds = (sel: string) => qa(sel).map((g) => g.getAttribute("data-company-goal"));

  // ── the document as the store holds it: four sections, in reading order ──
  await mount();
  assert.equal(q("[data-company-document]")!.getAttribute("data-company-layout"), "wide");
  assert.deepEqual(sections(), ["company", "goals", "projects", "people"]);
  assert.ok(calls.includes("feed:projects") && calls.includes("feed:proposals"), "mounts the projects and proposals feeders");
  assert.equal(q("[data-company-name]")!.textContent, "Union");
  assert.equal(qa("[data-company-purpose] p").length, 3, "why each top level goal matters");
  assert.equal(q("[data-company-tally]")!.textContent, "4 goals, 9 projects, 2 people, 2 roles");
  assert.equal(q("[data-company-proposals]"), null, "no proposal, no word about one");
  assert.equal(qa("[data-company-change]").length, 0);

  // A top level goal: its heading links to its page; who drives it stands beside it.
  assert.deepEqual(goalIds("[data-company-section='goals'] > [data-company-goal]"), ["in-2", "in-4", "in-1"]);
  const network = q("[data-company-goal='in-2']")!;
  assert.equal(network.getAttribute("data-company-depth"), "1");
  assert.equal(network.querySelector("h3[data-company-goal-title] a")!.getAttribute("href"), "/initiatives/in-2");
  assert.equal(network.querySelector("h3")!.textContent, "Win the private network");
  assert.ok(network.querySelector(":scope > header [data-company-byline] [data-face='person:Ashot Petrosian']"), "the owner's face by the heading");
  const chips = network.querySelector(":scope > [data-company-chips]")!;
  assert.equal(chips.querySelector("[data-initiative-owner]"), null, "on a wide page the owner is the byline, not a chip");
  assert.equal(chips.querySelector("[data-company-status]")!.getAttribute("data-company-status"), "active");
  assert.equal(chips.querySelector("[data-initiative-health]")!.getAttribute("data-initiative-health"), "on_track");
  const metric = chips.querySelector("[data-metric='brokers']")!;
  assert.equal(metric.getAttribute("data-metric-size"), "line");
  assert.match(metric.textContent!, /Brokers onboarded.*17 of 40/);
  assert.equal(metric.querySelector("[data-metric-trend]")!.getAttribute("data-metric-trend"), "up", "the trend, read from the history");
  assert.equal(metric.querySelector("[data-metric-trend]")!.getAttribute("data-metric-toward"), "yes");
  assert.equal(chips.querySelector("[data-initiative-milestone]")!.getAttribute("data-initiative-milestone"), "next");
  assert.match(chips.querySelector("[data-initiative-milestone]")!.textContent!, /Twenty five brokers onboarded/);
  assert.equal(chips.querySelector("[data-initiative-target]")!.getAttribute("data-initiative-target"), "ahead");
  assert.match(network.querySelector(":scope > [data-company-why]")!.textContent!, /^Brokers place the deals/);
  assert.match(network.querySelector(":scope > [data-company-done-when]")!.textContent!, /^Done when Forty brokers/);
  // A goal with no why reads its description; one with neither says nothing.
  assert.equal(q("[data-company-goal='in-1'] > [data-company-done-when]"), null);

  // What feeds it is a sub heading under it, with the same line of chips.
  assert.deepEqual(goalIds("[data-company-goal='in-2'] > [data-company-subgoals] > [data-company-goal]"), ["in-5"]);
  const ten = q("[data-company-goal='in-5']")!;
  assert.equal(ten.getAttribute("data-company-depth"), "2");
  assert.ok(ten.querySelector("h4[data-company-goal-title]"));
  assert.ok(ten.querySelector("[data-company-byline] [data-face='person:Samvit Ramadurgam']"));
  assert.ok(ten.querySelector("[data-company-chips] [data-metric='top_ten']"));
  // A role owner wears the role's face.
  assert.ok(q("[data-company-goal='in-4'] [data-company-byline] [data-face='role:agent-quality']"));
  assert.equal(q("[data-company-goal='in-4'] [data-metric-trend]")!.getAttribute("data-metric-toward"), "yes", "down toward a stay under target");

  // Projects under a goal: a row each, with lead, status, last change and counts.
  const row = network.querySelector(":scope > [data-company-projects] > [data-company-project='pr-6']")!;
  assert.equal(row.querySelector("a")!.getAttribute("href"), "/projects/union-proj-network");
  assert.equal(row.querySelector("a")!.textContent, "Broker / Private Network");
  assert.equal(row.querySelector("[data-project-lead-chip]")!.getAttribute("data-project-lead-chip"), "union-proj-network");
  assert.equal(row.querySelector("[data-project-lead-chip]")!.getAttribute("data-size"), "xs");
  assert.equal(row.querySelector("[data-company-project-status]")!.textContent, "active");
  assert.ok(row.querySelector("[data-company-project-activity]")!.textContent);
  assert.equal(row.querySelector("[data-company-project-counts]")!.textContent, "9 open, 12 done");
  assert.equal(row.querySelector("[data-company-project-meta]"), null, "one line on a wide page");
  // A project two goals carry is listed once, and named on the other.
  assert.equal(network.querySelectorAll(":scope > [data-company-projects] > [data-company-project]").length, 1);
  assert.match(network.querySelector(":scope > [data-company-refs]")!.textContent!, /^Also carries Broker Outreach, listed under the goal nearest the work\.$/);
  assert.ok(ten.querySelector("[data-company-project='pr-7']"));

  // Projects no goal carries, by name.
  assert.deepEqual(qa("[data-company-section='projects'] [data-company-project]").map((p) => p.getAttribute("data-company-project")), ["pr-2", "pr-3", "pr-4", "pr-1", "pr-9", "pr-8"]);
  assert.equal(q("[data-company-section='projects'] [data-company-project='pr-4'] [data-company-project-counts]"), null, "no tasks counted, no counts");

  // Roles, then people: every name a link, what each leads and owns.
  const people = q("[data-company-section='people']")!;
  assert.deepEqual(qa("[data-company-role]").map((r) => r.getAttribute("data-company-role")), ["or-35", "or-36"]);
  const quality = q("[data-company-role='or-36']")!;
  assert.ok(quality.querySelector("[data-role-face='agent-quality']"));
  assert.equal(quality.querySelector("h4 a")!.getAttribute("href"), "/org/or-36");
  assert.match(quality.textContent!, /@agent-quality/);
  assert.match(quality.textContent!, /reports to Ashot Petrosian/);
  assert.equal(quality.querySelector("[data-company-charter]")!.textContent, "Every conversation an agent runs is one we would be proud of.");
  assert.equal(quality.querySelector("[data-company-leads='pr-12']")!.getAttribute("href"), "/projects/union-proj-quality");
  assert.ok(quality.querySelector("[data-pill='initiative:in-4']"), "the goal it owns, as a live pill");
  assert.ok(q("[data-company-role='or-35'] [data-pill='initiative:in-1']"));
  assert.equal(q("[data-company-role='or-35'] [data-company-leads]"), null, "covering every project by the rule is not a lead to name");
  const ashot = people.querySelector("[data-company-person='fixture-user-me']")!;
  assert.ok(ashot.querySelector("[data-face='person']"));
  assert.equal(ashot.querySelector("h4 a")!.getAttribute("href"), "/team/ashot");
  assert.deepEqual([...ashot.querySelectorAll("[data-company-reports]")].map((a) => a.getAttribute("href")), ["/org/or-35", "/org/or-36"]);
  assert.ok(ashot.querySelector("[data-pill='initiative:in-2']"));
  assert.ok(people.querySelector("[data-company-person='fixture-user-samvit'] [data-pill='initiative:in-5']"));

  // The contents list on a wide screen: the top level goals and the three sections.
  const toc = q("[data-company-toc]")!;
  assert.deepEqual([...toc.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#company", "#goals", "#goal-union-in-2", "#goal-union-in-4", "#goal-union-in-1", "#projects", "#people"]);
  assert.ok(document.getElementById("goal-union-in-2"), "each entry names a part of the page");
  env.wide = false;
  await mount();
  assert.equal(q("[data-company-toc]"), null, "no room for it, no contents list");
  assert.equal(q("[data-company-document]")!.getAttribute("data-company-layout"), "page");
  env.wide = true;

  // ── with the open proposals: every change in its place, in ghost chrome ──
  propose();
  await mount();
  assert.ok(calls.includes("feed:proposal:op-54") && calls.includes("feed:proposal:op-55"), "one feeder for each open proposal");
  assert.deepEqual(sections(), ["company", "goals", "projects", "people"]);
  assert.equal(q("[data-company-proposals]")!.getAttribute("data-company-proposals"), "13");
  assert.deepEqual([...q("[data-company-proposals]")!.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["/org?proposal=op-54", "/org?proposal=op-55"]);
  assert.equal(q("[data-company-tally]")!.textContent, "4 goals, 9 projects, 2 people, 2 roles", "nothing proposed is counted as held");
  // The purpose it sets stands at the top, dashed; the goals it gathers sit under it.
  const top = qa("[data-company-section='goals'] > [data-company-goal]");
  assert.equal(top.length, 1);
  assert.equal(top[0].getAttribute("data-company-goal-kind"), "proposed");
  const purpose = top[0].querySelector(":scope > [data-company-goal-ghost='union-purpose']") as HTMLElement;
  assert.equal(purpose.getAttribute("data-company-change-status"), "proposed");
  assert.match(purpose.style.border, /dashed/);
  assert.equal(purpose.querySelector("h3")!.textContent, "Broker high-value introductions that become real transactions");
  assert.equal(purpose.querySelector("[data-ghost-tag]")!.getAttribute("data-ghost-tag"), "proposed goal");
  assert.match(purpose.querySelector("[data-company-ghost-owner]")!.textContent!, /Ashot Petrosian/);
  assert.equal(q("[data-company-toc-goal]")!.textContent, "Broker high-value introductions that become real transactions");
  const under = top[0].querySelectorAll(":scope > [data-company-subgoals] > [data-company-goal]");
  assert.equal(under.length, 9);
  // A proposed goal under its parent, with what it would be measured by and who would own it.
  const revenue = under[0].querySelector(":scope > [data-company-goal-ghost='union-revenue']")!;
  assert.equal(under[0].getAttribute("data-company-depth"), "2");
  assert.equal(revenue.querySelector("h4")!.textContent, "Make revenue");
  assert.match(revenue.querySelector("[data-company-ghost-owner]")!.textContent!, /Samvit Ramadurgam/);
  assert.match(revenue.querySelector("[data-company-ghost-detail]")!.textContent!, /Fees collected → The first dollar/);
  assert.equal(under[0].querySelector("[data-company-project='pr-9']")!.getAttribute("data-company-project-ghost"), "proposed");
  // A live goal keeps its heading and wears each change as a dashed line under it.
  const moved = q("[data-company-goal='in-2']")!;
  assert.equal(moved.getAttribute("data-company-depth"), "2");
  assert.equal(moved.getAttribute("data-company-goal-kind"), "live");
  const place = moved.querySelector(":scope > div > [data-company-change='union-network']") as HTMLElement;
  assert.equal(place.getAttribute("data-company-change-kind"), "initiative_shape");
  assert.match(place.style.border, /dashed/);
  assert.equal(place.querySelector("[data-ghost-tag]")!.getAttribute("data-ghost-tag"), "moves here");
  assert.deepEqual(qa("[data-company-goal='in-4'] > div > [data-company-change]").map((c) => c.getAttribute("data-company-change")), ["union-quality-shape", "union-quality-projects"]);
  assert.match(q("[data-company-change='union-quality-projects']")!.textContent!, /projects added.*Agent Quality/i);
  // A project a proposal would place says where, in the list of projects no goal carries.
  assert.match(q("[data-company-section='projects'] [data-company-project='pr-8'] [data-company-proposed-under]")!.textContent!, /^proposed under Fundraise and then public launch$/);

  // Accept runs the store action with what that proposal showed, and the goal draws solid.
  calls.length = 0;
  await click(revenue.querySelector("[data-company-accept='union-revenue']"));
  assert.deepEqual(calls.filter((c) => c.startsWith("decide:")), ["decide:union-revenue:accept::1,2,3,4,5,6,7,8,9,10,11"]);
  await mount();
  const accepted = q("[data-company-goal-ghost='union-revenue']") as HTMLElement;
  assert.equal(accepted.getAttribute("data-company-change-status"), "accepted");
  assert.doesNotMatch(accepted.style.border, /dashed/);
  assert.equal(accepted.querySelector("[data-company-accept]"), null, "decided: no buttons");
  assert.equal(accepted.querySelector("[data-status]")!.getAttribute("data-status"), "accepted");
  assert.equal(accepted.querySelector("[data-ghost-tag]")!.getAttribute("data-ghost-tag"), "accepted goal");
  // Skip: the change draws nothing.
  await click(q("[data-company-skip='union-funnel']"));
  assert.ok(calls.includes("decide:union-funnel:skip::1,3,4,5,6,7,8,9,10,11"), calls.join("\n"));
  await mount();
  assert.equal(q("[data-company-goal-ghost='union-funnel']"), null);
  assert.equal(qa("[data-company-section='goals'] > [data-company-goal] > [data-company-subgoals] > [data-company-goal]").length, 8);
  // A change line under a live goal decides the same way.
  await click(q("[data-company-accept='union-quality-shape']"));
  assert.ok(calls.includes("decide:union-quality-shape:accept::1,4,5,6,7,8,9,10,11"), calls.join("\n"));

  // Role changes draw in the people section: a role to hire on its own, a change on the role it changes.
  const hire = q("[data-company-section='people'] > [data-company-change='union-staff-outreach']")!;
  assert.equal(hire.getAttribute("data-company-change-kind"), "role");
  assert.equal(hire.querySelector("[data-tree-node='role']")!.getAttribute("data-tree-node-id"), "union-staff-outreach");
  assert.match(hire.textContent!, /Broker Outreach Lead.*@broker-outreach/);
  assert.ok(q("[data-company-role='or-36'] [data-company-change='union-staff-quality-scope']"), "a scope change sits on the role it changes");
  await click(hire.querySelector("[data-company-accept]"));
  assert.ok(calls.includes("decide:union-staff-outreach:accept::1,2"), "seen is that proposal's own rows");

  // ── the phone: one column, the chips under the heading, a project's facts under its name ──
  env.phone = true; env.wide = false;
  state.orgProposals = {}; state.orgProposalChanges = {};
  await mount();
  assert.equal(q("[data-company-document]")!.getAttribute("data-company-layout"), "phone");
  assert.equal(q("[data-company-toc]"), null);
  assert.deepEqual(sections(), ["company", "goals", "projects", "people"]);
  const phoneGoal = q("[data-company-goal='in-2']")!;
  assert.equal(phoneGoal.querySelector("[data-company-byline]"), null);
  assert.ok(phoneGoal.querySelector(":scope > [data-company-chips] [data-face='person:Ashot Petrosian']"), "the owner joins the line of chips under the heading");
  assert.match(phoneGoal.querySelector(":scope > [data-company-chips]")!.className, /flex-wrap/);
  const phoneRow = phoneGoal.querySelector("[data-company-project='pr-6']")!;
  assert.doesNotMatch(phoneRow.className, /grid/);
  assert.ok(phoneRow.querySelector("[data-company-project-meta] [data-project-lead-chip]"));
  assert.ok(phoneRow.querySelector("[data-company-project-meta] [data-company-project-counts]"));
  env.phone = false; env.wide = true;

  // ── before the org tree arrives: the plain outline under the team's name ──
  env.tree = null;
  propose();
  await mount();
  assert.equal(q("[data-company-name]")!.textContent, "Union");
  assert.deepEqual(goalIds("[data-company-section='goals'] > [data-company-goal]"), ["in-2", "in-4", "in-1"]);
  assert.equal(qa("[data-company-change]").length, 0, "no tree, no ghosts");
  assert.equal(qa("[data-company-role]").length, 0);
  assert.equal(qa("[data-company-person]").length, 2, "the roster's people");

  // ── an empty workspace reads as one, quietly ──
  collections.initiatives = []; collections.projects = [];
  await mount();
  assert.equal(q("[data-company-purpose]")!.getAttribute("data-company-purpose"), "none");
  assert.match(q("[data-company-purpose]")!.textContent!, /^No purpose written yet$/);
  assert.match(q("[data-company-section='goals']")!.textContent!, /No goals yet/);
  assert.equal(q("[data-company-section='goals'] a")!.getAttribute("href"), "/initiatives");
  assert.match(q("[data-company-section='projects']")!.textContent!, /No projects yet/);

  await act(async () => root.unmount());
}

test("company document mount: the sections, a goal's chips, proposals in place, the phone", async () => {
  await verifyCompany();
}, 600_000);
