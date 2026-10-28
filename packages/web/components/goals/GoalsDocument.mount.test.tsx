// The Goals document mounted in jsdom against the Union shaped fixture.
// Proves: every goal reads as a section with its words in full; a title is
// edited where it reads and Escape puts it back; Enter starts the next goal
// and a named draft becomes a goal right after the one it followed; Tab
// nests a goal under the one above and Shift+Tab lifts it out, never past the
// one level of nesting; Cmd+Shift+Down moves it among its siblings by
// position; why it matters is written in place; and a project dragged onto
// another goal's list leaves the first goal for the second. Numbers read
// live: a goal's metric that names a series shows the series' latest value,
// and a project is given a live number from the editor under its line.
// Run: bun test components/goals/GoalsDocument.mount.test.tsx
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";
import type { OrgTree } from "../org/orgTypes";

async function verifyGoals() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/goals", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  const fx = await import("../company/companyFixture");
  const { UNION_GOALS_UPDATES } = await import("../org/goalsFixture");
  const tree = fx.COMPANY_FIXTURE_TREE as OrgTree;
  const calls: string[] = [];
  const NOW = fx.COMPANY_FIXTURE_NOW;
  const series = { _id: "w1", short_id: "mw-7", workspace: `team:${tree.workspace.id}`, name: "Brokers sending deals", unit: "brokers", query_kind: "reader", query: "metrics.read", direction: "below", interval_ms: 3600_000, status: "active", state: "ok", points: [{ at: NOW - 6 * 86_400_000, value: 9 }, { at: NOW - 3600_000, value: 14 }], last_value: 14, last_at: NOW - 3600_000, source_name: "union", source_short_id: "src-13", source_id: "s", updated_at: NOW };
  // in-2's first number reads live from mw-7.
  const initiatives = fx.COMPANY_FIXTURE_INITIATIVES.map((g) => ({ ...g, ...(g.short_id === "in-2" && g.metrics?.length ? { metrics: g.metrics.map((m, i) => (i === 0 ? { ...m, series: "mw-7" } : m)) } : {}) }));
  const collections: Record<string, any[]> = { initiatives, projects: fx.COMPANY_FIXTURE_PROJECTS.map((p) => ({ ...p })), tasks: fx.COMPANY_FIXTURE_TASKS, initiativeUpdates: UNION_GOALS_UPDATES, opsWatches: [series] };
  const TEAM = tree.workspace.id;
  const patch = (id: string, fn: (r: any) => any) => { collections.initiatives = collections.initiatives.map((r) => (r._id === id ? fn(r) : r)); };
  const state: any = {
    currentUser: { _id: "fixture-user-me", name: "Ashot Petrosian" },
    clientState: { ui: { active_team_id: TEAM } as Record<string, any> },
    teams: [{ _id: TEAM, name: "Union" }],
    teamMembers: fx.COMPANY_FIXTURE_ROSTER,
    orgTree: tree,
    orgProposals: {},
    orgProposalChanges: {},
    sessions: {},
    get initiatives() { return Object.fromEntries(collections.initiatives.map((r) => [r._id, r])); },
    get projects() { return Object.fromEntries(collections.projects.map((r) => [r._id, r])); },
    updateProject: (id: string, fields: any) => { calls.push(`project:${id}:${JSON.stringify(fields)}`); collections.projects = collections.projects.map((r) => (r._id === id ? { ...r, ...fields } : r)); },
    // The stand-ins write the row the way the store's actions do, so the page reads it back in the same tick.
    updateInitiative: (id: string, fields: any) => { calls.push(`update:${id}:${JSON.stringify(fields)}`); patch(id, (r) => ({ ...r, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v ?? undefined])) })); },
    createInitiative: (input: any) => { calls.push(`create:${JSON.stringify(input)}`); collections.initiatives = [...collections.initiatives, { _id: input.client_key, short_id: "", client_key: input.client_key, status: "active", project_ids: [], health: "none", workspace: `team:${TEAM}`, team_id: TEAM, user_id: "fixture-user-me", created_at: 9e15, updated_at: 9e15, ...input }]; },
    setInitiativeProjects: (id: string, ids: string[]) => { calls.push(`projects:${id}:${ids.join(",")}`); patch(id, (r) => ({ ...r, project_ids: ids })); },
    addInitiativeProject: (id: string, p: string) => { calls.push(`add:${id}:${p}`); patch(id, (r) => ({ ...r, project_ids: [...r.project_ids, p] })); },
    removeInitiativeProject: (id: string, p: string) => { calls.push(`remove:${id}:${p}`); patch(id, (r) => ({ ...r, project_ids: r.project_ids.filter((x: string) => x !== p) })); },
  };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });

  mock.module("../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  const realUndo = { ...(await import("../../store/undoActions")) };
  mock.module("../../store/undoActions", () => ({ ...realUndo, undoAsOne: (label: string, fn: () => unknown) => { calls.push(`undo:${label}`); return fn(); } }));
  const realOrgTree = { ...(await import("../../hooks/useSyncOrgTree")) };
  mock.module("../../hooks/useSyncOrgTree", () => ({ ...realOrgTree, useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry: () => {} }) }));
  const realProjects = { ...(await import("../../hooks/useSyncProjects")) };
  mock.module("../../hooks/useSyncProjects", () => ({ ...realProjects, useSyncProjects: () => {} }));
  const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
  mock.module("../../hooks/useSyncOrgProposals", () => ({ ...realProposals, useSyncOrgProposals: () => ({ ready: true, missing: false }), useSyncOrgProposal: () => ({ ready: true, missing: false }) }));
  mock.module("../../hooks/useSyncCollection", () => ({ useSyncCollection: () => ({ ready: true, refused: false, retry: () => {} }) }));
  mock.module("../../hooks/useCollectionRows", () => ({ useCollectionRows: (key: string, opts: any = {}) => (collections[key] ?? []).filter(opts.where ?? (() => true)).sort(opts.sort ?? (() => 0)) }));
  const realWorkspace = { ...(await import("../../hooks/useWorkspaceCollection")) };
  mock.module("../../hooks/useWorkspaceCollection", () => ({ ...realWorkspace, useWorkspaceCollection: (key: string) => collections[key] ?? [] }));
  const realWorkspaceArgs = { ...(await import("../../hooks/useWorkspaceArgs")) };
  mock.module("../../hooks/useWorkspaceArgs", () => ({ ...realWorkspaceArgs, useWorkspaceArgs: () => ({ workspace: "team", team_id: TEAM }) }));
  const realInitiatives = { ...(await import("../../hooks/useInitiatives")) };
  mock.module("../../hooks/useInitiatives", () => ({ ...realInitiatives, useInitiatives: () => collections.initiatives, useTasksBackfilled: () => true, useSyncInitiativeUpdates: () => {} }));
  const realNow = { ...(await import("../../hooks/useCoarseNow")) };
  mock.module("../../hooks/useCoarseNow", () => ({ ...realNow, useCoarseNow: () => fx.COMPANY_FIXTURE_NOW, useNowWhen: () => fx.COMPANY_FIXTURE_NOW }));
  const realOrgRoles = { ...(await import("../../hooks/useOrgRoles")) };
  mock.module("../../hooks/useOrgRoles", () => ({ ...realOrgRoles, useOrgRoles: () => ({ roles: tree.roles, workspace: tree.workspace, roleBotUserIds: new Set<string>() }) }));
  const realRoster = await import("../../hooks/useTeamRoster");
  mock.module("../../hooks/useTeamRoster", () => ({ ...realRoster, useTeamRosterIdentity: () => fx.COMPANY_FIXTURE_ROSTER }));
  const realNav = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ replace: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams(""), usePathname: () => "/goals" }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const realLeadChip = { ...(await import("../charter/ProjectLeadChip")) };
  mock.module("../charter/ProjectLeadChip", () => ({ ...realLeadChip, ProjectLeadChip: ({ projectId }: any) => React.createElement("span", { "data-project-lead-chip": projectId }) }));
  const realRoleFace = { ...(await import("../org/RoleFace")) };
  mock.module("../org/RoleFace", () => ({ ...realRoleFace, RoleFace: ({ role }: any) => React.createElement("span", { "data-role-face": role.handle }) }));

  const { createRoot } = await import("react-dom/client");
  const { GoalsDocument } = await import("./GoalsDocument");
  const root = createRoot(document.getElementById("root")!);
  const render = async () => { await act(async () => root.render(React.createElement(GoalsDocument))); };
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const W = dom.window as any;
  const key = async (el: Element | null, k: string, opts: Record<string, boolean> = {}) => { assert.ok(el, `no element for ${k}`); await act(async () => { el!.dispatchEvent(new W.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts })); }); await render(); };
  const type = async (el: HTMLTextAreaElement, text: string) => { await act(async () => { el.focus(); el.value = text; el.dispatchEvent(new W.Event("input", { bubbles: true })); }); };
  const blur = async (el: HTMLElement) => { await act(async () => { el.blur(); }); await render(); };
  const top = () => qa("[data-goals-list='top'] > div > [data-goal-section]").map((s) => s.getAttribute("data-goal-section"));
  const title = (ref: string) => q<HTMLTextAreaElement>(`[data-goal-title='${ref}']`)!;
  const since = (n: number) => calls.slice(n);

  await render();
  assert.deepEqual(top(), ["in-2", "in-4", "in-1"], "the top goals in list order, each a section");
  assert.ok(q("[data-goal-section='in-2'] [data-goal-section='in-5']"), "a goal under another reads inside its section");
  assert.match(q("[data-goal-section='in-2'] [data-goal-why]")!.textContent!, /Brokers place the deals/, "why it matters, in full");
  assert.ok(q("[data-goal-section='in-2'] [data-goal-numbers] [data-metric='brokers']"), "its numbers against their targets");
  assert.ok(q("[data-goal-section='in-2'] [data-initiative-update='union-upd-1']"), "the latest update in full");
  assert.deepEqual(qa("[data-goal-projects='in-2'] > div > [data-goal-project]").map((p) => p.dataset.goalProject), ["union-proj-network", "union-proj-outreach"], "every project it carries, in the owner's order");

  // A title edited where it reads; Escape puts it back.
  let n = calls.length;
  const t2 = title("in-2");
  await type(t2, "Win the private broker network");
  await blur(t2);
  assert.deepEqual(since(n), [`update:union-in-2:${JSON.stringify({ title: "Win the private broker network" })}`]);
  await type(t2, "scrap this");
  await key(t2, "Escape");
  assert.equal(t2.value, "Win the private broker network", "Escape puts the title back");

  // Enter starts the next goal right after it; a named draft becomes that goal.
  n = calls.length;
  await key(title("in-4"), "Enter");
  const draft = q<HTMLTextAreaElement>("[data-goal-draft] textarea")!;
  assert.ok(draft, "Enter opens a new goal's heading");
  assert.equal(draft.closest("[data-goals-list]")!.getAttribute("data-goals-list"), "top");
  await type(draft, "Close the first paid deal");
  await key(draft, "Enter");
  const created = since(n).find((c) => c.startsWith("create:"));
  assert.ok(created, "the draft is created");
  const input = JSON.parse(created!.slice(7));
  assert.equal(input.title, "Close the first paid deal");
  assert.equal(input.workspace, "team");
  assert.deepEqual(input.owner, { kind: "user", user_id: "fixture-user-me" });
  assert.equal(top().indexOf(input.client_key), top().indexOf("in-4") + 1, "it lands right after the goal it followed");
  assert.ok(q("[data-goal-draft] textarea"), "and the next one starts after it");
  await key(q("[data-goal-draft] textarea"), "Escape");
  assert.equal(q("[data-goal-draft]"), null, "Escape on an empty draft drops it");

  // Tab nests under the goal above; Shift+Tab lifts it out, after its parent.
  n = calls.length;
  await key(title("in-4"), "Tab");
  assert.ok(since(n).includes(`update:union-in-4:${JSON.stringify({ parent_initiative_id: "union-in-2" })}`), "Tab puts it under the goal above");
  assert.ok(q("[data-goal-section='in-2'] [data-goal-section='in-4']"));
  n = calls.length;
  await key(title("in-5"), "Tab");
  assert.equal(since(n).filter((c) => c.includes("parent_initiative_id")).length, 0, "never deeper than one level");
  await key(title("in-4"), "Tab", { shiftKey: true });
  assert.equal(top().indexOf("in-4"), top().indexOf("in-2") + 1, "Shift+Tab lifts it out to right after its parent");
  await key(title("in-2"), "Tab");
  assert.ok(!collections.initiatives.find((r) => r._id === "union-in-2").parent_initiative_id, "a goal with goals under it stays at the top");

  // Cmd+Shift+Down moves it among its siblings.
  const before = top();
  await key(title("in-2"), "ArrowDown", { metaKey: true, shiftKey: true });
  assert.deepEqual(top(), [before[1], before[0], ...before.slice(2)], "moved one down");
  await key(title("in-2"), "ArrowUp", { metaKey: true, shiftKey: true });
  assert.deepEqual(top(), before, "and back");

  // Why it matters, written in place.
  n = calls.length;
  await act(async () => { q("[data-goal-section='in-1'] [data-goal-why]")!.dispatchEvent(new W.MouseEvent("click", { bubbles: true })); });
  const why = q<HTMLTextAreaElement>("[data-goal-section='in-1'] textarea[data-goal-why]")!;
  assert.ok(why, "a click opens the words for writing");
  await type(why, "Nobody can run what nobody owns.");
  await blur(why);
  assert.deepEqual(since(n), [`update:union-in-1:${JSON.stringify({ why: "Nobody can run what nobody owns." })}`]);

  // A project dragged onto another goal's list moves there.
  const dt = () => ({ effectAllowed: "", dropEffect: "", setData() {}, getData: () => "" });
  const drag = async (el: Element, type: string, data: any) => { await act(async () => { const e = new W.Event(type, { bubbles: true, cancelable: true }); e.dataTransfer = data; el.dispatchEvent(e); }); };
  const data = dt();
  n = calls.length;
  await drag(q("[data-goal-project='union-proj-quality'] [data-project-handle]")!, "dragstart", data);
  const tail = q("[data-goal-projects='in-2'] [data-project-drop-tail]") ?? q("[data-goal-section='in-2'] [data-project-drop-tail]");
  assert.ok(tail, "while a project is held, every goal offers a place for it");
  await drag(tail!, "dragover", data);
  await drag(tail!, "drop", data);
  await render();
  assert.ok(since(n).includes("remove:union-in-1:union-proj-quality") && since(n).includes("add:union-in-2:union-proj-quality"), "it leaves the first goal for the second, as one undo");
  assert.ok(since(n).some((c) => c.startsWith("undo:Moved")));

  // A goal's number that names a series reads the series' latest point, marked live.
  const live = q("[data-goal-section='in-2'] [data-goal-numbers] [data-metric-live='mw-7']");
  assert.ok(live, "the live number is marked as live");
  assert.match(live!.closest("[data-metric]")!.textContent!, /14 brokers/, "and reads the series' latest value in its unit");

  // A project is given a number from the editor under its line, read from a series.
  n = calls.length;
  const give = q<HTMLButtonElement>("[data-goal-project='union-proj-network'] [data-project-add-number]")!;
  assert.ok(give, "a project with no number offers to take one");
  await act(async () => give.click());
  await render();
  const form = q("[data-project-numbers-form='union-proj-network']")!;
  assert.ok(form, "the editor opens under the project");
  const pick = form.querySelector<HTMLSelectElement>("[data-metric-series-pick]")!;
  await act(async () => { pick.value = "mw-7"; pick.dispatchEvent(new W.Event("change", { bubbles: true })); });
  const target = form.querySelector<HTMLInputElement>("input[aria-label='Target']")!;
  await act(async () => { const set = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!; set.call(target, "40"); target.dispatchEvent(new W.Event("input", { bubbles: true })); });
  await act(async () => [...form.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click());
  await render();
  assert.deepEqual(since(n), [`project:union-proj-network:${JSON.stringify({ metrics: [{ key: "brokers_sending_deals", name: "Brokers sending deals", target: "40", series: "mw-7" }] })}`], "picking a series names the number after it, and Save writes the project");
  assert.ok(q("[data-project-numbers='union-proj-network'] [data-metric-live='mw-7']"), "the project's number then reads live under its line");

  await act(async () => root.unmount());
}

test("the Goals document: words and the tree edited in place", verifyGoals, 60_000);
