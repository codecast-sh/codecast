// A project's page header (docs/architecture/initiatives-projects-role-page.md
// I5 "Where it shows"), mounted in jsdom over a fake store row. Proves: the
// page wears the shared intent header (title, id, status, lead, deadline,
// progress, what is filed, the goals it is part of, the tab strip in the
// URL); the header paints the STORE row, so a rename, a status pick and a
// deadline show in the same tick while the per view query still answers with
// the old row; the deadline is written on blur or Enter and never from a half
// typed year; the bar counts tasks by the board's rule, not the server's
// enriched counts; a `pj-` short id in the address opens the same page; and
// the phone header holds the title to two lines with the whole title as its
// tooltip.
// Run: bun test "app/projects/[id]/ProjectHeader.mount.test.tsx"
import { test } from "bun:test";
import assert from "node:assert/strict";
import { realInboxStore, restoreInboxStoreAfterAll } from "../../../components/__tests__/mockInboxStore";

restoreInboxStoreAfterAll();

async function verifyProjectHeader() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;
  const { writeAsServerShape } = await import("../../../store/serverShape");
  const { projectTaskCounts } = await import("@codecast/shared/tasks");

  // ── the world the page reads ──
  const NOW = Date.UTC(2026, 8, 18, 12);
  const WS = "team:fixture-team";
  const PID = "p7".repeat(16); // a Convex id, so the per view query is asked
  const endOfLocalDay = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59).getTime();
  const serverRow = {
    _id: PID, short_id: "pj-agentorg", title: "Agent org", status: "active", color: "violet", workspace: WS,
    description: "The org chart, roles and scopes.", project_path: "~/src/codecast", target_date: endOfLocalDay(2026, 11, 1),
    // The server's enrichment counts every readable task, dropped and agent filed ones too.
    task_counts: { total: 87, done: 12, in_progress: 0 }, plan_count: 1, doc_count: 1, created_at: 0, updated_at: 0,
  };
  const task = (id: string, status: string, over: Record<string, unknown> = {}) => ({ _id: id, short_id: `ct-${id}`, title: `Task ${id}`, status, project_id: PID, source: "human", workspace: WS, created_at: 0, updated_at: 0, ...over });
  const collections: Record<string, any[]> = {
    tasks: [task("1", "done"), task("2", "done"), task("3", "done"), task("4", "in_progress"), task("5", "open"), task("6", "backlog"), task("7", "dropped"), task("8", "open", { source: "agent" }), task("9", "open", { project_id: "another-project" })],
    plans: [{ _id: "plan-1", short_id: "pl-715", title: "Role page", status: "active", project_id: PID, workspace: WS, created_at: 0, updated_at: 0 }],
    docs: [{ _id: "doc-1", title: "Role page spec", doc_type: "spec", project_id: PID, workspace: WS, created_at: 0, updated_at: 0 }],
    initiatives: [{
      _id: "init-org", short_id: "in-1", title: "Agents run the company's routine work", status: "active", project_ids: [PID], health: "at_risk", workspace: WS, team_id: "fixture-team", user_id: "fixture-user-me", created_at: 0, updated_at: 0,
      metrics: [{ key: "weekly_active_teams", name: "Weekly active teams", target: "1,000" }],
      scoreboard: { weekly_active_teams: { value: "412", observed_at: NOW - 2 * 86_400_000, source: "https://example.com/board" } },
    }],
  };
  assert.deepEqual(projectTaskCounts(collections.tasks, [PID]), { total: 6, done: 3, in_progress: 1, open: 2 }, "the fixture: six rows on the project's board, three done");

  const env = { id: PID, phone: false, search: "", server: serverRow as Record<string, unknown> | undefined };
  const calls: string[] = [];
  const asked: unknown[] = [];
  const state: any = {
    currentUser: { _id: "fixture-user-me", name: "Ashot" },
    clientState: { ui: { active_team_id: "fixture-team" } },
    teams: [{ _id: "fixture-team", name: "Fixture" }, { _id: "home-team", name: "Codecast" }],
    projects: { [PID]: { ...serverRow } } as Record<string, any>,
    syncMeta: { 'tasks:v2:{"workspace":"team","team_id":"fixture-team"}': { backfilledAt: 1 } },
    // What the store's action does to the draft (store/inboxStore updateProject).
    updateProject: (id: string, fields: Record<string, unknown>) => {
      calls.push(`updateProject:${id}:${JSON.stringify(fields)}`);
      const row = { ...state.projects[id] };
      writeAsServerShape(row, fields);
      state.projects = { ...state.projects, [id]: row };
    },
  };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });
  mock.module("../../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));

  const noop = () => {};
  for (const h of ["useSyncProjects", "useSyncTasks", "useSyncPlans", "useSyncDocs"]) {
    const real = { ...(await import(`../../../hooks/${h}`)) };
    mock.module(`../../../hooks/${h}`, () => ({ ...real, [h]: noop }));
  }
  const realOrgTree = { ...(await import("../../../hooks/useSyncOrgTree")) };
  mock.module("../../../hooks/useSyncOrgTree", () => ({ ...realOrgTree, useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry: noop }) }));
  mock.module("../../../hooks/useSyncCollection", () => ({ useSyncCollection: () => ({ ready: true, refused: false, retry: noop }) }));
  mock.module("../../../hooks/useWorkspaceCollection", () => ({ useWorkspaceCollection: (key: string) => collections[key] ?? [] }));
  mock.module("../../../hooks/useCollectionRows", () => ({ useCollectionRows: (key: string, opts: any = {}) => (collections[key] ?? []).filter(opts.where ?? (() => true)).sort(opts.sort ?? (() => 0)) }));
  mock.module("../../../hooks/useWorkspaceArgs", () => ({ useWorkspaceArgs: () => ({ workspace: "team", team_id: "fixture-team" }), workspaceStamp: (a: any) => ({ workspace: a.workspace, team_id: a.team_id }) }));
  mock.module("../../../hooks/useIsPhone", () => ({ useIsPhone: () => env.phone, useMinWidth: () => !env.phone, PHONE_MAX_WIDTH: 768 }));
  const realNow = { ...(await import("../../../hooks/useCoarseNow")) };
  mock.module("../../../hooks/useCoarseNow", () => ({ ...realNow, useCoarseNow: () => NOW, useNowWhen: () => NOW }));
  // The per view query: asked only with a real id, and answering with whatever the server last said.
  mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: (_fn: unknown, args: unknown) => { if (args !== "skip") asked.push(args); return { data: args === "skip" ? undefined : env.server, error: undefined, retry: noop }; } }));
  mock.module("../../../hooks/useProjectLead", () => ({ useProjectLead: () => ({ project: null, roles: [], lead: null, otherWorkspace: false }) }));
  const realNav = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({
    ...realNav,
    useParams: () => ({ id: env.id }),
    useRouter: () => ({ replace: (u: string) => { calls.push(`replace:${u}`); env.search = u.split("?")[1] ?? ""; }, push: (u: string) => calls.push(`push:${u}`) }),
    useSearchParams: () => new URLSearchParams(env.search),
    usePathname: () => `/projects/${env.id}`,
  }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  mock.module("sonner", () => ({ toast: Object.assign((m: string) => calls.push(`toast:${m}`), { success: (m: string) => calls.push(`toast:${m}`), error: (m: string) => calls.push(`toast-error:${m}`) }) }));

  // Other surfaces' drawing: each says only that it is there.
  const mark = (name: string) => (props: any) => React.createElement("div", { [`data-${name}`]: props?.projectId ?? "" });
  const through = ({ children }: any) => children;
  mock.module("../../tasks/page", () => ({ TaskListContent: mark("task-list") }));
  mock.module("../../tasks/[id]/page", () => ({ TaskDetailContent: () => null }));
  mock.module("../../../components/DetailSplitLayout", () => ({ DetailSplitLayout: ({ list }: any) => list }));
  mock.module("../../../components/AuthGuard", () => ({ AuthGuard: through }));
  mock.module("../../../components/DashboardLayout", () => ({ DashboardLayout: through }));
  mock.module("../../../components/repo/RepositoryLinks", () => ({ RepositoryLinks: mark("repository-links") }));
  mock.module("../../../components/ShareControl", () => ({ ShareControl: (props: any) => React.createElement("span", { "data-share": props.path, "data-share-token": props.publicShare?.token ?? "" }) }));
  mock.module("../../../components/ProjectUpdates", () => ({ ProjectUpdates: mark("project-updates") }));
  mock.module("../../../components/ProjectTimeline", () => ({ ProjectTimeline: mark("project-timeline") }));
  mock.module("../../../components/ProgressChart", () => ({ ProgressChart: () => null }));
  mock.module("../../../components/BurndownChart", () => ({ BurndownChart: () => null }));
  mock.module("../../../components/DocDates", () => ({ DocDates: () => null }));
  mock.module("../../../components/line/ProjectLineTab", () => ({ ProjectLineTab: mark("project-line") }));
  mock.module("../../../components/charter/CharterBlock", () => ({ CharterBlock: (props: any) => React.createElement("div", { "data-charter": props.title, "data-charter-goal": props.charter?.goal ?? "" }) }));
  mock.module("../../../components/charter/ProjectLeadChip", () => ({ ProjectLeadChip: ({ projectId }: any) => React.createElement("span", { "data-project-lead-chip": projectId }) }));
  const realScopeEditors = { ...(await import("../../../components/org/scope/ScopeEditors")) };
  mock.module("../../../components/org/scope/ScopeEditors", () => ({ ...realScopeEditors, InlineEdit: ({ value, placeholder, ariaLabel }: any) => React.createElement("span", { "data-inline-edit": ariaLabel }, value || placeholder) }));
  mock.module("../../../components/EntityIdPill", () => ({ EntityIdPill: ({ id, type }: any) => React.createElement("span", { "data-pill": `${type}:${id}` }, id) }));
  // A popover that is simply open: the list inside is what the test reads.
  mock.module("../../../components/ui/popover", () => ({ Popover: through, PopoverTrigger: through, PopoverAnchor: through, PopoverContent: ({ children }: any) => React.createElement("div", { "data-popover": true }, children) }));

  const { createRoot } = await import("react-dom/client");
  const { default: ProjectDetailPage } = await import("./page");
  let root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const click = async (el: Element | null) => { assert.ok(el, "missing element"); await act(async () => { (el as HTMLElement).click(); }); };
  const type = async (el: Element | null, value: string) => {
    assert.ok(el, "missing field");
    await act(async () => { Object.getOwnPropertyDescriptor((dom.window as any).HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true })); });
  };
  const key = (el: Element | null, k: string) => act(async () => { el!.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: k, bubbles: true })); });
  const blur = (el: Element | null) => act(async () => { el!.dispatchEvent(new (dom.window as any).FocusEvent("focusout", { bubbles: true })); });
  const page = () => React.createElement(ProjectDetailPage);
  const mount = async () => { await act(async () => root.unmount()); root = createRoot(document.getElementById("root")!); await act(async () => root.render(page())); };
  // The fake store does not notify: a render reads what the action wrote.
  const repaint = () => act(async () => root.render(page()));
  const updates = (field: string) => calls.filter((c) => c.startsWith("updateProject:") && c.includes(`"${field}"`));

  // ── the header a goal's page wears, on the project ──
  await mount();
  assert.equal(q("[data-project-page]")!.getAttribute("data-project-page"), PID);
  const header = q("[data-intent-header]")!;
  assert.ok(header, "the shared intent header");
  assert.ok(q("[data-intent-stripe]"), "under the project's colour stripe");
  assert.equal(header.querySelector("a[aria-label='Back to projects']")!.getAttribute("href"), "/projects");
  assert.equal(q("[data-project-title]")!.textContent, "Agent org");
  assert.equal(q("[data-project-title]")!.tagName, "H1");
  assert.doesNotMatch(q("[data-project-title]")!.className, /line-clamp|truncate/, "the page's own title reads whole");
  assert.match(header.textContent!, /pj-agentorg/, "its id beside the title");
  assert.equal(q("[data-share]")!.getAttribute("data-share"), `/projects/${PID}`);
  // Line two, in a goal's order: status, lead, deadline, progress, what is filed, the goals it is part of.
  const chips = q("[data-intent-chips]")!;
  assert.match(chips.querySelector("[data-project-pick='status']")!.textContent!, /Active/);
  assert.ok(chips.querySelector(`[data-project-lead-chip='${PID}']`), "who leads it");
  const deadline = () => q<HTMLElement>("button[data-project-pick='target']");
  assert.equal(deadline()!.getAttribute("data-intent-target"), "2026-11-01", "the deadline, as the day the viewer's calendar says");
  assert.equal(deadline()!.querySelector("[data-initiative-target]")!.getAttribute("data-initiative-target"), "ahead");
  // Tasks by the board's rule (shared/tasks projectTaskCounts): 3 of 6, never the server's 12 of 87.
  assert.equal(chips.querySelector("[data-initiative-progress]")!.getAttribute("data-initiative-progress"), "3/6");
  assert.deepEqual(qa("[data-project-counts] [data-project-count]").map((c) => `${c.getAttribute("data-project-count")}:${c.textContent!.trim()}`), ["plans:1", "docs:1"], "plans and docs; the bar already says the tasks");
  assert.doesNotMatch(chips.textContent!, /87/, "no second task total beside the bar");
  const partOf = chips.querySelector(`[data-project-initiatives='${PID}']`)!;
  assert.match(partOf.textContent!, /^Part of/);
  assert.ok(partOf.querySelector("[data-pill='initiative:in-1']"), "the goal it carries");
  assert.match(partOf.querySelector("[data-metric='weekly_active_teams'][data-metric-size='chip']")!.textContent!, /412/, "with the goal's first number");
  // Under the chips: what the project is, its folder, its repositories, its charter.
  assert.match(header.textContent!, /The org chart, roles and scopes\./);
  assert.equal(q("[data-inline-edit='Project folder']")!.textContent, "~/src/codecast");
  assert.ok(header.querySelector(`[data-repository-links='${PID}']`));
  assert.equal(header.querySelector("[data-charter]")!.getAttribute("data-charter"), "Agent org");

  // ── the tab strip, in the scope panel's grammar, kept in the URL ──
  assert.deepEqual(qa("[data-intent-header] [data-scope-tab]").map((t) => t.getAttribute("data-scope-tab")), ["tasks", "overview", "updates", "timeline", "line"]);
  assert.equal(q("[data-project-page]")!.getAttribute("data-scope-tab-active"), "tasks");
  assert.equal(q("[data-scope-tab='tasks']")!.getAttribute("aria-current"), "page");
  assert.ok(q(`[data-task-list='${PID}']`), "it opens on the project's tasks");
  await click(q("[data-scope-tab='updates']"));
  assert.equal(calls.at(-1), `replace:/projects/${PID}?tab=updates`);
  await repaint();
  assert.equal(q("[data-project-page]")!.getAttribute("data-scope-tab-active"), "updates");
  assert.ok(q(`[data-project-updates='${PID}']`));
  assert.equal(q("[data-task-list]"), null);
  await click(q("[data-scope-tab='tasks']"));
  assert.equal(calls.at(-1), `replace:/projects/${PID}`, "the first tab is the bare address");
  await repaint();

  // ── local first: the header paints the store row, while the query still answers the old one ──
  await click(q("[data-project-title]"));
  await type(q("input[aria-label='Project title']"), "Agent organisation");
  await key(q("input[aria-label='Project title']"), "Enter");
  assert.deepEqual(updates("title"), [`updateProject:${PID}:${JSON.stringify({ title: "Agent organisation" })}`]);
  await repaint();
  assert.equal(env.server!.title, "Agent org", "the server has not answered yet");
  assert.equal(q("[data-project-title]")!.textContent, "Agent organisation", "the rename shows in the same tick");
  assert.equal(q("[data-charter]")!.getAttribute("data-charter"), "Agent organisation", "everywhere the header names it");
  await click(qa("[data-project-pick='status'] ~ [data-popover] button, [data-popover] button").find((b) => b.textContent?.trim() === "Done") ?? null);
  assert.deepEqual(updates("status"), [`updateProject:${PID}:${JSON.stringify({ status: "done" })}`]);
  assert.ok(calls.includes("toast:Project marked as done"));
  await repaint();
  assert.equal(env.server!.status, "active");
  assert.match(q("[data-project-pick='status']")!.textContent!, /Done/, "the status pick shows before the toast fades");

  // ── the deadline: the header's one target day control ──
  const field = () => q<HTMLInputElement>("[data-project-pick='target'] input[type='date']");
  await click(deadline());
  assert.equal(field()!.value, "2026-11-01", "the field opens on the day it holds");
  await type(field(), "0002-11-01");
  assert.deepEqual(updates("target_date"), [], "a keystroke writes nothing");
  await blur(field());
  assert.deepEqual(updates("target_date"), [], "and a half typed year is not a day to store");
  assert.equal(field(), null);
  await click(deadline());
  await type(field(), "2026-12-24");
  await blur(field());
  assert.deepEqual(updates("target_date"), [`updateProject:${PID}:${JSON.stringify({ target_date: endOfLocalDay(2026, 12, 24) })}`], "blur writes the day, as the end of the viewer's own day");
  await repaint();
  assert.equal(deadline()!.getAttribute("data-intent-target"), "2026-12-24", "and the chip shows it while the query still says Nov 1");
  await click(deadline());
  await blur(field());
  assert.equal(updates("target_date").length, 1, "a blur on the same day writes nothing");
  await click(deadline());
  await click(q("[data-project-pick='target'] [data-intent-target-clear]"));
  assert.equal(updates("target_date").at(-1), `updateProject:${PID}:${JSON.stringify({ target_date: null })}`, "Clear is the one way to remove it");
  await repaint();
  assert.equal(env.server!.target_date, endOfLocalDay(2026, 11, 1));
  assert.equal(deadline()!.getAttribute("data-intent-target"), "", "cleared in the store wins over the day the query still holds");
  assert.match(deadline()!.textContent!, /No deadline/);

  // The query was only ever asked with the project's real id.
  assert.ok(asked.length > 0);
  assert.deepEqual([...new Set(asked.map((a) => JSON.stringify(a)))], [JSON.stringify({ id: PID })]);

  // ── a `pj-` short id in the address (a role's or a goal's project card links so) opens the same page ──
  asked.length = 0;
  env.id = "pj-agentorg";
  await mount();
  assert.equal(q("[data-project-page]")!.getAttribute("data-project-page"), PID);
  assert.equal(q("[data-project-title]")!.textContent, "Agent organisation");
  assert.equal(q(`[data-task-list]`)!.getAttribute("data-task-list"), PID, "the task list is asked for by the real id");
  assert.deepEqual([...new Set(asked.map((a) => JSON.stringify(a)))], [JSON.stringify({ id: PID })], "and so is the query, never by the short id");
  // A short id the store does not hold yet asks the server nothing and waits for the feeder.
  asked.length = 0;
  env.id = "pj-unknown";
  await mount();
  assert.match(document.body.textContent!, /Loading project/);
  assert.deepEqual(asked, []);
  env.id = PID;

  // ── the phone header: two lines at most, the whole title as its tooltip ──
  env.phone = true;
  await mount();
  assert.match(q("[data-project-title]")!.className, /line-clamp-2/);
  assert.equal(q("[data-project-title]")!.getAttribute("title"), "Agent organisation");
  env.phone = false;

  // ── a project from another workspace says where it lives, never an empty list that is not true ──
  const home = "team:home-team";
  state.projects = { ...state.projects, [PID]: { ...state.projects[PID], workspace: home } };
  env.search = "";
  await mount();
  assert.match(q("[data-foreign-workspace]")!.textContent!, /This project lives in Codecast\. Switch to see its tasks\./);
  assert.equal(q("[data-initiative-progress]"), null, "no task count read from the wrong workspace");
  assert.equal(q("[data-task-list]"), null);
  assert.equal(q("[data-project-line]"), null);
  // Its Line tab reads where the project lives, so it shows from here, under a note naming that workspace.
  env.search = "tab=line";
  await mount();
  assert.match(q("[data-foreign-workspace]")!.textContent!, /This project lives in Codecast\. You are reading its line from here; switch to work in it\./);
  assert.ok(q("[data-project-line]"), "the Line tab renders from another workspace");
  assert.equal(q("[data-task-list]"), null);
  env.search = "";

  await act(async () => root.unmount());
}

test("project page header: the shared intent header, painted from the store row, with the one target day control", async () => {
  await verifyProjectHeader();
}, 600_000);
