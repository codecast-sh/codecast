// A goal's sheet and a project's sheet (cohesive build spec §5.2, §5.3),
// mounted in jsdom over the typed initiative fixture and the org fixture.
// Proves, for a goal: the sections stand in §5.2's order (Why, Measured by,
// Now, Carried by, Latest update, then The record and Activity
// folded); the head carries the number and no task bar; Carried by lists the
// projects with their own trouble word and the goal under it; an update
// posted paints the update and the head's health in the same tick; and a
// fresh goal is its head and one line naming what is still to write, each
// phrase opening its editor, with no empty section and no column of italics,
// while its menu starts a number, an update or a project. For a
// project: What it is for, Where it stands in its lead's dated words, Now
// with live sessions, Carried by (the lead role and the people at work in
// its folder), Work counted by the board's rule with Open the board, and the
// charter folded; no word on it calls the charter field a goal; and its
// status is picked in its head.
// Run: bun test components/org/company/sheets/GoalProjectSheets.mount.test.tsx
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { InitiativeRow, InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import { restoreInboxStoreAfterAll } from "../../../__tests__/mockInboxStore";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

restoreInboxStoreAfterAll();

async function verifySheets() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DOMRect"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).ResizeObserver = (dom.window as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  (dom.window as any).HTMLElement.prototype.scrollIntoView = () => {};
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;
  const h = React.createElement;

  // ── the world the sheets read ──
  const fx = await import("../../../initiatives/initiativeFixture");
  const { ORG_FIXTURE_WITH_HEAD } = await import("../../orgFixture");
  const { projectTaskCounts } = await import("@codecast/shared/tasks");
  const DAY = 86_400_000;
  const GROWTH_CONV = "fixture-growth-conv";
  // The growth role leads "Agent org" (its scope holds it), and the project's folder is where Sam and Ashot work.
  const tree = { ...ORG_FIXTURE_WITH_HEAD, roles: ORG_FIXTURE_WITH_HEAD.roles.map((r) => (r._id === "fixture-role-growth" ? { ...r, scope: { ...r.scope, project_ids: [...r.scope.project_ids, "proj-org"] } } : r)) };
  const collections: Record<string, any[]> = {
    initiatives: fx.FIXTURE_INITIATIVES.map((r) => ({ ...r })),
    initiativeUpdates: fx.FIXTURE_UPDATES.map((u) => ({ ...u })),
    projects: fx.FIXTURE_PROJECTS.map((p) => (p._id === "proj-org"
      ? { ...p, short_id: "pj-org", project_path: "~/src/codecast", goal: "Every area of the product has a lead that is an agent.", success_metrics: ["A person reads one page a week"], risks: ["Roles step on each other"] }
      : p._id === "proj-inbox" ? { ...p, short_id: "pj-inbox" } : { ...p }))
      // Worked by people and no role: its folder is where Ashot and Sam have sessions.
      .concat([{ ...fx.FIXTURE_PROJECTS.find((p) => p._id === "proj-billing")!, _id: "proj-platform", short_id: "pj-platform", title: "Platform", project_path: "~/src/platform", risks: undefined }])
      // Led by the growth role, whose brief says nothing about it: its pinned state speaks. No short id, no deadline.
      .concat([{ ...fx.FIXTURE_PROJECTS.find((p) => p._id === "proj-billing")!, _id: "proj-led", short_id: undefined, title: "Led", owner_role_id: "fixture-role-growth", target_date: undefined, risks: undefined }])
      // In another workspace the viewer belongs to.
      .concat([{ ...fx.FIXTURE_PROJECTS.find((p) => p._id === "proj-billing")!, _id: "proj-union", short_id: "pj-union", title: "Union outreach", workspace: "team:other-team", team_id: "other-team" }]),
    tasks: fx.FIXTURE_TASKS,
    plans: fx.FIXTURE_PLANS,
  };
  const patchGoal = (id: string, fields: Partial<InitiativeRow>) => { collections.initiatives = collections.initiatives.map((r) => (r._id === id ? { ...r, ...fields } : r)); };
  patchGoal("init-org", {
    metrics: [{ key: "weekly_active_teams", name: "Weekly active teams", target: "1,000" }],
    scoreboard: { weekly_active_teams: { value: "412", observed_at: fx.FIXTURE_NOW - 2 * DAY, source: "https://example.com/board" } },
  });
  const calls: string[] = [];
  // The real store, holding the fixture as the feeders would leave it. The
  // actions are stand-ins that do to the store what the slices do to the
  // draft (store/initiativeSlice.ts, inboxStore updateProject, proven in their
  // own tests), so a write repaints the sheet through its own subscriptions.
  const { useInboxStore } = await import("../../../../store/inboxStore");
  const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r._id, r]));
  const patchRow = (table: string, id: string, fields: any) => useInboxStore.setState((s: any) => ({ [table]: { ...s[table], [id]: { ...s[table][id], ...fields } } }) as any);
  useInboxStore.setState({
    currentUser: { _id: "fixture-user-me", name: "Ashot" },
    clientState: { ...useInboxStore.getState().clientState, ui: { ...(useInboxStore.getState().clientState.ui ?? {}), active_team_id: "fixture-team" } },
    orgTree: tree,
    teams: [{ _id: "fixture-team", name: "Fixture" }, { _id: "other-team", name: "Union" }],
    orgProposals: {},
    orgProposalChanges: {},
    teamMembers: [{ _id: "fixture-user-me", name: "Ashot Petrosian", github_username: "ashot" }, { _id: "fixture-user-sam", name: "Samvit Jain", github_username: "samvit" }],
    initiatives: byId(collections.initiatives),
    initiativeUpdates: byId(collections.initiativeUpdates),
    projects: byId(collections.projects),
    tasks: byId(collections.tasks),
    syncMeta: { 'tasks:v2:{"workspace":"team","team_id":"fixture-team"}': { backfilledAt: 1 } },
    updateInitiative: (id: string, fields: any) => { calls.push(`update:${id}:${JSON.stringify(fields)}`); patchRow("initiatives", id, fields); },
    recordInitiativeEntry: (id: string, op: any) => calls.push(`record:${id}:${JSON.stringify(op)}`),
    addInitiativeProject: (id: string, p: string) => calls.push(`add:${id}:${p}`),
    removeInitiativeProject: (id: string, p: string) => calls.push(`remove:${id}:${p}`),
    postInitiativeUpdate: (id: string, u: { client_key: string; body: string; health: InitiativeUpdateRow["health"] }) => {
      calls.push(`post:${id}:${u.health}:${u.body}`);
      useInboxStore.setState((s: any) => ({ initiativeUpdates: { ...s.initiativeUpdates, [u.client_key]: { _id: u.client_key, client_key: u.client_key, initiative_id: id, body: u.body, health: u.health, by: { kind: "user", user_id: "fixture-user-me" }, at: fx.FIXTURE_NOW, workspace: "team:fixture-team", user_id: "fixture-user-me" } } }) as any);
      patchRow("initiatives", id, { health: u.health, health_at: fx.FIXTURE_NOW });
    },
    // The real action paints the stub and lists it under the goal in one draft
    // (store inboxStore.test "a project created under a goal"); the answer never comes here.
    createProject: (opts: any, cont: any) => {
      calls.push(`createProject:${opts.title}:${cont?.kind}:${cont?.initiativeId}`);
      useInboxStore.setState((s: any) => ({ projects: { ...s.projects, [opts.client_key]: { _id: opts.client_key, client_key: opts.client_key, title: opts.title, status: "active", workspace: "team:fixture-team", team_id: "fixture-team", task_counts: { total: 0, done: 0, in_progress: 0 }, plan_count: 0, doc_count: 0, active_plan_count: 0, created_at: fx.FIXTURE_NOW, updated_at: fx.FIXTURE_NOW } } }) as any);
      const goal = (useInboxStore.getState() as any).initiatives[cont.initiativeId];
      patchRow("initiatives", cont.initiativeId, { project_ids: [...goal.project_ids, opts.client_key] });
      return new Promise(() => {});
    },
    updateProject: (id: string, fields: any) => { calls.push(`updateProject:${id}:${JSON.stringify(fields)}`); patchRow("projects", id, fields); },
  } as any);
  const realSyncCollection = { ...(await import("../../../../hooks/useSyncCollection")) };
  mock.module("../../../../hooks/useSyncCollection", () => ({ ...realSyncCollection, useSyncCollection: () => ({ ready: true, refused: false, retry: () => {} }) }));
  const real_useWorkspaceArgs = { ...(await import("../../../../hooks/useWorkspaceArgs")) };
  mock.module("../../../../hooks/useWorkspaceArgs", () => ({ ...real_useWorkspaceArgs, useWorkspaceArgs: () => ({ workspace: "team", team_id: "fixture-team" }) }));
  const realNow = { ...(await import("../../../../hooks/useCoarseNow")) };
  mock.module("../../../../hooks/useCoarseNow", () => ({ ...realNow, useCoarseNow: () => fx.FIXTURE_NOW, useNowWhen: () => fx.FIXTURE_NOW }));
  const realOrgRoles = { ...(await import("../../../../hooks/useOrgRoles")) };
  mock.module("../../../../hooks/useOrgRoles", () => ({ ...realOrgRoles, useOrgRoles: () => ({ roles: tree.roles, workspace: tree.workspace, roleBotUserIds: new Set<string>() }) }));
  const realRoster = { ...(await import("../../../../hooks/useTeamRoster")) };
  mock.module("../../../../hooks/useTeamRoster", () => ({ ...realRoster, useTeamRosterIdentity: () => (useInboxStore.getState() as any).teamMembers }));
  // The lead's brief: its "Where it stands" section names the project and the day it was written.
  const real_useQueryNoThrow = { ...(await import("../../../../hooks/useQueryNoThrow")) };
  mock.module("../../../../hooks/useQueryNoThrow", () => ({ ...real_useQueryNoThrow, useQueryNoThrow: (_fn: unknown, args: any) => ({ data: args?.role_id === "fixture-role-growth" ? { narrative: "## Where it stands\n- Agent org: The scope view ships Friday; the inbox still has no lead. (2026-09-16)\n" } : undefined, error: undefined, retry: () => {} }) }));
  const realAsks = { ...(await import("../../useNeedsYou")) };
  mock.module("../../useNeedsYou", () => ({ ...realAsks, useOrgAsks: () => [] }));
  const real_useOpenLinkedSession = { ...(await import("../../../../hooks/useOpenLinkedSession")) };
  mock.module("../../../../hooks/useOpenLinkedSession", () => ({ ...real_useOpenLinkedSession, useOpenLinkedSession: () => () => {} }));
  const realNav = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ replace: (u: string) => calls.push(`replace:${u}`), push: (u: string) => calls.push(`push:${u}`) }), useSearchParams: () => new URLSearchParams(""), usePathname: () => "/org" }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
  // Other surfaces' drawing: each says only that it is there, and what it was asked for.
  const realOrgHistory = { ...(await import("../../history/OrgHistory")) };
  mock.module("../../history/OrgHistory", () => ({ ...realOrgHistory, OrgHistory: (props: any) => h("div", { "data-org-history": props.projectId ?? "" }) }));
  const realScopeFeed = { ...(await import("../../scope/ScopeFeed")) };
  mock.module("../../scope/ScopeFeed", () => ({ ...realScopeFeed, ScopeFeed: (props: any) => h("div", { "data-scope-feed": JSON.stringify(props.scope) }) }));
  const realProjectTimeline = { ...(await import("../../../ProjectTimeline")) };
  mock.module("../../../ProjectTimeline", () => ({ ...realProjectTimeline, ProjectTimeline: (props: any) => h("div", { "data-project-timeline": props.projectId, "data-project-timeline-composer": props.composer === false ? "0" : "1" }) }));
  const realRepositoryLinks = { ...(await import("../../../repo/RepositoryLinks")) };
  mock.module("../../../repo/RepositoryLinks", () => ({ ...realRepositoryLinks, RepositoryLinks: (props: any) => h("div", { "data-repository-links": props.projectId }) }));
  const realCharterBlock = { ...(await import("../../../charter/CharterBlock")) };
  mock.module("../../../charter/CharterBlock", () => ({ ...realCharterBlock, CharterBlock: (props: any) => h("div", { "data-charter": props.title, "data-charter-plain": props.plain ? "1" : "0", "data-charter-hide-goal": props.hideGoal ? "1" : "0" }) }));
  const realMarkdownRenderer = { ...(await import("../../../tools/MarkdownRenderer")) };
  mock.module("../../../tools/MarkdownRenderer", () => ({ ...realMarkdownRenderer, MarkdownRenderer: ({ content }: any) => h("div", { "data-markdown": true }, content) }));
  const realPill = { ...(await import("../../../EntityIdPill")) };
  mock.module("../../../EntityIdPill", () => ({ ...realPill, EntityIdPill: ({ id, type }: any) => h("span", { "data-pill": `${type}:${id}` }, id) }));
  const realLeadChip = { ...(await import("../../../charter/ProjectLeadChip")) };
  mock.module("../../../charter/ProjectLeadChip", () => ({ ...realLeadChip, ProjectLeadChip: ({ projectId }: any) => h("span", { "data-project-lead-chip": projectId }) }));
  const realRoleFace = { ...(await import("../../RoleFace")) };
  mock.module("../../RoleFace", () => ({ ...realRoleFace, RoleFace: ({ role }: any) => h("span", { "data-role-face": role.handle }) }));
  const realAssignee = { ...(await import("../../../identity/AssigneeFace")) };
  mock.module("../../../identity/AssigneeFace", () => ({ ...realAssignee, AssigneeFace: ({ info }: any) => h("span", { "data-face": info.name }) }));
  // Menus and popovers that are simply open: the items inside are what the test reads and clicks.
  const realDropdown = { ...(await import("../../../ui/dropdown-menu")) };
  mock.module("../../../ui/dropdown-menu", () => ({ ...realDropdown,
    DropdownMenu: ({ children }: any) => children, DropdownMenuTrigger: ({ children }: any) => children, DropdownMenuSeparator: () => null, DropdownMenuLabel: () => null,
    DropdownMenuContent: ({ children }: any) => h("div", { "data-menu": true }, children),
    DropdownMenuItem: ({ children, onSelect, ...rest }: any) => h("button", { type: "button", "data-menu-item": typeof children === "string" ? children : "", onClick: () => onSelect?.(new Event("select")), ...rest }, children),
  }));
  const realPopover = { ...(await import("../../../ui/popover")) };
  mock.module("../../../ui/popover", () => ({ ...realPopover, Popover: ({ children }: any) => children, PopoverTrigger: ({ children }: any) => children, PopoverAnchor: ({ children }: any) => children, PopoverContent: ({ children }: any) => h("div", { "data-popover": true }, children) }));

  const { createRoot } = await import("react-dom/client");
  const { SheetHostContext } = await import("../sheetHost");
  const { GoalSheet } = await import("./GoalSheet");
  const { ProjectSheet } = await import("./ProjectSheet");
  // Arrived by URL: the owner's seat is the left pane, so the head offers neither Talk nor Ask (D5a, D6).
  const host = { under: null, underTitle: null, back() {}, close() {}, open: (k: string, r: string) => calls.push(`open:${k}:${r}`), talk() {}, talkable: true, leftConversationId: GROWTH_CONV, openProposal() {}, focusTitle: false, titleSettled() {}, covers: false };
  let root = createRoot(document.getElementById("root")!);
  let node: () => any = () => null;
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const click = async (el: Element | null | undefined) => { assert.ok(el, "missing element"); await act(async () => { (el as HTMLElement).click(); }); };
  const type = async (el: Element | null, value: string) => {
    assert.ok(el, "missing field");
    const proto = el instanceof (dom.window as any).HTMLTextAreaElement ? (dom.window as any).HTMLTextAreaElement.prototype : (dom.window as any).HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true })); });
  };
  const sheet = (kind: string, ref: string) => () => h(SheetHostContext.Provider, { value: host as any }, h(kind === "project" ? ProjectSheet : GoalSheet, { sheet: { kind, ref } as any }));
  const mount = async (n: () => any) => { node = n; await act(async () => root.unmount()); root = createRoot(document.getElementById("root")!); await act(async () => root.render(n())); };
  // The fake store does not notify: a fresh render reads what the action wrote.
  const repaint = () => act(async () => root.render(node()));
  /** The sheet's sections and folds, in the order they read. */
  const order = () => qa("[data-sheet-body] [data-initiative-section], [data-sheet-body] [data-sheet-section], [data-sheet-body] [data-sheet-fold]")
    .filter((el) => !el.parentElement?.closest("[data-sheet-fold]"))
    .map((el) => el.getAttribute("data-initiative-section") ?? el.getAttribute("data-sheet-section") ?? `fold:${el.getAttribute("data-sheet-fold")}`);
  const menu = () => qa("[data-menu-item]").map((b) => b.textContent);

  // ── a goal with everything: §5.2's order ──
  await mount(sheet("initiative", "in-1"));
  assert.equal(q("[data-sheet]")!.getAttribute("data-sheet"), "initiative");
  assert.deepEqual(order(), ["why", "metrics", "Now", "carried", "updates", "fold:The record", "fold:Activity"]);
  assert.equal(q("[data-sheet-talk]"), null, "the owner is already on the left");
  assert.equal(q("[data-sheet-ask-input]"), null);
  // The head: owner, health, the number against its target, the date. A goal's progress is its number: no task bar.
  const facts = q("[data-sheet-facts]")!;
  assert.match(facts.textContent!, /412/);
  assert.equal(q("[data-initiative-progress]"), null, "no task bar on a goal");
  // Why reads the goal's own words.
  assert.match(q("[data-goal-why] [data-markdown]")!.textContent!, /routing work that an agent could route/);
  // Now: the sessions at work under the projects that carry it.
  assert.match(q("[data-now-sessions]")!.textContent!, /at work/);
  // Carried by: its projects, each with what it says against itself, then the goal under it.
  const carried = q("[data-initiative-section='carried']")!;
  assert.deepEqual(qa("[data-initiative-section='carried'] [data-line]").map((l) => `${l.getAttribute("data-line")}:${l.getAttribute("data-line-ref") ?? l.getAttribute("data-line-id")}`), ["project:pj-org", "project:pj-inbox", "goal:in-2"]);
  // The trouble word stands in the state cell, so the name keeps the whole title column; a quiet active project says nothing there.
  assert.match(carried.querySelector("[data-initiative-project='proj-inbox'] [data-line-state] [data-initiative-project-trouble]")!.textContent!, /past its target/);
  assert.equal(carried.querySelector("[data-initiative-project='proj-inbox'] .ol-sub"), null);
  assert.equal(carried.querySelector("[data-initiative-project] [data-project-status='active']"), null, "no line says active");
  assert.ok(carried.querySelector("[data-initiative-projects-edit]"), "+ Project");
  // A new project by name lands under the goal at once, with no wait on the server.
  await type(q("[data-initiative-new-project]"), "Launch kit");
  await act(async () => { q("[data-initiative-new-project]")!.closest("form")!.dispatchEvent(new (dom.window as any).Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(calls.at(-1), "createProject:Launch kit:attachToInitiative:init-org");
  assert.equal(q<HTMLInputElement>("[data-initiative-new-project]")!.value, "", "the field clears");
  await repaint();
  const stub = qa("[data-initiative-section='carried'] [data-initiative-project]").find((l) => l.getAttribute("data-initiative-project")!.startsWith("projstub-"));
  assert.ok(stub && /Launch kit/.test(stub.textContent!), "the new project is carried by the goal in the same tick");
  // Latest update: the newest in full, the older one folded.
  assert.deepEqual(qa("[data-initiative-update]").map((u) => u.getAttribute("data-initiative-update")), ["upd-2"]);
  await click(q("[data-initiative-updates-older]"));
  assert.deepEqual(qa("[data-initiative-update]").map((u) => u.getAttribute("data-initiative-update")), ["upd-2", "upd-1"]);
  // The record, folded, says what it holds.
  assert.equal(q("[data-sheet-fold='The record'] button")!.textContent!.replace("▸", "").trim(), "The recorddone when · 5 milestones · 2 questions · 2 decisions · 2 sources");
  assert.equal(q("[data-initiative-record]"), null, "folded until opened");
  await click(q("[data-sheet-fold='The record'] button"));
  assert.ok(q("[data-initiative-record='in-1']"));
  assert.equal(q("[data-initiative-section='why'] ~ [data-initiative-section='why']"), null);
  // Activity: the scope feed over its projects and the goal under it.
  await click(q("[data-sheet-fold='Activity'] button"));
  assert.deepEqual(JSON.parse(q("[data-scope-feed]")!.getAttribute("data-scope-feed")!).scope.initiative_ids.sort(), ["init-org", "init-org-sub"]);

  // ── an update posted paints the update and the head's health in the same tick ──
  await click(q("[data-initiative-update-open]"));
  await type(q("[data-initiative-update-form] textarea"), "The scope view shipped.");
  await click(q("[data-initiative-update-health-pick='on_track']"));
  await act(async () => { q<HTMLFormElement>("[data-initiative-update-form]")!.dispatchEvent(new (dom.window as any).Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(calls.at(-1), "post:init-org:on_track:The scope view shipped.");
  await repaint();
  assert.equal(q("[data-initiative-update-form]"), null, "the form closes");
  assert.equal(qa("[data-initiative-update]")[0].getAttribute("data-initiative-update-health"), "on_track", "the new update reads first");
  assert.match(q("[data-sheet-facts]")!.textContent!, /On track/i, "and the head says what it said");

  // ── a fresh goal: its head and one line naming what is still to write ──
  await mount(sheet("initiative", "in-4"));
  assert.deepEqual(order(), [], "nothing else: no empty Why, no number, no Now, no Carried by, no updates, no record");
  assert.equal(q("[data-goal-still]")!.textContent, "Still to write: why it matters · a number · what done looks like");
  assert.deepEqual(qa("[data-goal-sheet] .italic").map((e) => e.outerHTML), [], "no column of italics under the head");
  assert.doesNotMatch(q("[data-sheet-body]")!.textContent!, /Nobody|No milestones|No project carries|No update yet|Nothing recorded/);
  assert.deepEqual(menu(), ["Post an update", "Add a number", "Add a project", "Copy link", "Cancel this goal"]);
  // "why it matters" opens Why on its editor; cancelled unwritten, Why goes and the phrase is back.
  await click(q("[data-goal-still-item='why']"));
  assert.ok(q("[data-goal-why] [data-initiative-field='why']"), "Why opens on its editor");
  assert.equal(q("[data-goal-still-item='why']"), null);
  await click([...q("[data-goal-why]")!.querySelectorAll("button")].find((b) => b.textContent === "Cancel"));
  assert.equal(q("[data-goal-why]"), null);
  assert.ok(q("[data-goal-still-item='why']"));
  // Written, the phrase goes for good.
  await click(q("[data-goal-still-item='why']"));
  await type(q("[data-initiative-field='why']"), "Half our users open codecast on a phone.");
  await click(q("[data-goal-why] [data-initiative-form-submit]"));
  assert.equal(calls.at(-1), `update:init-orphan:${JSON.stringify({ why: "Half our users open codecast on a phone." })}`);
  await repaint();
  assert.match(q("[data-goal-why] [data-markdown]")!.textContent!, /on a phone/);
  assert.equal(q("[data-goal-still]")!.textContent, "Still to write: a number · what done looks like");
  // "a number" opens Measured by on its form, as the menu does.
  await click(q("[data-goal-still-item='number']"));
  assert.ok(q("[data-initiative-metrics-form]"), "Measured by opens on its form");
  assert.equal(q("[data-goal-still]")!.textContent, "Still to write: what done looks like");
  // "what done looks like" opens the record on done when, and the line is gone.
  await click(q("[data-goal-still-item='done_when']"));
  assert.equal(q("[data-goal-still]"), null);
  assert.ok(q("[data-sheet-fold='The record'][data-open] [data-initiative-field='done_when']"), "the record opens with done when ready to write");
  // A goal with no words of its own and a number still to set says so in the one line too.
  await mount(sheet("initiative", "in-2"));
  assert.equal(q("[data-goal-still]")!.textContent, "Still to write: why it matters · a number · what done looks like");
  assert.equal(q("[data-goal-why]"), null);
  // The head's health and the latest update's read in the same case.
  await mount(sheet("initiative", "in-1"));
  assert.equal(q("[data-goal-still]"), null, "a goal with everything written has no starter line");
  assert.match(q("[data-initiative-update] [data-initiative-health]")!.textContent!, /^[a-z]/);

  // ── a project ──
  await mount(sheet("project", "pj-org"));
  assert.equal(q("[data-sheet]")!.getAttribute("data-sheet"), "project");
  assert.deepEqual(order(), ["purpose", "stands", "Now", "Carried by", "Work", "fold:Charter", "fold:Activity"]);
  assert.equal(q("[data-sheet-purpose] [data-written='purpose']")!.textContent, "Every area of the product has a lead that is an agent.");
  // Where it stands: the lead's own line about it, with the day it was written.
  const stands = q("[data-project-stands]")!;
  assert.match(stands.textContent!, /The scope view ships Friday; the inbox still has no lead\./);
  assert.ok(stands.querySelector("[data-role-face='growth']"), "in its lead's name");
  assert.match(stands.querySelector("[data-project-stands-day]")!.textContent!, /Sep 16/);
  // Now: its live sessions.
  assert.match(q("[data-now-sessions]")!.textContent!, /at work/);
  // Carried by: the lead role, then the people at work in its folder.
  assert.deepEqual(qa("[data-sheet-section='Carried by'] [data-line]").map((l) => `${l.getAttribute("data-line")}:${l.getAttribute("data-line-ref")}`), ["role:or-1", "person:ashot", "person:samvit"]);
  // Work: counted by the board's own rule, and the way to the board.
  const n = projectTaskCounts(collections.tasks, ["proj-org"]);
  // The head says "N of M tasks"; Work says only what the head leaves out.
  assert.match(q("[data-sheet-facts]")!.textContent!, new RegExp(`${n.done} of ${n.total} tasks`));
  assert.equal(q("[data-sheet-work]")!.textContent, [n.in_progress ? `${n.in_progress} in progress` : "", n.open ? `${n.open} open` : ""].filter(Boolean).join(" · "));
  assert.doesNotMatch(q("[data-sheet-work]")!.textContent!, /tasks done/);
  assert.equal(q("[data-sheet-open-board]")!.getAttribute("href"), "/projects/pj-org");
  // The status picker says the status it sets, never the sessions (those are Now's).
  assert.equal(q("[data-sheet-facts] button[data-project-pick='status']")!.textContent!.trim(), "Active");
  assert.deepEqual(menu(), ["Open the board", "History", "Copy link"]);
  // History opens the org record filtered to the project, at the foot.
  assert.equal(q("[data-project-history]"), null);
  await click(qa("[data-menu-item]").find((b) => b.textContent === "History"));
  assert.equal(q("[data-project-history] [data-org-history]")!.getAttribute("data-org-history"), "proj-org");
  // The charter is folded, and opens as the plain block without its first field (the sheet edits that above).
  assert.match(q("[data-sheet-fold='Charter'] button")!.textContent!, /1 sign it works · 1 risk/);
  assert.equal(q("[data-charter]"), null);
  await click(q("[data-sheet-fold='Charter'] button"));
  assert.equal(q("[data-charter]")!.getAttribute("data-charter-plain"), "1");
  assert.equal(q("[data-charter]")!.getAttribute("data-charter-hide-goal"), "1");
  assert.ok(q("[data-repository-links='proj-org']"));
  assert.ok(q("[data-project-folder]"));
  // One word, one meaning: nothing on the sheet calls the charter field a goal.
  assert.doesNotMatch(q("[data-sheet-body]")!.textContent!, /\bGoal\b|Success/);
  // The status is picked in the head and paints at once.
  await click(qa("[data-sheet-facts] [data-popover] button").find((b) => b.textContent?.trim() === "Paused"));
  assert.equal(calls.at(-1), `updateProject:proj-org:${JSON.stringify({ status: "paused" })}`);
  // What it is for is written through the project's own action.
  await click(q("[data-sheet-purpose] [data-initiative-edit='purpose']"));
  await type(q("[data-initiative-field='purpose']"), "One page a week.");
  await act(async () => { q("[data-initiative-field='purpose']")!.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
  assert.equal(calls.at(-1), `updateProject:proj-org:${JSON.stringify({ goal: "One page a week." })}`);

  await click(q("[data-sheet-fold='Activity'] button"));
  assert.equal(q("[data-project-timeline='proj-org']")!.getAttribute("data-project-timeline-composer"), "0", "the sheet reads the timeline; the board writes updates");

  // A project worked by people and no role: Now has the sessions Carried by counts.
  await mount(sheet("project", "pj-platform"));
  assert.deepEqual(qa("[data-sheet-section='Carried by'] [data-line]").map((l) => `${l.getAttribute("data-line")}:${l.getAttribute("data-line-ref")}`), ["person:ashot", "person:samvit"]);
  assert.ok(q("[data-sheet-now]"), "Now stands when only people work it");
  assert.match(q("[data-now-sessions]")!.textContent!, /at work/);

  // A project its lead's brief does not name: the lead's pinned state, drawn
  // as the brief line is (face, wrapping sentence, state word as the tail).
  // No short id: no id beside the name, Copy link by its Convex id still.
  await mount(sheet("project", "proj-led"));
  const pinned = q("[data-project-stands='pinned']")!;
  assert.ok(pinned.querySelector("[data-role-face='growth']"));
  assert.match(pinned.textContent!, /Rewriting the weekly growth review/);
  assert.equal(pinned.querySelector("[data-project-stands-state]")!.textContent, "· in progress");
  assert.equal(pinned.querySelector(".truncate"), null, "the sentence wraps");
  assert.equal(q("[data-sheet-id]"), null);
  assert.ok(menu().includes("Copy link"));
  // The deadline is set from the sheet's head: the end of that day, local time.
  const target = q("[data-sheet-facts] button[data-project-pick='target']")!;
  assert.match(target.textContent!, /No deadline/);
  await click(target);
  const day = q<HTMLInputElement>("[data-sheet-facts] input[type='date']")!;
  await type(day, "2026-11-03");
  await act(async () => { day.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  assert.equal(calls.at(-1), `updateProject:proj-led:${JSON.stringify({ target_date: new Date(2026, 10, 3, 23, 59, 59).getTime() })}`);

  // A project in another workspace: its real name and the switch, as the board says it.
  await mount(sheet("project", "pj-union"));
  assert.equal(q("[data-sheet-title]")!.textContent, "Union outreach");
  assert.equal(q("[data-foreign-workspace]")!.getAttribute("data-foreign-workspace"), "Union");
  assert.ok(q("[data-foreign-switch]"));
  // A ref that resolves nowhere says only that.
  await mount(sheet("project", "pj-nowhere"));
  assert.ok(q("[data-sheet-missing]"));
  assert.equal(q("[data-foreign-workspace]"), null);

  // A project nobody has written about: no Where it stands, no Carried by, and Work says the board is empty.
  await mount(sheet("project", "proj-billing"));
  assert.deepEqual(order(), ["purpose", "stands", "Work", "fold:Charter", "fold:Activity"], "its charter's risk is what it says against itself");
  assert.match(q("[data-sheet-section='stands']")!.textContent!, /1 risk in its charter/);

  await act(async () => root.unmount());
  closeDomWindow(dom);
}

test("goal and project sheets: §5.2 and §5.3 order, fresh objects say nothing empty, writes paint at once", async () => {
  await verifySheets();
}, 600_000);
