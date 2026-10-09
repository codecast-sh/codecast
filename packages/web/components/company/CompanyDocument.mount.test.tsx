// The Org screen's Read lens (cohesive build spec §4.3, WP4), mounted in
// jsdom against the Union shaped fixture. Proves: the name and one state
// line, then Goals, Projects not under a goal and People and roles, every row
// one of the four lines on the one grid; a goal line's metric with its trend
// and no task bar; the document opening on its most pressing goal, a line
// opened in place (why, latest update, its project and goal lines one level
// in) and that choice written to the person's own synced UI state, read back
// by a second window; an owner or status picked on a line painting in the
// same tick; the title opening the object (a sheet in the screen, its address
// elsewhere) and Enter doing the same; the Goals, Projects and People filters
// keeping every line on the same cells; and an open proposal's goals,
// projects and roles in violet, each saying where it is answered, lighting
// its card on hover, with nothing to approve here.
// Run: bun test components/company/CompanyDocument.mount.test.tsx
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";
import type { OrgTree } from "../org/orgTypes";

async function verifyCompany() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  // ── the world the document reads ──
  const fx = await import("./companyFixture");
  const { UNION_GOALS_UPDATES } = await import("../org/goalsFixture");
  const env = { counted: true, tree: fx.COMPANY_FIXTURE_TREE as OrgTree | null };
  const calls: string[] = [];
  const collections: Record<string, any[]> = { initiatives: fx.COMPANY_FIXTURE_INITIATIVES.map((g) => ({ ...g })), projects: fx.COMPANY_FIXTURE_PROJECTS, tasks: fx.COMPANY_FIXTURE_TASKS, initiativeUpdates: UNION_GOALS_UPDATES };
  const TEAM = fx.COMPANY_FIXTURE_TREE.workspace.id;
  const state: any = {
    currentUser: { _id: "fixture-user-me", name: "Ashot Petrosian" },
    clientState: { ui: { active_team_id: TEAM } as Record<string, any> },
    teams: [{ _id: TEAM, name: "Union" }],
    teamMembers: fx.COMPANY_FIXTURE_ROSTER,
    get orgTree() { return env.tree; },
    orgProposals: {} as Record<string, any>,
    orgProposalChanges: {} as Record<string, any>,
    currentSessionId: null,
    sessions: {},
    reviewComments: {} as Record<string, any[]>,
    // The stand-ins do what the store's actions do to the draft: the line
    // reads the row back in the same tick (store/initiativeSlice.ts and
    // updateClientUI are proven on the real store in their own tests).
    updateInitiative: (id: string, fields: any) => { calls.push(`update:${id}:${JSON.stringify(fields)}`); collections.initiatives = collections.initiatives.map((r) => (r._id === id ? { ...r, ...fields } : r)); },
    updateClientUI: (partial: Record<string, any>) => { calls.push(`ui:${JSON.stringify(partial)}`); state.clientState = { ...state.clientState, ui: { ...state.clientState.ui, ...partial } }; },
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
  mock.module("../../hooks/useSyncCollection", () => ({ useSyncCollection: (key: string, _q: unknown, args: any) => { calls.push(`feed:${key}:${args?.initiative_id ?? ""}`); return { ready: true, refused: false, retry: () => {} }; } }));
  mock.module("../../hooks/useCollectionRows", () => ({ useCollectionRows: (key: string, opts: any = {}) => (collections[key] ?? []).filter(opts.where ?? (() => true)).sort(opts.sort ?? (() => 0)) }));
  const realWorkspace = { ...(await import("../../hooks/useWorkspaceCollection")) };
  mock.module("../../hooks/useWorkspaceCollection", () => ({ ...realWorkspace, useWorkspaceCollection: (key: string) => collections[key] ?? [] }));
  const realInitiatives = { ...(await import("../../hooks/useInitiatives")) };
  mock.module("../../hooks/useInitiatives", () => ({ ...realInitiatives, useInitiatives: () => collections.initiatives, useTasksBackfilled: () => env.counted }));
  const realNow = { ...(await import("../../hooks/useCoarseNow")) };
  mock.module("../../hooks/useCoarseNow", () => ({ ...realNow, useCoarseNow: () => fx.COMPANY_FIXTURE_NOW, useNowWhen: () => fx.COMPANY_FIXTURE_NOW }));
  const realOrgRoles = { ...(await import("../../hooks/useOrgRoles")) };
  mock.module("../../hooks/useOrgRoles", () => ({ ...realOrgRoles, useOrgRoles: () => ({ roles: env.tree?.roles ?? [], workspace: env.tree?.workspace ?? null, roleBotUserIds: new Set<string>() }) }));
  const realRoster = await import("../../hooks/useTeamRoster");
  mock.module("../../hooks/useTeamRoster", () => ({ ...realRoster, useTeamRosterIdentity: () => fx.COMPANY_FIXTURE_ROSTER }));
  const realNav = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ replace: (u: string) => calls.push(`replace:${u}`), push: (u: string) => calls.push(`push:${u}`) }), useSearchParams: () => new URLSearchParams(""), usePathname: () => "/org" }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const realLeadChip = { ...(await import("../charter/ProjectLeadChip")) };
  mock.module("../charter/ProjectLeadChip", () => ({ ...realLeadChip, ProjectLeadChip: ({ projectId, size, editable }: any) => React.createElement("span", { "data-project-lead-chip": projectId, "data-size": size, "data-editable": editable ? "1" : "0" }) }));
  const realRoleFace = { ...(await import("../org/RoleFace")) };
  mock.module("../org/RoleFace", () => ({ ...realRoleFace, RoleFace: ({ role }: any) => React.createElement("span", { "data-role-face": role.handle }) }));
  const realAssignee = { ...(await import("../identity/AssigneeFace")) };
  mock.module("../identity/AssigneeFace", () => ({ ...realAssignee, AssigneeFace: ({ info }: any) => React.createElement("span", { "data-face": info.kind === "role" ? `role:${info.handle}` : `person:${info.name}` }) }));
  // A popover that is simply open: the picker's list is what the test reads.
  const realPopover = { ...(await import("../ui/popover")) };
  mock.module("../ui/popover", () => ({ ...realPopover, Popover: ({ children }: any) => children, PopoverTrigger: ({ children }: any) => children, PopoverAnchor: ({ children }: any) => children, PopoverContent: ({ children }: any) => React.createElement("div", { "data-popover": true }, children) }));

  const { createRoot } = await import("react-dom/client");
  const { CompanyDocument } = await import("./CompanyDocument");
  const { useChangeLit } = await import("../org/lines/changeLight");
  let root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const lit: Record<string, boolean> = {};
  /** What a card in the conversation would read: is one of its changes lit. */
  const Card = ({ id }: { id: string }) => { lit[id] = useChangeLit([id]); return null; };
  const mount = async (props: Record<string, any> = {}) => {
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    const doc = React.createElement(React.Fragment, null, React.createElement(CompanyDocument, props), React.createElement(Card, { id: "union-purpose" }), React.createElement(Card, { id: "union-staff-outreach" }));
    await act(async () => root.render(doc));
  };
  const rerender = async () => { await act(async () => {}); await mount(lastProps); };
  let lastProps: Record<string, any> = {};
  const show = async (props: Record<string, any> = {}) => { lastProps = props; await mount(props); };
  const click = async (el: Element | null | undefined, msg = "missing element") => { assert.ok(el, msg); await act(async () => { (el as HTMLElement).dispatchEvent(new (dom.window as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); }); };
  const key = async (el: Element | null, k: string) => { assert.ok(el); await act(async () => { el!.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); };
  const hover = async (el: Element | null, on: boolean) => { assert.ok(el); await act(async () => { el!.dispatchEvent(new (dom.window as any).MouseEvent(on ? "mouseover" : "mouseout", { bubbles: true, relatedTarget: on ? document.body : document.body })); }); };
  const none = (el: Element | null | undefined, msg: string) => assert.equal(el == null, true, msg);
  const sections = () => qa("[data-company-section]").map((s) => s.getAttribute("data-company-section"));
  const line = (id: string) => q(`[data-line-id='${id}']`);
  /** A line's cells, by the column each sits in. */
  const cells = (el: Element) => [...el.children].map((c) => c.className.split(" ").find((k) => k.startsWith("ol-"))).filter(Boolean);
  const GRID = ["ol-chev", "ol-glyph", "ol-title", "ol-owner", "ol-state", "ol-measure", "ol-date"];

  // ── the document as the store holds it ──
  await show();
  assert.ok(calls.includes("feed:projects") && calls.includes("feed:proposals"), "mounts the projects and proposals feeders");
  assert.ok(calls.includes("feed:roles") && !calls.includes("feed:tree"), "the roles feeder; the screen's map feeds the live tree into the same home");
  assert.match(q("[data-company-article]")!.className, /\bol-scope\b/, "the article is the container its lines answer to: the room inside its padding, not the pane");
  assert.doesNotMatch(q("[data-company-document]")!.className, /\bol-scope\b/);
  assert.deepEqual(qa("[data-company-state] > span").map((c) => c.textContent), ["4 goals: 2 on track,", "1 at risk,", "1 not started ·", "9 projects,", "1 with work moving ·", "2 people,", "2 agent roles"], "each comma part wraps whole, so a narrow pane breaks at a comma and never inside a word");
  assert.ok(qa("[data-company-state] > span").every((c) => c.className === "whitespace-nowrap"));
  assert.equal(q("[data-company-name]")!.textContent, "Union");
  assert.equal(q("[data-company-state]")!.textContent, "4 goals: 2 on track, 1 at risk, 1 not started · 9 projects, 1 with work moving · 2 people, 2 agent roles");
  assert.deepEqual(sections(), ["company", "goals", "unfiled", "people"]);
  none(q("[data-company-toc], [data-company-proposals], [data-company-purpose]"), "no contents, no proposal banner, no purpose block: the header and the strip say those");

  // Goals: one line each, the top level in the outline's order.
  assert.deepEqual(qa("[data-company-section='goals'] [data-company-depth='1'] > [data-line='goal']").map((l) => l.getAttribute("data-line-ref")), ["in-2", "in-4", "in-1"]);
  const network = line("union-in-2")!;
  assert.deepEqual(cells(network), GRID, "a goal line fills every column of the grid");
  assert.equal(network.querySelector("[data-line-title]")!.getAttribute("href"), "/goals/in-2");
  assert.ok(network.querySelector("[data-line-owner] [data-initiative-pick='owner'] [data-face='person:Ashot Petrosian']"), "the owner, as the picker the sheet uses");
  assert.equal(network.querySelector("[data-line-state] [data-initiative-health]")!.getAttribute("data-initiative-health"), "on_track");
  const metric = network.querySelector("[data-line-measure] [data-metric='brokers']")!;
  assert.equal(metric.getAttribute("data-metric-size"), "line");
  assert.match(metric.textContent!, /^17 of 40/, "now of target, with no name: the column names it");
  assert.doesNotMatch(metric.textContent!, /Brokers onboarded/);
  assert.equal(metric.querySelector("[data-metric-trend]")!.getAttribute("data-metric-trend"), "up");
  assert.ok(metric.querySelector("svg"), "the sparkline");
  assert.equal(network.querySelector("[data-line-date] [data-initiative-target]")!.getAttribute("data-initiative-target"), "ahead");
  none(q("[data-initiative-progress]"), "a goal's progress is its metric: no task bar");
  // A goal without a metric or a target day leaves those cells out rather than drawing filler.
  none(line("union-in-1")!.querySelector("[data-line-measure], [data-line-date]"), "no empty measure or date cell");

  // It opens on the goal at the worst health; the rest are folded.
  assert.deepEqual(qa("[data-company-open]").map((g) => g.getAttribute("data-company-goal")), ["in-4"]);
  assert.equal(line("union-in-4")!.getAttribute("aria-expanded"), "true");
  assert.equal(line("union-in-4")!.querySelector("[data-line-state] [data-initiative-health]")!.getAttribute("data-initiative-health"), "at_risk", "the line says the word the state line counts and the document opens on, whatever its status");
  assert.equal(network.getAttribute("aria-expanded"), "false");
  assert.match(q("[data-company-goal-body='in-4'] [data-company-why]")!.textContent!, /^One careless message/);
  assert.ok(q("[data-company-goal-body='in-4'] [data-company-update='union-upd-2']"), "the owner's latest word");
  assert.ok(calls.some((c) => c.startsWith("feed:initiativeUpdates")), "its updates are fed while it is open");

  // A click on the row opens it in place, and the choice is the person's, written to their synced UI state.
  await click(network.querySelector(".ol-measure"), "the row's background");
  assert.equal(calls.at(-1), `ui:${JSON.stringify({ org_expanded: ["union-in-4", "union-in-2"] })}`);
  await rerender();
  assert.equal(line("union-in-2")!.getAttribute("aria-expanded"), "true");
  assert.match(q("[data-company-goal-body='in-2'] [data-company-why]")!.textContent!, /^Brokers place the deals/);
  assert.ok(q("[data-company-goal-body='in-2'] [data-company-update='union-upd-1']"));
  none(q("[data-company-refs]"), "no run-on sentence of the projects listed under other goals: each is a line where it is listed");
  // What carries it, one level in: its project line, then the goal that feeds it, each on the same columns.
  const pr6 = line("union-proj-network")!;
  assert.equal(pr6.getAttribute("aria-level"), "2");
  // A quiet active project leaves its state cell out (the column speaks only when something happens); the grid areas hold the rest in place.
  assert.deepEqual(cells(pr6), GRID.filter((c) => c !== "ol-state"));
  none(q("[data-project-status='active']"), "no project line says active");
  assert.match(pr6.getAttribute("style")!, /--ol-indent: 18px/, "depth indents inside the first column, so every other column holds");
  assert.equal(pr6.querySelector("[data-line-measure]")!.textContent, "12 of 21 tasks", "the board's count: dropped and agent rows are not in it");
  assert.equal(pr6.querySelector("[data-line-owner] [data-project-lead-chip]")!.getAttribute("data-editable"), "1", "the lead, as the chip the board uses");
  assert.match(pr6.querySelector("[data-project-glyph]")!.className, /bg-sol-blue/, "a diamond in the project's colour");
  assert.equal(line("union-in-5")!.getAttribute("aria-level"), "2");
  // The chevron folds it back.
  await click(line("union-in-2")!.querySelector("[data-line-chev]"));
  assert.equal(calls.at(-1), `ui:${JSON.stringify({ org_expanded: ["union-in-4"] })}`);
  // A second window reads the same synced state and opens the same lines.
  state.clientState.ui.org_expanded = ["union-in-2", "union-in-5", "gone-goal"];
  await rerender();
  assert.deepEqual(qa("[data-company-open]").map((g) => g.getAttribute("data-company-goal")), ["in-2", "in-5"], "what was opened elsewhere is open here; the stale id opens nothing");

  // An owner or status picked on a line paints in the same tick.
  const pick = (id: string, which: string, label: RegExp) => [...line(id)!.querySelectorAll(`[data-line-${which}] [data-popover] button`)].find((b) => label.test(b.textContent ?? ""));
  await click(pick("union-in-2", "state", /^Planned$/), "the status list");
  assert.equal(calls.at(-1), `update:union-in-2:${JSON.stringify({ status: "planned" })}`);
  await rerender();
  assert.equal(collections.initiatives.find((g: any) => g._id === "union-in-2")!.status, "planned", "the pick is in the store at once");
  assert.equal(line("union-in-2")!.querySelector("[data-line-state] [data-initiative-health]")!.getAttribute("data-initiative-health"), "on_track", "a planned goal its owner has spoken on still shows their word");
  assert.ok([...line("union-in-2")!.querySelectorAll("[data-line-state] [data-popover] button")].some((b) => b.textContent === "Not started"), "the status that is not a proposal says so plainly");
  assert.equal(line("union-in-2")!.getAttribute("aria-expanded"), "true", "a pick is the control's own click, never the row's");
  await click(pick("union-in-2", "owner", /Samvit/), "the owner list");
  assert.equal(calls.at(-1), `update:union-in-2:${JSON.stringify({ owner: { kind: "user", user_id: "fixture-user-samvit" } })}`);
  await rerender();
  assert.ok(line("union-in-2")!.querySelector("[data-line-owner] [data-face='person:Samvit Ramadurgam']"));
  collections.initiatives = fx.COMPANY_FIXTURE_INITIATIVES.map((g) => ({ ...g }));

  // A line's title is an address and Enter navigates to it; neither folds the line.
  await key(line("union-in-1"), "Enter");
  assert.equal(calls.at(-1), "push:/goals/in-1");
  await click(line("union-in-2")!.querySelector("[data-line-title]"));
  assert.equal(line("union-in-2")!.getAttribute("aria-expanded"), "true");
  // Space and the arrows open and fold in place.
  await key(line("union-in-1"), "ArrowRight");
  assert.equal(calls.at(-1), `ui:${JSON.stringify({ org_expanded: ["union-in-2", "union-in-5", "gone-goal", "union-in-1"] })}`);

  // Projects no goal carries: lines too, and one that says something against itself opens to it.
  assert.deepEqual(qa("[data-company-section='unfiled'] [data-line='project']").map((l) => l.getAttribute("data-line-ref")), ["pr-2", "pr-3", "pr-4", "pr-1", "pr-9", "pr-8"]);
  const callers = line("union-proj-callers")!;
  assert.equal(callers.getAttribute("data-expandable"), "true", "past its target with work left");
  assert.equal(line("union-proj-cameron")!.getAttribute("data-expandable"), null, "nothing to say, nothing to open");
  state.clientState.ui.org_expanded = ["union-proj-callers", "union-proj-infra"];
  await rerender();
  assert.equal(q("[data-project-body='pr-2'] [data-project-trouble]")!.textContent, "Past its target");
  assert.equal(q("[data-project-body='pr-4'] [data-project-trouble]")!.textContent, "1 risk in its charter");
  none(q("[data-line-id='union-proj-infra'] [data-line-measure]"), "no tasks counted, no count");

  // People and roles: the reporting outline, a person then the roles under them.
  assert.deepEqual(qa("[data-company-section='people'] [data-line]").map((l) => `${l.getAttribute("data-line")}:${l.getAttribute("aria-level")}`), ["person:1", "role:2", "role:2", "person:1"]);
  assert.equal(q("[data-company-section='people'] [data-company-count]")!.textContent, "2 people · 2 roles");
  const ashot = line("fixture-user-me")!;
  assert.deepEqual(cells(ashot), GRID);
  assert.equal(ashot.querySelector("[data-line-title]")!.getAttribute("href"), "/org/@ashot");
  assert.equal(ashot.querySelector("[data-line-sub]")!.textContent, "you");
  assert.equal(ashot.querySelector("[data-person-access]")!.textContent, "owner");
  assert.equal(ashot.querySelector("[data-person-presence]")!.getAttribute("data-person-presence"), "online");
  assert.equal(ashot.querySelector("[data-person-carries]")!.textContent, "1 goal · 5 sessions at work, 4 waiting on input", "the roles are the lines right under it: not counted again; only live sessions count");
  assert.equal(ashot.querySelector("[data-person-since]")!.textContent, "since Jan");
  const quality = line("fixture-role-agent-quality")!;
  assert.deepEqual(cells(quality), GRID.filter((c) => c !== "ol-owner"), "the owner cell left empty, every other column held");
  assert.equal(quality.querySelector("[data-line-title]")!.getAttribute("href"), "/org/or-36");
  none(quality.querySelector("[data-role-reports-to]"), "it sits right under whom it reports to: the line does not name them again");
  assert.equal(quality.querySelector("[data-role-state]")!.getAttribute("data-role-state"), "dormant", "its standing agent's own word");
  assert.equal(quality.querySelector("[data-role-carries]")!.textContent, "leads Agent Quality");
  assert.equal(line("fixture-role-head-of-people")!.querySelector("[data-role-carries]")!.textContent, "owns Every project has a lead and every goal an owner");
  // A person opens in place to the goals they own, as goal lines.
  await click(ashot.querySelector("[data-line-chev]"));
  await rerender();
  assert.ok(q("[data-company-person='fixture-user-me'] [data-line-id='union-in-2'][aria-level='2']"));

  // ── the filters narrow the same document, and every line keeps the same cells ──
  // A line draws only the cells it has something for, always in the grid's order: the columns hold still.
  const lineCells = () => qa("[data-line]:not([data-ghost])").map((l) => cells(l) as string[]);
  const onGrid = (c: string[]) => c.slice(0, 3).join(" ") === "ol-chev ol-glyph ol-title" && c.every((k, i) => i === 0 || GRID.indexOf(k) > GRID.indexOf(c[i - 1]));
  await show({ filter: "goals" });
  assert.deepEqual(sections(), ["company", "goals", "unfiled"]);
  assert.ok(lineCells().every(onGrid));
  await show({ filter: "projects" });
  assert.deepEqual(sections(), ["company", "projects"]);
  assert.deepEqual(qa("[data-company-project-group]").map((g) => g.getAttribute("data-company-project-group")), ["in-2", "in-5", "in-1", "unfiled"]);
  assert.equal(qa("[data-company-section='projects'] [data-line='project']").length, 9, "every project once");
  assert.equal(qa("[data-line='goal']").length, 0, "goals are headings here, not lines");
  assert.ok(lineCells().every(onGrid));
  await show({ filter: "people" });
  assert.deepEqual(sections(), ["company", "people"]);
  assert.ok(lineCells().every(onGrid));
  // The line under the top sheet is marked, so the document stays live beside it.
  await show({ selected: "or-36" });
  assert.equal(line("fixture-role-agent-quality")!.getAttribute("data-selected"), "true");

  // ── with the open proposals: each in its place, in violet, answered in the conversation ──
  propose();
  state.clientState.ui.org_expanded = undefined;
  await show();
  assert.ok(calls.includes("feed:proposal:op-54") && calls.includes("feed:proposal:op-55"), "one feeder for each open proposal");
  assert.equal(q("[data-company-state]")!.textContent, "4 goals: 2 on track, 1 at risk, 1 not started · 9 projects, 1 with work moving · 2 people, 2 agent roles", "nothing proposed is counted as held");
  // The company as it is stays the base: the counts are the live ones, with what the proposal would add said apart.
  assert.deepEqual(sections(), ["company", "goals", "unfiled", "people"], "a project only a proposal places is still loose");
  assert.equal(q("[data-company-section='goals'] [data-company-count]")!.textContent, "4 · 7 proposed");
  assert.deepEqual(qa("[data-company-section='goals'] [data-company-depth='1'] > [data-line='goal']:first-child").map((l) => l.getAttribute("data-line-id")), ["union-in-2", "union-in-4", "union-in-1", "union-purpose"]);
  const purpose = line("union-purpose")!;
  assert.equal(purpose.getAttribute("data-ghost"), "");
  assert.equal(purpose.querySelector("[data-line-title]")!.textContent, "Broker high-value introductions that become real transactions");
  assert.equal(purpose.querySelector("[data-line-title]")!.tagName, "SPAN", "a proposed goal has no sheet to open yet");
  const answer = purpose.querySelector("[data-line-answer]")!;
  assert.equal(answer.textContent, "op-54 · answer in the conversation");
  assert.equal(answer.getAttribute("href"), "/org?proposal=op-54&focus=1");
  assert.equal(purpose.getAttribute("aria-expanded"), "false", "it opens on the live goal at the worst health, never on a proposal");
  // A live goal the proposal would move keeps its place, and its own line says where it would go.
  assert.equal(line("union-in-2")!.getAttribute("data-ghost"), null);
  const move = line("union-in-2")!.querySelector("[data-company-goal-move]")!;
  assert.equal(move.textContent, "", "an arrow, not words: the line it moves to says \"moves here\"");
  assert.match(move.getAttribute("aria-label")!, /^moves under Broker high-value/);
  assert.match(move.getAttribute("title")!, /^op-54 would move it under Broker high-value/);
  // Opened, the proposed goal names the live goals that would come under it (each opens) and the goals it sets.
  await click(purpose.querySelector("[data-line-chev]"));
  await rerender();
  assert.deepEqual(qa("[data-company-arriving]").map((a) => a.getAttribute("data-company-arriving")), ["in-2", "in-4", "in-1"]);
  const arriving = line("arriving:union-in-2")!;
  assert.equal(arriving.querySelector("[data-line-title]")!.getAttribute("href"), "/goals/in-2", "a real goal a proposal would move opens like any other");
  assert.equal(arriving.querySelector("[data-line-sub]")!.textContent, "moves here");
  assert.equal(arriving.querySelector("[data-line-answer]")!.getAttribute("href"), null, "the line above already says where it is answered");
  assert.equal(line("union-revenue")!.getAttribute("data-ghost"), "");
  none(q("[data-company-change='union-network']"), "a goal's own move is never a line under it");
  // Hovering a proposal's line lights its card in the conversation; leaving puts it out.
  assert.equal(lit["union-purpose"], false);
  await hover(line("union-purpose"), true);
  assert.equal(lit["union-purpose"], true);
  await hover(line("union-purpose"), false);
  assert.equal(lit["union-purpose"], false);
  // A role it would hire stands under who it would report to.
  const hire = q("[data-company-ghost-role='union-staff-outreach'] [data-line='role']")!;
  assert.equal(hire.getAttribute("aria-level"), "2");
  assert.equal(hire.querySelector("[data-line-title]")!.textContent, "Broker Outreach Lead");
  // The change just above it is the same proposal's and says where to answer it; this one does not repeat it.
  assert.equal(q("[data-company-ghost-role='union-staff-quality-scope'] [data-line-answer]")!.getAttribute("href"), "/org?proposal=op-55&focus=2");
  assert.equal(hire.querySelector("[data-line-answer]")!.getAttribute("href"), null);
  const scope = q("[data-company-ghost-role='union-staff-quality-scope'] [data-line][aria-level='3']")!;
  assert.ok(scope, "a change on a role, one level under it");
  assert.equal(scope.querySelector("[data-line-title]")!.textContent, "would lead Callers & Call Management", "said from the role's line, which already names the role");
  none(scope.querySelector("[data-line-sub]"), "no repeated role name");
  assert.ok(scope.querySelector("[data-project-glyph]"), "the project glyph, not the role's face again");
  await hover(hire, true);
  assert.equal(lit["union-staff-outreach"], true);
  await hover(hire, false);
  none(q("[data-subject-approve], [data-subject-reject], [data-subject-reply], [data-subject]"), "nothing to answer here");

  // A project under two goals is two lines in the Projects filter: each opens on its own, and the second says where it first appeared.
  state.clientState.ui.org_expanded = [];
  await show({ filter: "projects" });
  const twice = qa("[data-company-section='projects'] [data-line='project']").filter((l) => l.getAttribute("data-line-ref") === "pr-12");
  assert.equal(twice.length, 2, "listed under both goals");
  assert.equal(twice[0].querySelector("[data-company-also-under]"), null);
  assert.match(twice[1].querySelector("[data-company-also-under]")!.textContent!, /^also under Every relationship/);
  await click(twice[0].querySelector("[data-line-chev]"));
  await rerender();
  assert.deepEqual(qa("[data-company-section='projects'] [data-line-ref='pr-12']").map((l) => l.getAttribute("aria-expanded")), ["true", "false"], "keyed by where it is drawn, not by the project alone");

  // ── before the org tree arrives: the plain outline under the team's name ──
  env.tree = null;
  await show();
  assert.equal(q("[data-company-name]")!.textContent, "Union");
  assert.deepEqual(qa("[data-company-section='goals'] [data-company-depth='1'] > [data-line='goal']").map((l) => l.getAttribute("data-line-ref")), ["in-2", "in-4", "in-1"]);
  assert.equal(qa("[data-line='role']").length, 0);
  assert.equal(qa("[data-line='person']").length, 2, "the roster's people");
  none(q("[data-ghost]"), "no tree, no ghosts");

  // ── an empty workspace: no empty sections, and a filter with nothing says so in two words ──
  collections.initiatives = []; collections.projects = [];
  await show();
  assert.deepEqual(sections(), ["company", "people"]);
  await show({ filter: "goals" });
  assert.deepEqual(sections(), ["company"]);
  assert.equal(q("[data-company-empty]")!.textContent, "No goals.");

  await act(async () => root.unmount());
}

test("company document mount: lines on one grid, opened in place and synced, edits paint at once, filters line up, proposals in violet", async () => {
  await verifyCompany();
}, 600_000);
