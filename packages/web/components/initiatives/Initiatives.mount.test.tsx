// Initiatives on the web (docs/architecture/initiatives-projects-role-page.md
// I1), mounted in jsdom against the typed fixture of the contract's rows.
// Proves: the list groups by status with owner, health, target and progress
// derived from the tasks, the first number against its target and the next
// milestone, and nests a sub initiative; the page's header wears the same
// chips; the panel has two tabs, Goal (the record in the order of I5's test)
// and Activity (the scope feed over the goal's projects and its sub goals',
// selected by ?tab=activity); a page whose owner is a
// role opens as that role's standing conversation with the initiative beside
// it; a page whose owner is a person opens on the person's anchor, and one with
// no conversation to open is the initiative alone; the projects are the scope
// view's own card with lead, counts, plans and the project's own trouble; an
// update posted paints the update and the header's health in the same tick;
// and the phone opens on the conversation with the initiative as a sheet.
// Run: bun test components/initiatives/Initiatives.mount.test.tsx
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";
import type { InitiativeRow, InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import type { OrgTree } from "../org/orgTypes";

async function verifyInitiatives() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  // ── the world the pages read ──
  const { ORG_FIXTURE } = await import("../org/orgFixture");
  const fx = await import("./initiativeFixture");
  const env = { phone: false, wide: true, search: "", tree: ORG_FIXTURE as OrgTree, origin: null as null | { at: number; batch: string; proposal?: { short_id: string; title?: string }; undone: boolean } };
  const calls: string[] = [];
  const collections: Record<string, any[]> = {
    initiatives: fx.FIXTURE_INITIATIVES.map((r) => ({ ...r })),
    initiativeUpdates: fx.FIXTURE_UPDATES.map((u) => ({ ...u })),
    projects: fx.FIXTURE_PROJECTS, plans: fx.FIXTURE_PLANS, tasks: fx.FIXTURE_TASKS,
  };
  const patch = (id: string, fields: Partial<InitiativeRow>) => { collections.initiatives = collections.initiatives.map((r) => (r._id === id ? { ...r, ...fields } : r)); };
  // The first goal carries one number, reported twice (I4, I5), set here so
  // the chips below read the same whatever the fixture's own record grows
  // into. Its milestones are the fixture's, read through the contract.
  const DAY = 86_400_000;
  const { nextMilestone } = await import("@codecast/shared/contracts/initiative");
  const nextUp = nextMilestone(fx.FIXTURE_INITIATIVES.find((r) => r._id === "init-org")!)!;
  assert.ok(nextUp && !nextUp.done_at, "the fixture's first goal has a milestone still ahead");
  const nextUpState = nextUp.date && nextUp.date < fx.FIXTURE_NOW ? "late" : "next";
  patch("init-org", {
    metrics: [{ key: "weekly_active_teams", name: "Weekly active teams", target: "1,000" }],
    scoreboard: { weekly_active_teams: { value: "412", observed_at: fx.FIXTURE_NOW - 2 * DAY, source: "https://example.com/board" } },
    score_history: { weekly_active_teams: [{ value: "380", observed_at: fx.FIXTURE_NOW - 9 * DAY, source: "https://example.com/board" }, { value: "412", observed_at: fx.FIXTURE_NOW - 2 * DAY, source: "https://example.com/board" }] },
  });
  const state: any = {
    currentUser: { _id: "fixture-user-me", name: "Ashot" },
    get orgTree() { return env.tree; },
    sessions: {} as Record<string, any>,
    // The task crawl has finished for the fixture's workspace (hooks/useSyncTasks writes this key).
    syncMeta: { 'tasks:v2:{"workspace":"team","team_id":"fixture-team"}': { backfilledAt: 1 } } as Record<string, any>,
    // The mount's stand-ins do what the slice's actions do to the draft
    // (store/initiativeSlice.ts, proven on the real store in its own test).
    createInitiative: (input: any) => { calls.push(`create:${input.title}:${input.workspace}:${input.owner?.kind}`); collections.initiatives = [...collections.initiatives, { _id: input.client_key, short_id: "", client_key: input.client_key, title: input.title, status: "proposed", owner: input.owner, project_ids: [], health: "none", workspace: "team:fixture-team", user_id: "fixture-user-me", created_at: fx.FIXTURE_NOW, updated_at: fx.FIXTURE_NOW }]; },
    updateInitiative: (id: string, fields: any) => { calls.push(`update:${id}:${JSON.stringify(fields)}`); patch(id, fields); },
    addInitiativeProject: (id: string, projectId: string) => calls.push(`add:${id}:${projectId}`),
    removeInitiativeProject: (id: string, projectId: string) => calls.push(`remove:${id}:${projectId}`),
    postInitiativeUpdate: (id: string, u: { client_key: string; body: string; health: InitiativeUpdateRow["health"] }) => {
      calls.push(`post:${id}:${u.health}:${u.body}`);
      collections.initiativeUpdates = [{ _id: u.client_key, client_key: u.client_key, initiative_id: id, body: u.body, health: u.health, by: { kind: "user", user_id: "fixture-user-me" }, at: fx.FIXTURE_NOW, workspace: "team:fixture-team", user_id: "fixture-user-me" }, ...collections.initiativeUpdates];
      patch(id, { health: u.health });
    },
  };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });

  mock.module("../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  const realOrgTree = { ...(await import("../../hooks/useSyncOrgTree")) };
  mock.module("../../hooks/useSyncOrgTree", () => ({ ...realOrgTree, useSyncOrgTree: () => ({ tree: env.tree, ready: true, missing: false, refused: false, retry: () => {} }), useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry: () => {} }) }));
  for (const h of ["useSyncProjects", "useSyncTasks", "useSyncPlans"]) {
    const realSync = { ...(await import(`../../hooks/${h}`)) };
    mock.module(`../../hooks/${h}`, () => ({ ...realSync, [h]: () => {} }));
  }
  mock.module("../../hooks/useSyncCollection", () => ({ useSyncCollection: () => ({ ready: true, refused: false, retry: () => {} }) }));
  mock.module("../../hooks/useWorkspaceCollection", () => ({ useWorkspaceCollection: (key: string) => collections[key] ?? [] }));
  mock.module("../../hooks/useCollectionRows", () => ({ useCollectionRows: (key: string, opts: any = {}) => (collections[key] ?? []).filter(opts.where ?? (() => true)).sort(opts.sort ?? (() => 0)) }));
  mock.module("../../hooks/useWorkspaceArgs", () => ({ useWorkspaceArgs: () => ({ workspace: "team", team_id: "fixture-team" }), workspaceStamp: (a: any) => ({ workspace: a.workspace, team_id: a.team_id }) }));
  mock.module("../../hooks/useIsPhone", () => ({ useIsPhone: () => env.phone, useMinWidth: () => env.wide, PHONE_MAX_WIDTH: 768 }));
  const realNow = { ...(await import("../../hooks/useCoarseNow")) };
  mock.module("../../hooks/useCoarseNow", () => ({ ...realNow, useCoarseNow: () => fx.FIXTURE_NOW, useNowWhen: () => fx.FIXTURE_NOW }));
  // The org log's answer to "where did this goal come from" (I1, revised).
  mock.module("../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: env.origin, error: undefined, retry: () => {} }) }));
  mock.module("../../hooks/useOrgRoles", () => ({ useOrgRoles: () => ({ roles: env.tree.roles, workspace: env.tree.workspace, roleBotUserIds: new Set<string>() }) }));
  const realRoster = await import("../../hooks/useTeamRoster");
  mock.module("../../hooks/useTeamRoster", () => ({ ...realRoster, useTeamRosterIdentity: () => [{ _id: "fixture-user-me", name: "Ashot" }, { _id: "fixture-user-sam", name: "Sam" }] }));
  mock.module("../../hooks/useRoleScope", () => ({ useRoleScope: () => ({ model: null, role: null }), useScopeRows: () => ({ projects: collections.projects, plans: collections.plans, tasks: collections.tasks, roles: env.tree.roles }) }));
  // The address bar: a replace moves the query the next render reads.
  mock.module("next/navigation", () => ({
    useRouter: () => ({ replace: (u: string) => { calls.push(`replace:${u}`); env.search = u.split("?")[1] ?? ""; }, push: (u: string) => calls.push(`push:${u}`) }),
    useSearchParams: () => new URLSearchParams(env.search),
    usePathname: () => "/initiatives",
  }));
  // The feed is the scope page's own engine (its mount test proves it); here it says which scope it was asked for.
  mock.module("../org/scope/ScopeFeed", () => ({ ScopeFeed: (props: any) => React.createElement("div", { "data-scope-feed": JSON.stringify(props.scope), "data-scope-feed-fill": props.fill ? "1" : "0" }, "feed") }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  mock.module("../../app/inbox/QueuePageClient", () => ({
    InboxConversation: (props: any) => React.createElement("div", { "data-thread": props.sessionId, "data-thread-owner": props.seat?.seedOwnership ? "1" : "0", "data-thread-placeholder": props.seat?.layout?.composerPlaceholder ?? "", "data-thread-hide-diff": props.seat?.layout?.hideDiff ? "1" : "0", "data-thread-autofocus": props.autoFocusInput ? "1" : "0" }, props.seat?.layout?.leadNode, React.createElement("textarea", { "data-composer": true })),
  }));
  mock.module("../../lib/sessionViewVisit", () => ({ askSessionView: (id: string) => calls.push(`sessionView:${id}`) }));
  const realKeys = { ...(await import("../KeyboardShortcutsHelp")) };
  mock.module("../KeyboardShortcutsHelp", () => ({ ...realKeys, ShortcutTooltip: ({ children }: any) => children, KeyCap: ({ children }: any) => React.createElement("kbd", null, children) }));
  const realPill = { ...(await import("../EntityIdPill")) };
  mock.module("../EntityIdPill", () => ({ ...realPill, EntityIdPill: ({ id, type }: any) => React.createElement("span", { "data-pill": `${type}:${id}` }, id) }));
  const realLeadChip = { ...(await import("../charter/ProjectLeadChip")) };
  mock.module("../charter/ProjectLeadChip", () => ({ ...realLeadChip, ProjectLeadChip: ({ projectId }: any) => React.createElement("span", { "data-project-lead-chip": projectId }) }));
  const realRoleFace = { ...(await import("../org/RoleFace")) };
  mock.module("../org/RoleFace", () => ({ ...realRoleFace, RoleFace: ({ role }: any) => React.createElement("span", { "data-role-face": role.handle }) }));
  const realAssignee = { ...(await import("../identity/AssigneeFace")) };
  mock.module("../identity/AssigneeFace", () => ({ ...realAssignee, AssigneeFace: ({ info }: any) => React.createElement("span", { "data-face": info.kind === "role" ? `role:${info.handle}` : `person:${info.name}` }) }));
  mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: any) => React.createElement("div", { "data-markdown": true }, content) }));
  mock.module("../ui/dropdown-menu", () => ({ DropdownMenu: ({ children }: any) => children, DropdownMenuContent: () => null, DropdownMenuItem: () => null, DropdownMenuLabel: () => null, DropdownMenuTrigger: ({ children }: any) => children }));
  // A popover that is simply open: the lists inside are what the test reads.
  mock.module("../ui/popover", () => ({ Popover: ({ children }: any) => children, PopoverTrigger: ({ children }: any) => children, PopoverAnchor: ({ children }: any) => children, PopoverContent: ({ children }: any) => React.createElement("div", { "data-popover": true }, children) }));

  const { createRoot } = await import("react-dom/client");
  const { InitiativesList } = await import("./InitiativesList");
  const { InitiativePageInner } = await import("./InitiativePage");
  let root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const click = async (el: Element | null) => { assert.ok(el, "missing element"); await act(async () => { (el as HTMLElement).click(); }); };
  const type = async (el: Element | null, value: string) => {
    assert.ok(el, "missing field");
    const proto = el instanceof (dom.window as any).HTMLTextAreaElement ? (dom.window as any).HTMLTextAreaElement.prototype : (dom.window as any).HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true })); });
  };
  const mount = async (node: any) => {
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(node));
  };
  const page = (id: string) => React.createElement(InitiativePageInner, { id });

  // ── the list: by status, active first, a sub initiative under its parent ──
  await mount(React.createElement(InitiativesList));
  assert.deepEqual(qa("[data-initiative-group]").map((g) => g.getAttribute("data-initiative-group")), ["active", "planned", "proposed", "completed"]);
  assert.deepEqual(qa("[data-initiative-group='active'] [data-initiative-row]").map((r) => r.getAttribute("data-initiative-row")), ["in-1", "in-2"], "the sub initiative sits under its parent");
  assert.equal(q("[data-initiative-row='in-2']")!.getAttribute("data-initiative-nested"), "1");
  const first = q("[data-initiative-row='in-1']")!;
  assert.equal(first.getAttribute("href"), "/initiatives/in-1");
  assert.ok(first.querySelector("[data-face='role:growth']"), "a role owner shows its face");
  assert.equal(first.querySelector("[data-initiative-health]")!.getAttribute("data-initiative-health"), "at_risk");
  assert.equal(first.querySelector("[data-initiative-target]")!.getAttribute("data-initiative-target"), "ahead");
  // 3 of 6: two projects' tasks, the dropped one left out. Derived, never stored.
  assert.equal(first.querySelector("[data-initiative-progress]")!.getAttribute("data-initiative-progress"), "3/6");
  assert.ok(q("[data-initiative-row='in-3'] [data-face='person:Ashot']"), "a person owner shows their face");
  assert.equal(q("[data-initiative-row='in-4'] [data-initiative-owner]")!.getAttribute("data-initiative-owner"), "none", "nobody drives it, said in words");
  assert.match(q("[data-initiative-row='in-4']")!.textContent!, /No owner/);
  // The first number as a chip, with which way it moved, and the next milestone with its day.
  const rowMetric = first.querySelector("[data-initiative-row-metric] [data-metric='weekly_active_teams']")!;
  assert.equal(rowMetric.getAttribute("data-metric-size"), "chip");
  assert.match(rowMetric.textContent!, /412\s*\/ 1,000/);
  assert.equal(rowMetric.querySelector("[data-metric-standing]")!.getAttribute("data-metric-standing"), "behind");
  assert.equal(rowMetric.querySelector("[data-metric-trend]")!.getAttribute("data-metric-trend"), "up");
  assert.equal(rowMetric.querySelector("[data-metric-trend]")!.getAttribute("data-metric-toward"), "yes");
  const rowMilestone = first.querySelector("[data-initiative-row-milestone] [data-initiative-milestone]")!;
  assert.equal(rowMilestone.getAttribute("data-initiative-milestone"), nextUpState, "the first one not reached, red once its day has passed");
  assert.ok(rowMilestone.textContent!.startsWith(nextUp.title), rowMilestone.textContent!);
  // A goal with neither keeps its two cells, so the columns after them stay in line.
  const bare = collections.initiatives.find((r) => !r.metrics?.length && !r.milestones?.length && !r.parent_initiative_id)!;
  const bareExtra = q(`[data-initiative-row='${bare.short_id}'] .initiative-extra`)!;
  assert.equal(bareExtra.getAttribute("data-empty"), "");
  assert.equal(bareExtra.children.length, 2);
  assert.equal(bareExtra.querySelector("[data-metric], [data-initiative-milestone]"), null);

  // On a cold cache the count is partial and says so, in the same component.
  state.syncMeta = {};
  await mount(React.createElement(InitiativesList));
  assert.equal(q("[data-initiative-row='in-1'] [data-initiative-progress]")!.getAttribute("data-initiative-progress"), "counting");
  state.syncMeta = { 'tasks:v2:{"workspace":"team","team_id":"fixture-team"}': { backfilledAt: 1 } };

  // A task done moves the bar with no write to the initiative.
  collections.tasks = fx.FIXTURE_TASKS.map((t) => (t._id === "7" ? { ...t, status: "done" } : t));
  await mount(React.createElement(InitiativesList));
  assert.equal(q("[data-initiative-row='in-1'] [data-initiative-progress]")!.getAttribute("data-initiative-progress"), "4/6");
  collections.tasks = fx.FIXTURE_TASKS;

  // Create: one field, the row is in the list in the same tick, owned by its maker, in the workspace on screen.
  await click(q("[data-initiative-new]"));
  await type(q("[data-initiative-create] input"), "Ship the mobile app");
  await act(async () => { q<HTMLFormElement>("[data-initiative-create]")!.dispatchEvent(new (dom.window as any).Event("submit", { bubbles: true, cancelable: true })); });
  assert.ok(calls.includes("create:Ship the mobile app:team:user"), calls.join("\n"));
  assert.ok(calls.some((c) => /^push:\/initiatives\/in_/.test(c)), "opens the new initiative by its key");
  assert.match(q("[data-initiative-group='proposed']")!.textContent!, /Ship the mobile app/);

  // ── a page whose owner is a role: its standing conversation, the initiative beside it ──
  await mount(page("in-1"));
  assert.equal(q("[data-initiative-page]")!.getAttribute("data-initiative-owner-kind"), "role");
  assert.equal(q("[data-scope-layout]")!.getAttribute("data-scope-layout"), "side");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread"), "fixture-growth-conv", "the role's standing session");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-owner"), "1", "the host talks to the seat");
  assert.match(q("[data-thread]")!.getAttribute("data-thread-placeholder")!, /^Ask .+ for anything/);
  assert.match(q("[data-initiative-lead]")!.textContent!, /I drive Agents run the company's routine work\. 2 projects carry it, with 3 of 6 tasks done\./);
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "side", "the initiative is open beside it");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-hide-diff"), "1");
  // The header: title, id, status, owner, health with its date, target, progress.
  assert.equal(q("[data-initiative-title]")!.textContent, "Agents run the company's routine work");
  assert.match(q("header")!.textContent!, /in-1/);
  assert.match(q("[data-initiative-pick='status']")!.textContent!, /Active/);
  assert.ok(q("[data-initiative-pick='owner'] [data-face='role:growth']"));
  assert.match(q("header [data-initiative-health]")!.textContent!, /At risk.*Sep 16/);
  assert.equal(q("header [data-initiative-progress]")!.getAttribute("data-initiative-progress"), "3/6");
  // The same chips the list row wears: the number against its target, and the next milestone.
  assert.ok(q("[data-intent-header]") === q("header"), "the header a project's page wears too");
  assert.match(q("header [data-intent-chips] [data-metric='weekly_active_teams'][data-metric-size='chip']")!.textContent!, /412\s*\/ 1,000/);
  assert.equal(q("header [data-intent-chips] [data-metric-trend]")!.getAttribute("data-metric-trend"), "up");
  assert.ok(q(`header [data-intent-chips] [data-initiative-milestone='${nextUpState}']`)!.textContent!.startsWith(nextUp.title));
  // The panel: two tabs in the scope panel's grammar, open on the goal.
  assert.deepEqual(qa("[data-initiative-panel] [data-scope-tab]").map((t) => t.getAttribute("data-scope-tab")), ["goal", "activity"]);
  assert.equal(q("[data-initiative-panel]")!.getAttribute("data-scope-tab-active"), "goal");
  assert.equal(q("[data-scope-tab='goal']")!.getAttribute("aria-current"), "page");
  assert.equal(q("[data-scope-feed]"), null);
  // The goal, top to bottom in the order of I5's test: what it is for, the
  // number, why, done when, milestones, what is undecided, what was decided,
  // who said it; then what carries it, what the owner said, what is under it.
  assert.deepEqual(qa("[data-initiative-section]").map((s) => s.getAttribute("data-initiative-section")), ["description", "why", "done_when", "metrics", "milestones", "questions", "decisions", "sources", "projects", "updates", "sub"]);
  assert.ok(q("[data-initiative-scroll] [data-initiative-record='in-1']"), "the record is the one component, mounted in the scroll");
  // Measured by: the tile every surface draws, now against the target, with its source.
  const tile = q("[data-initiative-metric='weekly_active_teams']")!;
  assert.equal(tile.querySelector("[data-metric-size]")!.getAttribute("data-metric-size"), "tile");
  assert.equal(tile.querySelector("[data-metric-now]")!.textContent, "412");
  assert.equal(tile.querySelector("a[href='https://example.com/board']")!.textContent, "example.com");
  // Projects: the scope view's own card, in the owner's order, each with its lead.
  assert.deepEqual(qa("[data-initiative-project]").map((p) => p.getAttribute("data-initiative-project")), ["proj-org", "proj-inbox"]);
  const org = q("[data-initiative-project='proj-org']")!;
  assert.ok(org.querySelector("[data-scope-project]"), "the card the role page draws");
  assert.ok(org.querySelector("[data-project-lead-chip='proj-org']"));
  assert.match(org.querySelector("[data-scope-project-line]")!.textContent!, /2 open/);
  assert.ok(org.querySelector("[data-scope-plan='pl-715']"), "its live plan, with progress");
  assert.equal(org.querySelector("[data-scope-plan='pl-600']"), null, "a finished plan is not listed");
  // What a project shares, and what it says for itself beside the owner's word.
  const inbox = q("[data-initiative-project='proj-inbox']")!;
  assert.ok(inbox.querySelector("[data-pill='initiative:in-3']"), "also in the other initiative");
  assert.equal(inbox.querySelector("[data-pill='initiative:in-1']"), null, "never its own");
  assert.match(inbox.querySelector("[data-initiative-project-trouble]")!.textContent!, /past its target/);
  assert.equal(org.querySelector("[data-initiative-project-trouble]"), null);
  // Updates newest first, each with its health and who said it; then the sub initiative.
  assert.deepEqual(qa("[data-initiative-update]").map((u) => u.getAttribute("data-initiative-update-health")), ["at_risk", "on_track"]);
  assert.ok(q("[data-initiative-update='upd-2'] [data-face='role:growth']"), "a role wrote it");
  assert.ok(q("[data-initiative-sub='in-2']"));

  // ── Activity: the scope feed over the goal's projects and its sub goals', in the URL ──
  const orgRow = collections.initiatives.find((r) => r._id === "init-org")!;
  const under = collections.initiatives.filter((r) => r.parent_initiative_id === "init-org");
  const expectedScope = {
    scope: { project_ids: [...new Set([orgRow, ...under].flatMap((r) => r.project_ids))], plan_ids: [], initiative_ids: [orgRow, ...under].map((r) => r._id) },
    team_id: "fixture-team",
  };
  assert.deepEqual(expectedScope.scope.project_ids, ["proj-org", "proj-inbox"], "each project once, the goal's own first");
  await click(q("[data-scope-tab='activity']"));
  assert.ok(calls.includes("replace:/initiatives/in-1?tab=activity"), calls.join("\n"));
  await act(async () => root.render(page("in-1")));
  assert.equal(q("[data-initiative-panel]")!.getAttribute("data-scope-tab-active"), "activity");
  assert.equal(q("[data-scope-tab='activity']")!.getAttribute("aria-current"), "page");
  assert.deepEqual(JSON.parse(q("[data-initiative-panel] [data-scope-feed]")!.getAttribute("data-scope-feed")!), expectedScope);
  assert.equal(q("[data-scope-feed]")!.getAttribute("data-scope-feed-fill"), "1", "the feed owns its scroll");
  assert.equal(qa("[data-initiative-section]").length, 0, "the record is one tab away");
  assert.ok(q("header [data-initiative-health]"), "the header stays");
  await click(q("[data-scope-tab='goal']"));
  assert.equal(calls.at(-1), "replace:/initiatives/in-1", "the goal is the bare address");
  await act(async () => root.render(page("in-1")));
  assert.equal(q("[data-scope-feed]"), null);
  assert.ok(q("[data-initiative-section='description']"));

  // The header's control puts the initiative away and brings it back.
  await click(q("[data-initiative-panel-toggle]"));
  assert.equal(q("[data-scope-aside]"), null);
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-hide-diff"), "0");
  await click(q("[data-initiative-panel-toggle]"));
  assert.ok(q("[data-scope-aside]"));

  // ── an update posted: the update and the header's health, in the same tick ──
  await click(q("[data-initiative-update-open]"));
  await type(q("[data-initiative-update-form] textarea"), "The inbox project has a lead now.");
  await click(q("[data-initiative-update-health-pick='on_track']"));
  await click(q("[data-initiative-update-post]"));
  assert.ok(calls.includes("post:init-org:on_track:The inbox project has a lead now."), calls.join("\n"));
  await act(async () => root.render(page("in-1")));
  assert.equal(q("[data-initiative-update-form]"), null, "the form closes");
  assert.equal(qa("[data-initiative-update]").length, 3);
  assert.match(qa("[data-initiative-update]")[0].textContent!, /The inbox project has a lead now\./);
  assert.ok(qa("[data-initiative-update]")[0].querySelector("[data-face='person:Ashot']"), "said by the person who posted it");
  assert.equal(q("header [data-initiative-health]")!.getAttribute("data-initiative-health"), "on_track", "health is whatever was said last");

  // Owner, status and description are one gesture each, and ride the named action.
  await click([...qa("[data-initiative-pick='owner'] ~ [data-popover] button, [data-popover] button")].find((b) => b.textContent?.includes("Sam")) ?? null);
  assert.ok(calls.includes(`update:init-org:${JSON.stringify({ owner: { kind: "user", user_id: "fixture-user-sam" } })}`), calls.join("\n"));

  // ── a page whose owner is a person: their own anchor beside it ──
  await mount(page("in-3"));
  assert.equal(q("[data-initiative-page]")!.getAttribute("data-initiative-owner-kind"), "user");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread"), "fixture-anchor-conv", "the person's anchor in this workspace");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-owner"), "1", "their own anchor is theirs to talk to");
  assert.ok(q("[data-scope-aside]"));
  assert.match(q("[data-initiative-section='updates']")!.textContent!, /No update yet/);
  assert.match(q("[data-initiative-project='proj-billing'] [data-initiative-project-trouble]")!.textContent!, /1 risk in its charter/);

  // Nobody drives it: no empty conversation, the initiative is the page.
  await mount(page("in-4"));
  assert.equal(q("[data-initiative-page]")!.getAttribute("data-initiative-owner-kind"), "none");
  assert.equal(q("[data-thread]"), null);
  assert.ok(q("[data-initiative-alone] [data-initiative-panel]"));
  assert.equal(q("[data-initiative-panel-toggle]"), null);
  assert.equal(q("[data-initiative-panel-close]"), null, "nothing to hand back to");
  assert.match(q("[data-initiative-section='projects']")!.textContent!, /No project carries this yet/);
  // A link straight to its activity: a personal or a team goal with no project still asks for its own scope.
  env.search = "tab=activity";
  await mount(page("in-4"));
  assert.deepEqual(JSON.parse(q("[data-initiative-alone] [data-scope-feed]")!.getAttribute("data-scope-feed")!), { scope: { project_ids: [], plan_ids: [], initiative_ids: ["init-orphan"] }, team_id: "fixture-team" });
  env.search = "";

  // An id that names nothing here says so.
  await mount(page("in-999"));
  assert.match(q("[data-initiative-missing]")!.textContent!, /No initiative in-999 in this workspace/);

  // ── the phone: the conversation leads, the initiative is a sheet one tap away ──
  env.phone = true; env.wide = false;
  await mount(page("in-2"));
  assert.equal(q("[data-scope-layout]")!.getAttribute("data-scope-layout"), "sheet");
  assert.equal(q("[data-scope-aside]"), null, "the conversation leads on the phone");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-autofocus"), "0", "no keyboard over the page on open");
  assert.match(q("[data-initiative-parent]")!.textContent!, /under/);
  assert.ok(q("[data-initiative-parent] [data-pill='initiative:in-1']"));
  await click(q("[data-initiative-panel-toggle]"));
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "sheet");
  await click(q("[data-initiative-panel-close]"));
  assert.equal(q("[data-scope-aside]"), null, "handed back to the conversation");
  // A link straight to a tab opens the sheet on it.
  env.search = "tab=activity";
  await mount(page("in-2"));
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "sheet");
  assert.ok(q("[data-scope-aside] [data-scope-feed]"));
  env.search = "";
  // The list on the phone stacks each row's facts under its title.
  await mount(React.createElement(InitiativesList));
  assert.ok(q("[data-initiative-row='in-1'] [data-initiative-progress]"));
  assert.ok(q("[data-initiative-row='in-1'] [data-metric='weekly_active_teams']"), "the number wraps under the title with the rest");
  assert.ok(q(`[data-initiative-row='in-1'] [data-initiative-milestone='${nextUpState}']`));

  // ── where a goal came from (I1, revised): the review's proposal, dated, one click away ──
  env.phone = false;
  env.origin = { at: Date.UTC(2026, 8, 23, 12), batch: "b1", proposal: { short_id: "op-8", title: "Company review: Codecast" }, undone: false };
  await mount(page("in-1"));
  const origin = q("[data-initiative-origin]")!;
  assert.ok(origin, "an initiative an accepted change made says so");
  assert.equal(origin.getAttribute("data-initiative-origin"), "op-8");
  assert.match(origin.textContent!, /^Proposed by the review on Sep 23$/);
  assert.equal(origin.querySelector("a")!.getAttribute("href"), "/org?proposal=op-8");
  env.origin = { ...env.origin, undone: true };
  await mount(page("in-1"));
  assert.match(q("[data-initiative-origin]")!.textContent!, /\(undone\)$/);
  env.origin = null;
  await mount(page("in-1"));
  assert.equal(q("[data-initiative-origin]"), null, "a goal set on the page says nothing here");

  await act(async () => root.unmount());
}

test("initiatives mount: the list, a role's page and its two tabs, a person's page, an update posted, the phone", async () => {
  await verifyInitiatives();
}, 600_000);
