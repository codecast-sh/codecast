// The company document (docs/architecture/initiatives-projects-role-page.md
// I5), mounted in jsdom against the Union shaped fixture. Proves: the four
// sections in reading order; a goal's heading with its owner, status, health,
// number with its trend, next milestone and target, then why and done when; a
// goal that feeds another under it; projects as rows with lead, status, last
// change and counts; the projects no goal carries; roles and people with what
// they lead and own, every name a link; the contents list, beside the article
// in a wide document and a line that opens in a narrower one; an open
// proposal's changes drawn in place as the ledger's cards (one per subject,
// under the heading that names it), each answered into the proposal's
// thread batch and nothing decided until one send applies the approvals with
// what that proposal showed; and the layout a narrow pane gets, chosen by
// the document's own width.
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
  // `width` is the document's own (its scroller's clientWidth); the window stays desktop sized throughout.
  const env = { width: 1280, counted: true, tree: fx.COMPANY_FIXTURE_TREE as OrgTree | null };
  Object.defineProperty((dom.window as any).HTMLElement.prototype, "clientWidth", { get() { return env.width; }, configurable: true });
  const calls: string[] = [];
  const collections: Record<string, any[]> = { initiatives: fx.COMPANY_FIXTURE_INITIATIVES, projects: fx.COMPANY_FIXTURE_PROJECTS, tasks: fx.COMPANY_FIXTURE_TASKS };
  const TEAM = fx.COMPANY_FIXTURE_TREE.workspace.id;
  const state: any = {
    currentUser: { _id: "fixture-user-me", name: "Ashot Petrosian" },
    clientState: { ui: { active_team_id: TEAM } },
    teams: [{ _id: TEAM, name: "Union" }],
    get orgTree() { return env.tree; },
    orgProposals: {} as Record<string, any>,
    orgProposalChanges: {} as Record<string, any>,
    currentSessionId: null,
    sessions: {},
    // The pending batch the quote UI uses (store/inboxStore.ts), keyed by conversation.
    reviewComments: {} as Record<string, any[]>,
    addReviewComment: (key: string, c: any) => { state.reviewComments = { ...state.reviewComments, [key]: [...(state.reviewComments[key] ?? []), c] }; },
    commitReviewComment: (key: string, id: string, body: string) => { state.reviewComments = { ...state.reviewComments, [key]: (state.reviewComments[key] ?? []).map((c: any) => (c.id === id ? { ...c, body } : c)) }; },
    removeReviewComment: (key: string, id: string) => { state.reviewComments = { ...state.reviewComments, [key]: (state.reviewComments[key] ?? []).filter((c: any) => c.id !== id) }; },
    // What the slice's reply action does to the draft (store/orgSlice.ts): approvals land, rejections are skipped, a note decides nothing.
    replyOnOrgProposal: (proposalId: string, items: { verdict: string; change_ids: string[]; seqs: number[]; text?: string }[], seen: { seqs: number[] }, opts?: { say?: { thread: string } }) => {
      calls.push(`reply:${proposalId}:${items.map((i) => `${i.verdict}@${i.seqs.join(",")}${i.text ? `=${i.text}` : ""}`).join(";")}:${seen.seqs.join(",")}:${opts?.say?.thread ?? ""}`);
      for (const item of items) for (const id of item.change_ids) {
        if (item.verdict === "note") continue;
        state.orgProposalChanges = { ...state.orgProposalChanges, [id]: { ...state.orgProposalChanges[id], status: item.verdict === "approve" ? "accepted" : "skipped" } };
      }
    },
  };
  const propose = () => {
    state.orgProposals = Object.fromEntries(fx.COMPANY_FIXTURE_PROPOSALS.map(({ changes: _changes, ...row }) => [row._id, row]));
    state.orgProposalChanges = Object.fromEntries(fx.COMPANY_FIXTURE_CHANGES.map((c) => [c._id, { ...c }]));
  };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });

  mock.module("../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  const realOrgTree = { ...(await import("../../hooks/useSyncOrgTree")) };
  mock.module("../../hooks/useSyncOrgTree", () => ({ ...realOrgTree, useSyncOrgTree: () => { calls.push("feed:tree"); return { tree: env.tree, ready: true, missing: false, refused: false, retry: () => {} }; }, useSyncOrgTreeFull: () => { calls.push("feed:tree"); return { ready: true, missing: false, refused: false, retry: () => {} }; }, useSyncOrgTreeFeeder: () => { calls.push("feed:roles"); return { ready: true, missing: false, refused: false, retry: () => {} }; } }));
  const realProjects = { ...(await import("../../hooks/useSyncProjects")) };
  mock.module("../../hooks/useSyncProjects", () => ({ ...realProjects, useSyncProjects: () => { calls.push("feed:projects"); } }));
  const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
  mock.module("../../hooks/useSyncOrgProposals", () => ({
    ...realProposals,
    useSyncOrgProposals: () => { calls.push("feed:proposals"); return { ready: true, missing: false }; },
    useSyncOrgProposal: (ref: string | null) => { calls.push(`feed:proposal:${ref}`); return { ready: !!ref, missing: false }; },
  }));
  mock.module("../../hooks/useSyncCollection", () => ({ useSyncCollection: () => ({ ready: true, refused: false, retry: () => {} }) }));
  const realWorkspace = { ...(await import("../../hooks/useWorkspaceCollection")) };
  mock.module("../../hooks/useWorkspaceCollection", () => ({ ...realWorkspace, useWorkspaceCollection: (key: string) => collections[key] ?? [] }));
  const realInitiatives = { ...(await import("../../hooks/useInitiatives")) };
  mock.module("../../hooks/useInitiatives", () => ({ ...realInitiatives, useTasksBackfilled: () => env.counted }));
  const realNow = { ...(await import("../../hooks/useCoarseNow")) };
  mock.module("../../hooks/useCoarseNow", () => ({ ...realNow, useCoarseNow: () => fx.COMPANY_FIXTURE_NOW, useNowWhen: () => fx.COMPANY_FIXTURE_NOW }));
  const realOrgRoles = { ...(await import("../../hooks/useOrgRoles")) };
  mock.module("../../hooks/useOrgRoles", () => ({ ...realOrgRoles, useOrgRoles: () => ({ roles: env.tree?.roles ?? [], workspace: env.tree?.workspace ?? null, roleBotUserIds: new Set<string>() }) }));
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
  // Typing into a controlled field: the native setter, then the input event React listens for.
  const type = async (el: Element | null, text: string) => {
    assert.ok(el, "missing field");
    const set = Object.getOwnPropertyDescriptor((dom.window as any).HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { set.call(el, text); el!.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true })); });
  };
  const THREAD = "fixture-growth-conv";
  const batch = () => (state.reviewComments[THREAD] ?? []) as { body: string; proposal: { id: string; card: string; verdict: string; seqs: number[]; ordinal?: number } }[];
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
  assert.ok(calls.includes("feed:roles") && !calls.includes("feed:tree"), "the roles feeder, never the full tree: nothing here draws a session");
  assert.equal(q("[data-company-name]")!.textContent, "Union");
  assert.equal(qa("[data-company-purpose] p").length, 3, "why each top level goal matters");
  assert.equal(q("[data-company-tally]")!.textContent, "4 goals, 9 projects, 2 people, 2 roles");
  assert.equal(q("[data-company-proposals]"), null, "no proposal, no word about one");
  assert.equal(qa("[data-subject]").length, 0);

  // A top level goal: its heading links to its page; who drives it stands beside it.
  assert.deepEqual(goalIds("[data-company-section='goals'] > [data-company-goal]"), ["in-2", "in-4", "in-1"]);
  const network = q("[data-company-goal='in-2']")!;
  assert.equal(network.getAttribute("data-company-depth"), "1");
  assert.equal(network.querySelector("h3[data-company-goal-title] a")!.getAttribute("href"), "/initiatives/in-2");
  assert.equal(network.querySelector("h3")!.textContent, "Win the private network");
  assert.ok(network.querySelector(":scope > header [data-company-byline] [data-face='person:Ashot Petrosian']"), "the owner's face by the heading");
  assert.equal(network.querySelector("[data-company-byline] a[data-company-owner='user']")!.getAttribute("href"), "/team/ashot", "the owner is a link to the person");
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
  assert.match(network.querySelector(":scope > [data-company-words] > [data-company-why]")!.textContent!, /^Brokers place the deals/);
  assert.match(network.querySelector(":scope > [data-company-words] > [data-company-done-when]")!.textContent!, /^Done when Forty brokers/);
  // A goal with no why reads the first sentence of its description; one with neither says nothing.
  assert.equal(q("[data-company-goal='in-1'] > [data-company-words] > [data-company-done-when]"), null);

  // What feeds it is a sub heading under it, with the same line of chips.
  assert.deepEqual(goalIds("[data-company-goal='in-2'] > [data-company-subgoals] > [data-company-goal]"), ["in-5"]);
  const ten = q("[data-company-goal='in-5']")!;
  assert.equal(ten.getAttribute("data-company-depth"), "2");
  assert.ok(ten.querySelector("h4[data-company-goal-title]"));
  assert.ok(ten.querySelector("[data-company-byline] [data-face='person:Samvit Ramadurgam']"));
  assert.ok(ten.querySelector("[data-company-chips] [data-metric='top_ten']"));
  // A role owner wears the role's face.
  assert.ok(q("[data-company-goal='in-4'] [data-company-byline] [data-face='role:agent-quality']"));
  assert.equal(q("[data-company-goal='in-4'] [data-company-byline] a[data-company-owner='role']")!.getAttribute("href"), "/org/or-36", "a role owner links to the role");
  assert.equal(q("[data-company-goal='in-4'] [data-metric-trend]")!.getAttribute("data-metric-toward"), "yes", "down toward a stay under target");

  // Projects under a goal: a row each, with lead, status, last change and counts.
  const row = network.querySelector(":scope > [data-company-projects] > [data-company-project='pr-6']")!;
  assert.equal(row.querySelector("a")!.getAttribute("href"), "/projects/union-proj-network");
  assert.equal(row.querySelector("a")!.textContent, "Broker / Private Network");
  // Only the whole workspace role covers it: that names no lead for this project.
  assert.equal(row.querySelector("[data-company-project-lead]")!.getAttribute("data-company-project-lead"), "none");
  assert.equal(q("[data-company-project='pr-12'] [data-company-project-lead]")!.getAttribute("data-company-project-lead"), "agent-quality", "a role the project names is its lead");
  assert.equal(q("[data-company-project='pr-12'] [data-company-project-lead]")!.getAttribute("href"), "/org/" + fx.COMPANY_FIXTURE_TREE.roles.find((r: any) => r.handle === "agent-quality")!.short_id);
  assert.equal(row.querySelector("[data-company-project-status]")!.textContent, "active");
  assert.ok(row.querySelector("[data-company-project-activity]")!.textContent);
  assert.equal(row.querySelector("[data-company-project-counts]")!.textContent, "9 open, 12 done", "the board's count: dropped and agent rows are not in it");
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
  assert.equal(quality.querySelector("a[data-company-reports-to]")!.getAttribute("href"), "/team/ashot", "who it reports to is a link");
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

  // The contents list beside a wide document: the sections and every goal, a goal that feeds another under it.
  const toc = q("[data-company-toc]")!;
  assert.equal(toc.getAttribute("data-company-toc"), "beside");
  assert.deepEqual([...toc.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#company", "#goals", "#goal-union-in-2", "#goal-union-in-5", "#goal-union-in-4", "#goal-union-in-1", "#projects", "#people"]);
  assert.deepEqual(qa("[data-company-toc-goal]").map((a) => a.getAttribute("data-company-toc-depth")), ["1", "2", "1", "1"]);
  assert.ok(document.getElementById("goal-union-in-5"), "each entry names a part of the page");
  // A pane too narrow for it (the window is as wide as before): the contents fold to a line under the header, still naming every part.
  env.width = 900;
  await mount();
  assert.equal(q("[data-company-document]")!.getAttribute("data-company-layout"), "page");
  const folded = q<HTMLDetailsElement>("details[data-company-toc='compact']")!;
  assert.equal(folded.querySelector("summary")!.textContent, "Contents");
  assert.deepEqual([...folded.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#goals", "#goal-union-in-2", "#goal-union-in-5", "#goal-union-in-4", "#goal-union-in-1", "#projects", "#people"]);
  assert.match(q("[data-company-project='pr-6']")!.className, /grid/, "the page still has room for a project's columns");
  env.width = 1280;

  // A cold task cache: a count read now would be partial, so the row says it is counting.
  env.counted = false;
  await mount();
  assert.equal(q("[data-company-project='pr-6'] [data-company-project-counts]")!.textContent, "counting");
  env.counted = true;

  // ── with the open proposals: every change in its place, as the ledger's card ──
  propose();
  await mount();
  assert.ok(calls.includes("feed:proposal:op-54") && calls.includes("feed:proposal:op-55"), "one feeder for each open proposal");
  assert.ok(!calls.includes("feed:tree"), "cards read their before from the records in hand, never the full tree");
  // Every loose project is placed by the proposal, so the section that lists loose ones is gone.
  assert.deepEqual(sections(), ["company", "goals", "people"]);
  assert.equal(q("[data-company-proposals]")!.getAttribute("data-company-proposals"), "13");
  assert.deepEqual([...q("[data-company-proposals]")!.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["/org?proposal=op-54", "/org?proposal=op-55"]);
  assert.equal(q("[data-company-tally]")!.textContent, "4 goals, 9 projects, 2 people, 2 roles", "nothing proposed is counted as held");
  // One card per subject, each drawn once: ten goals of op-54, two roles of op-55.
  const subjects = qa("[data-subject]").map((c) => c.getAttribute("data-subject"));
  assert.equal(subjects.length, 12, subjects.join(" "));
  assert.equal(new Set(subjects).size, 12, "a card holding two changes is drawn once");
  assert.ok(qa("[data-subject]").every((c) => c.getAttribute("data-layout") === "auto"), "a card sizes itself by the column it sits in");
  assert.equal(q("[data-ghost-tag]:not([data-ghost-tag='proposed'])"), null, "no tag on a change: the card's words say it");
  // The purpose it sets stands at the top as the heading, in the proposal's colour; the card under it says what the change writes.
  const top = qa("[data-company-section='goals'] > [data-company-goal]");
  assert.equal(top.length, 1);
  assert.equal(top[0].getAttribute("data-company-goal-kind"), "proposed");
  const purposeHead = top[0].querySelector(":scope > h3[data-company-goal-ghost='union-purpose']")!;
  assert.equal(purposeHead.textContent, "Broker high-value introductions that become real transactions");
  assert.equal(purposeHead.querySelector("a")!.getAttribute("href"), "/org?proposal=op-54", "a proposed goal's name opens the proposal that sets it");
  assert.equal(q("[data-company-purpose]")!.getAttribute("data-company-purpose"), "proposed", "the proposed purpose reads as proposed, not as missing");
  assert.equal(q("[data-company-purpose-line]")!.textContent, "Union is a curated relationship network that brokers high-value introductions. proposed");
  const purpose = top[0].querySelector(":scope > [data-company-goal-changes='1'] [data-subject='goal:union-purpose']") as HTMLElement;
  assert.equal(purpose.getAttribute("data-subject-status"), "proposed");
  assert.equal(purpose.querySelector("[data-subject-sentence]")!.textContent, "Set this goal as the purpose.", "under its heading the card says this goal");
  assert.equal(purpose.querySelector("[data-field='owner']")!.getAttribute("data-field-after"), "Ashot Petrosian");
  assert.ok(purpose.querySelector("[data-field='owner'] [data-face='person']"), "the owner's face by the name");
  assert.match(purpose.querySelector("[data-field='says']")!.textContent!, /^Union is a curated relationship network/);
  assert.ok(purpose.querySelector("[data-subject-approve]") && purpose.querySelector("[data-subject-reject]") && purpose.querySelector("[data-subject-reply]"), "Approve, Reject and Reply");
  assert.equal(purpose.querySelector("[data-subject-skip], [data-subject-accept]"), null);
  assert.equal(document.getElementById("change-union-purpose")?.contains(purpose), true, "the card is the change's place on the page");
  assert.equal(q("[data-company-toc-goal]")!.textContent, "Broker high-value introductions that become real transactions");
  const under = top[0].querySelectorAll(":scope > [data-company-subgoals] > [data-company-goal]");
  assert.equal(under.length, 9);
  // A proposed goal under its parent: the heading, then its owner and what it would be measured by, as the card's rows.
  assert.equal(under[0].getAttribute("data-company-depth"), "2");
  assert.equal(under[0].querySelector(":scope > h4[data-company-goal-ghost='union-revenue']")!.textContent, "Make revenue");
  const revenue = under[0].querySelector(":scope > [data-company-goal-changes] [data-subject='goal:union-revenue']")!;
  assert.equal(revenue.querySelector("[data-subject-sentence]")!.textContent, "Add this goal under the purpose.");
  assert.equal(revenue.querySelector("[data-field='owner']")!.getAttribute("data-field-after"), "Samvit Ramadurgam");
  assert.equal(revenue.querySelector("[data-field='metrics']")!.getAttribute("data-field-after"), "Fees collected, target The first dollar", "a target reads as written");
  const carried = top[0].querySelector(":scope > details[data-company-refs]")!;
  assert.match(carried.querySelector("summary")!.textContent!, /^Also carries 9 projects, listed under the goals nearest the work\.$/, "a purpose over every project counts them");
  assert.equal(carried.querySelectorAll("a[href^='/projects/']").length, 9, "and opens to each by name");
  // A project only a proposed goal would carry says so, in the one quiet word.
  const wouldCarry = under[0].querySelector("[data-company-project='pr-9']")!;
  assert.equal(wouldCarry.getAttribute("data-company-project-ghost"), "proposed");
  assert.equal(wouldCarry.querySelector("[data-ghost-tag]")!.getAttribute("data-ghost-tag"), "proposed");
  assert.equal(q("[data-company-goal='in-2'] [data-company-project='pr-6'] [data-ghost-tag]"), null, "a project a live goal carries is filed");
  // A live goal keeps its heading and wears its card under it, with what was there before read from the record.
  const moved = q("[data-company-goal='in-2']")!;
  assert.equal(moved.getAttribute("data-company-depth"), "2");
  assert.equal(moved.getAttribute("data-company-goal-kind"), "live");
  assert.ok(moved.querySelector(":scope > header h4[data-company-goal-title] a[href='/initiatives/in-2']"), "the live heading stays");
  const place = moved.querySelector(":scope > [data-company-goal-changes='1'] [data-subject='goal:union-in-2']") as HTMLElement;
  assert.equal(place.getAttribute("data-change-ids"), "union-network");
  assert.equal(place.querySelector("[data-subject-sentence]")!.textContent, "Move this goal under the purpose.");
  const sits = place.querySelector("[data-field='parent']")!;
  assert.equal(sits.getAttribute("data-field-op"), "change");
  assert.equal(sits.getAttribute("data-field-before"), "at the top level");
  assert.equal(sits.getAttribute("data-field-after"), "under the purpose", "a goal the proposal sets is the purpose");
  assert.equal(place.querySelector("[data-ghost-tag]"), null);
  assert.ok(document.getElementById("goal-union-purpose"));
  // Two changes to one goal are one card, in apply order, with a row for each field they move.
  const proud = q("[data-company-goal='in-4'] > [data-company-goal-changes='2'] [data-subject='goal:union-in-4']")!;
  assert.equal(proud.getAttribute("data-change-ids"), "union-quality-projects union-quality-shape");
  assert.equal(proud.querySelector("[data-subject-sentence]")!.textContent, "Move this goal under the purpose, give it two measures and have Agent Quality carry it.");
  assert.deepEqual([...proud.querySelectorAll("[data-field]")].map((f) => f.getAttribute("data-field")), ["parent", "metrics", "projects"]);
  assert.equal(proud.querySelector("[data-field='projects']")!.getAttribute("data-field-after"), "Agent Quality");
  assert.equal(qa("[data-company-goal='in-4'] [data-subject]").length, 1, "and is drawn once");
  // A project the proposal places is drawn under its goal, and is not listed again as carried by nothing.
  assert.equal(qa("[data-company-section='projects'] [data-company-project]").length, 0);

  // Approve puts an answer in the proposal's thread batch and decides nothing: the card still waits, marked "on your next message".
  calls.length = 0;
  await click(revenue.querySelector("[data-subject-approve]"));
  assert.equal(calls.filter((c) => c.startsWith("reply:")).length, 0, "nothing fires on a press");
  assert.deepEqual(batch().map((c) => [c.proposal.card, c.proposal.verdict, c.proposal.seqs, c.proposal.ordinal]), [["goal:union-revenue", "approve", [2], 2]], "the batch is the author's thread, the item names the card by its number down the proposal");
  await mount();
  const pending = q("[data-subject='goal:union-revenue']")!;
  assert.equal(pending.getAttribute("data-subject-answer"), "approve");
  assert.equal(pending.getAttribute("data-subject-status"), "proposed", "a pending card never looks decided");
  assert.equal(pending.querySelector("[data-subject-approve]")!.getAttribute("aria-pressed"), "true");
  assert.equal(pending.querySelector("[data-subject-pending]")!.textContent, "on your next message");
  assert.equal(pending.querySelector("[data-subject-state]"), null);
  // Reject opens the reply field; the words go into the batch as they are typed.
  const funnel = q("[data-subject='goal:union-funnel']")!;
  await click(funnel.querySelector("[data-subject-reject]"));
  assert.equal(funnel.getAttribute("data-subject-answer"), "reject");
  const field = funnel.querySelector("[data-subject-reply-field='reject'] textarea");
  assert.ok(field, "the field opens under the entry");
  await type(field, "Too early; the funnel is not the goal, revenue is.");
  assert.deepEqual(batch().map((c) => [c.proposal.card, c.proposal.verdict, c.body]), [["goal:union-revenue", "approve", ""], ["goal:union-funnel", "reject", "Too early; the funnel is not the goal, revenue is."]]);
  assert.ok(funnel.querySelector("[data-subject-reply-field] kbd"), "key hints as KeyCaps");
  // The foot: once a proposal has answers pending, its reply row stands at the foot of the page with the one filled Send; the other proposal has none.
  await mount();
  const feet = qa("[data-company-replies] [data-ledger-close]");
  assert.equal(feet.length, 1, "only the proposal with answers pending");
  assert.equal(feet[0].querySelector("[data-send-answers]")!.getAttribute("data-send-answers"), "2");
  assert.ok(feet[0].querySelector("[data-proposal-reply]"), "Reply on the whole proposal");
  assert.equal(feet[0].querySelector("[data-approve-rest]")!.getAttribute("data-approve-rest"), "8");
  // Send applies the answers through the reply action with what that proposal showed, told to the author's thread; the batch empties.
  await click(feet[0].querySelector("[data-send-answers]"));
  assert.deepEqual(calls.filter((c) => c.startsWith("reply:")), [`reply:fixture-union-goals-proposal:approve@2;reject@3=Too early; the funnel is not the goal, revenue is.:1,2,3,4,5,6,7,8,9,10,11:${THREAD}`]);
  assert.equal(batch().length, 0);
  await mount();
  assert.equal(qa("[data-company-replies] [data-ledger-close]").length, 0);
  const accepted = q("[data-subject='goal:union-revenue']")!;
  assert.equal(accepted.getAttribute("data-subject-status"), "accepted");
  assert.equal(accepted.querySelector("[data-subject-approve]"), null, "decided: no controls");
  assert.equal(accepted.querySelector("[data-subject-state]")!.textContent, "Approved");
  assert.equal(q("[data-company-goal-ghost='union-revenue'] ~ [data-company-projects] [data-company-project='pr-9'] [data-ghost-tag]"), null, "an accepted goal's project is as good as filed");
  // The rejected goal is not coming: the document draws nothing for it.
  assert.equal(q("[data-subject='goal:union-funnel']"), null);
  assert.equal(q("[data-company-goal-ghost='union-funnel']"), null);
  assert.equal(qa("[data-company-section='goals'] > [data-company-goal] > [data-company-subgoals] > [data-company-goal]").length, 8);

  // Role changes draw in the people section as cards: a role to hire stands on its own and is named; a change on a live role sits under the role and says "this role".
  const hire = q("[data-company-section='people'] > [data-company-staffing='1'] [data-subject='role:broker-outreach']")!;
  assert.equal(hire.querySelector("[data-subject-sentence]")!.textContent, "Add the role Broker Outreach Lead, reporting to you.");
  assert.equal(hire.querySelector("[data-subject-sentence] b")!.textContent, "Broker Outreach Lead", "the role's name is the one bold run");
  assert.equal(document.getElementById("change-union-staff-outreach")?.contains(hire), true, "where a name the proposal creates links to");
  assert.equal(hire.querySelector("[data-field='handle']")!.getAttribute("data-field-after"), "@broker-outreach");
  assert.equal(hire.querySelector("[data-field='area']")!.getAttribute("data-field-after"), "Broker Outreach");
  assert.equal(hire.querySelector(".truncate"), null, "nothing on a card is cut short");
  assert.equal(hire.querySelector("[data-tree-node]"), null, "not the proposal card's framed node");
  const area = q("[data-company-role='or-36'] [data-subject='role:agent-quality']")!;
  assert.equal(area.querySelector("[data-subject-sentence]")!.textContent, "Have this role look after Callers & Call Management.");
  assert.equal(area.querySelector("[data-field='area']")!.getAttribute("data-field-before"), "Agent Quality", "what it looks after today, from the tree");
  assert.equal(area.querySelector("[data-field='area']")!.getAttribute("data-field-after"), "Agent Quality, Callers & Call Management");
  // Its answer joins the same thread batch; seen is that proposal's own rows.
  await click(hire.querySelector("[data-subject-approve]"));
  assert.deepEqual(batch().map((c) => [c.proposal.id, c.proposal.card, c.proposal.verdict]), [["fixture-union-staff-proposal", "role:broker-outreach", "approve"]]);
  await mount();
  await click(q("[data-company-replies] [data-send-answers='1']"));
  assert.ok(calls.includes(`reply:fixture-union-staff-proposal:approve@1:1,2:${THREAD}`), calls.join("\n"));

  // Approving the purpose keeps its sentence in the header; it never reads as none written.
  await mount();
  await click(q("[data-subject='goal:union-purpose'] [data-subject-approve]"));
  await mount();
  await click(q("[data-company-replies] [data-send-answers='1']"));
  await mount();
  assert.equal(q("[data-company-purpose-line]")!.getAttribute("data-company-purpose-line"), "accepted");
  assert.match(q("[data-company-purpose]")!.textContent!, /^Union is a curated relationship network.*accepted$/);
  assert.equal(q("[data-subject='goal:union-purpose'] [data-subject-state]")!.textContent, "Approved");

  // A change that only writes a goal's record joins the goal's card and says what it writes, in words.
  state.orgProposalChanges = { ...state.orgProposalChanges, "record-only": { ...fx.COMPANY_FIXTURE_CHANGES[5], _id: "record-only", seq: 40, status: "proposed", change: { kind: "initiative_shape", initiative: "in-1", done_when: "Every active project names a lead for a month." } } };
  await mount();
  const record = q("[data-company-goal='in-1'] [data-subject='goal:union-in-1']")!;
  assert.equal(record.getAttribute("data-change-ids"), "union-leads record-only");
  assert.equal(record.querySelector("[data-subject-sentence]")!.textContent, "Move this goal under the purpose and record what done looks like on it.");
  assert.equal(record.querySelector("[data-field='done_when']")!.getAttribute("data-field-after"), "Every active project names a lead for a month.");
  assert.ok(record.querySelector("[data-subject-approve]"));
  delete state.orgProposalChanges["record-only"];

  // ── a narrow pane: one column, the chips under the heading, a project's facts under its name ──
  env.width = 390;
  await mount();
  const phoneCard = q("[data-subject='goal:union-cost']")!;
  assert.equal(phoneCard.getAttribute("data-layout"), "auto", "the card asks its own width for where the answers sit");
  assert.ok(phoneCard.querySelector("[data-subject-verdicts] [data-subject-approve]"));
  state.orgProposals = {}; state.orgProposalChanges = {};
  await mount();
  assert.equal(q("[data-company-document]")!.getAttribute("data-company-layout"), "narrow");
  assert.equal(q("[data-company-toc]")!.getAttribute("data-company-toc"), "compact", "the contents stay, folded");
  assert.deepEqual(sections(), ["company", "goals", "projects", "people"]);
  const phoneGoal = q("[data-company-goal='in-2']")!;
  assert.equal(phoneGoal.querySelector("[data-company-byline]"), null);
  assert.ok(phoneGoal.querySelector(":scope > [data-company-chips] [data-face='person:Ashot Petrosian']"), "the owner joins the line of chips under the heading");
  assert.match(phoneGoal.querySelector(":scope > [data-company-chips]")!.className, /flex-wrap/);
  const phoneRow = phoneGoal.querySelector("[data-company-project='pr-6']")!;
  assert.doesNotMatch(phoneRow.className, /grid/);
  assert.ok(phoneRow.querySelector("[data-company-project-meta] [data-company-project-lead]"));
  assert.ok(phoneRow.querySelector("[data-company-project-meta] [data-company-project-counts]"));
  env.width = 1280;

  // ── before the org tree arrives: the plain outline under the team's name ──
  env.tree = null;
  propose();
  await mount();
  assert.equal(q("[data-company-name]")!.textContent, "Union");
  assert.deepEqual(goalIds("[data-company-section='goals'] > [data-company-goal]"), ["in-2", "in-4", "in-1"]);
  assert.equal(qa("[data-subject]").length, 0, "no tree, no cards");
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

test("company document mount: the sections, a goal's chips, every name a link, proposals in place, a narrow pane", async () => {
  await verifyCompany();
}, 600_000);
