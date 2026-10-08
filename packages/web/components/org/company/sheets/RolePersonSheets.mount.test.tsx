// The role and person sheets (cohesive build spec §5.4, §5.5) and the person
// hover card, mounted over the org fixture with the real store: a role
// sheet reads as its summary sections, then only the working tabs, then its
// folds, and whom it reports to opens their sheet; a person sheet carries
// the roles they host, the goals and projects they answer for and their
// Focus as each role that keeps it has it (any role they report into),
// Message opens their DM with the draft, and Activity profile is their /team
// page; a role reads the same in both sheets' Now; the person card says what
// the person sheet's head says.
// Run: bun test components/org/company/sheets/RolePersonSheets.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";
import type { OrgRole, OrgTree } from "../../orgTypes";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "HTMLSelectElement", "SVGElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "InputEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "DOMRect"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(dom.window as any).HTMLElement.prototype.scrollIntoView = () => {};
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
const { act } = React;

const ME = "fixture-user-me";
const SAM = "fixture-user-sam";
const TEAM = "fixture-team";
const WS = `team:${TEAM}`;
const T0 = Date.UTC(2026, 9, 7, 12);
const today = new Date(T0).toISOString().slice(0, 10);

// ── what the sheets read beyond the store ──
const env = { briefs: {} as Record<string, any> };
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
const pushed: string[] = [];
const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push: (u: string) => pushed.push(u), replace: () => {} }), usePathname: () => "/org", useSearchParams: () => new URLSearchParams() }));
const realHealth = { ...(await import("../../../../hooks/useSyncOrgHealth")) };
const healthFeed = { asks: [] as boolean[], error: undefined as Error | undefined, missing: false, refreshes: 0 };
mock.module("../../../../hooks/useSyncOrgHealth", () => ({ ...realHealth, useSyncOrgHealth: (on: boolean) => { healthFeed.asks.push(on); return { health: null, ready: true, missing: healthFeed.missing, error: healthFeed.error, refresh: async () => { healthFeed.refreshes++; } }; } }));
for (const name of ["useSyncTasks", "useSyncPlans"]) {
  const real = { ...(await import(`../../../../hooks/${name}`)) };
  mock.module(`../../../../hooks/${name}`, () => ({ ...real, [name]: () => {} }));
}
const realDocs = { ...(await import("../../../../hooks/useSyncDocs")) };
mock.module("../../../../hooks/useSyncDocs", () => ({ ...realDocs, useSyncDocs: () => {} }));
// The server answers a role's brief from the fixture; pills and other
// enrichments have nothing to add. bun shares module mocks across the files
// of one run, so each test puts this answer back before it mounts.
const { getFunctionName } = await import("convex/server");
const realQuery = { ...(await import("../../../../hooks/useQueryNoThrow")) };
const answer = (fn: any, args: any) => ({ data: args !== "skip" && getFunctionName(fn) === "org:brief" ? env.briefs[args?.role_id] : undefined, error: undefined, retry: () => {} });
const serveQueries = () => mock.module("../../../../hooks/useQueryNoThrow", () => ({ ...realQuery, useQueryNoThrow: answer }));
serveQueries();
mock.module("../../../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));
const realAsks = { ...(await import("../../useNeedsYou")) };
mock.module("../../useNeedsYou", () => ({ ...realAsks, useOrgAsks: () => [] }));
const realFeatures = { ...(await import("../../../../lib/teamFeatures")) };
mock.module("../../../../lib/teamFeatures", () => ({ ...realFeatures, useCallsAvailable: () => true }));
const rang: string[] = [];
mock.module("../../../presence/useMemberHuddle", () => ({ useMemberHuddle: (member: any) => ({ label: "Huddle", title: "Ring them", waiting: false, go: () => rang.push(String(member._id)) }) }));
const chats: string[] = [];
const realDm = { ...(await import("../../../../hooks/useOpenDm")) };
mock.module("../../../../hooks/useOpenDm", () => ({ ...realDm, useOpenChatPath: () => (path: string) => chats.push(path) }));
mock.module("../../../SessionPrewarm", () => ({ SessionPrewarm: () => null }));
mock.module("../../../../app/tasks/page", () => ({ TaskListContent: () => h("div", { "data-task-list": true }) }));
mock.module("../../scope/ScopeFeed", () => ({ ScopeFeed: () => h("div", { "data-scope-feed": true }) }));
mock.module("../../scope/ScopeSettings", () => ({ ScopeSettings: () => h("div", { "data-scope-settings": true }) }));
mock.module("../../scope/ScopeTriggersTab", () => ({ ScopeTriggersTab: () => h("div", { "data-scope-triggers": true }) }));
mock.module("../../scope/ScopeLineTab", () => ({ ScopeLineTab: () => h("div", { "data-scope-line": true }) }));
const realTemplate = { ...(await import("../../TemplateSections")) };
mock.module("../../TemplateSections", () => ({ ...realTemplate, TemplateSections: () => null }));
mock.module("../../history/OrgHistory", () => ({ OrgHistory: () => null }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../../store/inboxStore");
const { ORG_FIXTURE } = await import("../../orgFixture");
const { RoleSheet } = await import("./RoleSheet");
const { PersonSheet } = await import("./PersonSheet");
const { SheetHostContext } = await import("../sheetHost");
const { PersonHoverContent } = await import("../../../identity/PersonHoverCard");

// ── the world: Samvit hosts a Matching lead, which leads Lead lists; he owns
// a goal; a Head of People he neither hosts nor is reported to by keeps his focus ──
const growth = ORG_FIXTURE.roles[0];
const matching: OrgRole = {
  ...growth, _id: "fixture-role-matching", short_id: "or-5", name: "Matching lead", handle: "matching", host_user_id: SAM,
  reports_to: { kind: "user", user_id: SAM }, reports_user_ids: [], charter: "Scores introductions before anyone calls.",
  scope: { project_ids: ["fixture-project-lists"], plan_ids: [] }, scope_names: { projects: [{ id: "fixture-project-lists", title: "Lead lists", short_id: "pj-li" }], plans: [] },
  standing: { conversation_id: "fixture-matching-conv", short_id: "jx7mat1", state: "working", state_line: "Scoring v2 on half the list", state_status: "working", state_at: T0 - 600_000 },
};
const people: OrgRole = {
  ...growth, _id: "fixture-role-people", short_id: "or-9", name: "Head of People", handle: "head-of-people", host_user_id: ME,
  reports_to: { kind: "user", user_id: ME }, reports_user_ids: [SAM], charter: "Keeps each person's focus.", sessions: [], counts: {}, total: 0, standing: null,
  scope: { project_ids: [], plan_ids: [] }, scope_names: { projects: [], plans: [] },
};
const tree: OrgTree = { ...ORG_FIXTURE, roles: [growth, matching, people] };
const row = (r: any) => ({ workspace: WS, team_id: TEAM, updated_at: 1, created_at: 1, ...r });
const project = (id: string, title: string, short_id: string, owner_role_id: string) => row({ _id: id, title, short_id, status: "active", owner_role_id, task_counts: { total: 0, done: 0, in_progress: 0 }, plan_count: 0, doc_count: 0, active_plan_count: 0 });
const lists = project("fixture-project-lists", "Lead lists", "pj-li", matching._id);
const growthProject = project("fixture-project-growth", "Growth", "pj-gr", growth._id);
const funnel = row({ _id: "g-funnel", short_id: "in-2", title: "Increase top of funnel", status: "active", owner: { kind: "user", user_id: SAM }, project_ids: ["fixture-project-lists"], health: "on_track", health_at: 1, user_id: ME });
env.briefs[growth._id] = { role: { routine: null }, narrative: `## Where it stands\n- Growth: two pages shipped; the third waits on copy. (${today})`, facts: null, charter: "" };
env.briefs[matching._id] = { role: { routine: null }, narrative: "", facts: null, charter: "" };
env.briefs[people._id] = { role: { routine: null }, narrative: "", facts: { people: [{ user_id: SAM, name: "Samvit Jain", has_section: true, goals: [{ text: "Reach 2,000 sends a day by Oct 31", priority: "high", refs: [], moved_at: null, stalled: false, unmatched: false }], sessions_changed: [], sessions_total: 0, stalled_high: 0 }] } };

useInboxStore.setState({
  currentUser: { _id: ME },
  clientState: { ...(useInboxStore.getState().clientState as object), ui: { active_team_id: TEAM } },
  orgTree: tree,
  orgHealth: null,
  projects: { [lists._id]: lists, [growthProject._id]: growthProject },
  initiatives: { [funnel._id]: funnel },
  teamMembers: [{ _id: ME, name: "Ashot Petrosian", github_username: "ashot" }, { _id: SAM, name: "Samvit Jain", github_username: "samvit", joined_at: Date.UTC(2026, 5, 2) }],
} as any);

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const qa = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];
const opened: string[] = [];
const host = { under: null, underTitle: null, back() {}, close() {}, open: (k: string, r: string) => opened.push(`${k}:${r}`), talk() {}, talkable: true, leftConversationId: null as string | null, openProposal() {}, focusTitle: false, titleSettled() {}, covers: false };

async function mountNode(node: React.ReactNode) {
  serveQueries();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  return { el, render: (n: React.ReactNode) => act(async () => { root.render(n); }), unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}
const inScreen = (node: React.ReactNode, over: Partial<typeof host> = {}) => h(SheetHostContext.Provider, { value: { ...host, ...over } }, node);

test("a role sheet reads as its summary, then the working tabs, then its folds", async () => {
  opened.length = 0;
  const screen = await mountNode(inScreen(h(RoleSheet, { sheet: { kind: "role", ref: "or-1" } })));
  const el = screen.el;
  expect(q("[data-sheet-title]", el)!.textContent).toBe("Head of Growth");
  // The head names it as its hover card does: its handle and its id.
  expect(q("[data-sheet-id]", el)!.textContent).toBe("@growth · or-1");
  // The summary sections, in the sheet's one order.
  expect(qa("[data-sheet-section], [data-scope-section='stands']", el).map((s) => s.getAttribute("data-sheet-section") ?? s.getAttribute("data-scope-section"))).toEqual(["charter", "stands", "Now", "Carried by"]);
  expect(q("[data-role-charter]", el)!.textContent).toContain("Owns organic search");
  expect(q("[data-scope-stands='pj-gr'] [data-scope-stands-line]", el)!.textContent).toContain("two pages shipped");
  expect(q("[data-role-now='or-1'] [data-role-now-words]", el)!.textContent).toBe("Rewriting the weekly growth review");
  expect(q("[data-sheet-carried] [data-line-ref='pj-gr']", el)).not.toBeNull();
  // Then only the working tabs: the overview is the sheet itself.
  expect(qa("[data-sheet-role-tabs] [data-scope-tab]", el).map((t) => t.getAttribute("data-scope-tab"))).toEqual(["work", "sessions", "decisions", "triggers", "settings"]);
  // The tabs flow in the sheet's one scroll: no box of their own.
  expect(q("[data-sheet-role-tabs] [data-scope-panel]", el)!.className).not.toContain("h-full");
  expect(q("[data-sheet-role-tabs] [data-scope-scroll]", el)).toBeNull();
  expect(q("[data-sheet-role-tabs]", el)!.compareDocumentPosition(q("[data-sheet-folds]", el)!) & 4).toBeTruthy();
  expect(qa("[data-sheet-fold]", el).map((f) => f.getAttribute("data-sheet-fold"))).toEqual(["Its notes"]);
  // Whom it reports to opens their sheet, in the screen.
  const to = q("[data-sheet-facts] [data-role-reports-to] a", el)!;
  expect(to.textContent).toBe("Ashot Petrosian");
  await act(async () => { to.click(); });
  expect(opened).toEqual(["person:ashot"]);
  // Ask it, unless its own conversation is already on the left.
  expect(q("[data-sheet-ask-input]", el)!.getAttribute("placeholder")).toBe("Ask Head of Growth…");
  await screen.render(inScreen(h(RoleSheet, { sheet: { kind: "role", ref: "or-1" } }), { leftConversationId: "fixture-growth-conv" }));
  expect(q("[data-sheet-ask]", el)).toBeNull();
  await screen.unmount();
});

test("a person sheet carries their roles, the goals and projects they answer for, and their Focus", async () => {
  opened.length = 0; chats.length = 0; rang.length = 0;
  const drafts: Record<string, any> = {};
  useInboxStore.setState({ openDmChannel: () => "chan-sam", setDraft: (k: string, f: any) => { drafts[k] = f; }, getDraft: (k: string) => drafts[k] } as any);
  const screen = await mountNode(inScreen(h(PersonSheet, { sheet: { kind: "person", ref: "@samvit" } })));
  const el = screen.el;
  expect(q("[data-sheet-title]", el)!.textContent).toBe("Samvit Jain");
  expect(qa("[data-sheet-serves] a", el).map((a) => a.textContent)).toEqual(["Increase top of funnel"]);
  // Now: their work role by role, in each role's own words.
  expect(q("[data-role-now='or-5'] [data-role-now-words]", el)!.textContent).toBe("Scoring v2 on half the list");
  await act(async () => { q("[data-role-now='or-5'] [data-role-now-open]", el)!.click(); });
  expect(opened).toEqual(["role:or-5"]);
  opened.length = 0;
  // Carried by: the role they host, then the project it leads.
  expect(qa("[data-sheet-carried] [data-line-ref]", el).map((l) => l.getAttribute("data-line-ref"))).toEqual(["or-5", "pj-li"]);
  // Focus, as the role that keeps it has it: a role he reports into, not one he hosts.
  // One Focus section, whichever roles keep it, each holding role's part marked.
  expect(qa("[data-sheet-section='focus']", el)).toHaveLength(1);
  expect(qa("[data-focus-from]", el).map((f) => f.getAttribute("data-focus-from"))).toEqual(["or-9"]);
  const focus = q("[data-sheet-section='focus']", el)!;
  expect(focus.textContent).toContain("kept by Head of People");
  expect(focus.textContent).toContain("Reach 2,000 sends a day by Oct 31");
  // Message opens their DM with the line as its draft; Call rings them.
  const input = q("[data-sheet-ask-input]", el) as HTMLInputElement;
  expect(input.getAttribute("placeholder")).toBe("Message Samvit Jain…");
  const setter = Object.getOwnPropertyDescriptor((dom.window as any).HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "Lists by Thursday?"); input.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true })); });
  await act(async () => { (input.form as HTMLFormElement).dispatchEvent(new (dom.window as any).Event("submit", { bubbles: true, cancelable: true })); });
  expect(drafts["chat:chan-sam"]).toMatchObject({ draft_message: "Lists by Thursday?" });
  expect(chats).toEqual(["/chat/chan-sam"]);
  await act(async () => { q("[data-sheet-call]", el)!.click(); });
  expect(rang).toEqual([SAM]);
  // Their activity profile is their /team page.
  expect(q("[data-sheet-activity-profile]", el)!.getAttribute("href")).toBe("/team/samvit");
  await screen.unmount();
});

test("a role waiting on input reads the same on its own sheet and its host's", async () => {
  const waiting = { ...growth.sessions[0], _id: "fixture-session-wait", short_id: "jx7wait", state: "needs_input" as const };
  const stuck: OrgRole = { ...matching, sessions: [waiting], counts: { needs_input: 1 }, total: 1, standing: { ...matching.standing!, state_line: undefined } };
  useInboxStore.setState({ orgTree: { ...tree, roles: [growth, stuck, people] } } as any);
  const role = await mountNode(inScreen(h(RoleSheet, { sheet: { kind: "role", ref: "or-5" } })));
  const person = await mountNode(inScreen(h(PersonSheet, { sheet: { kind: "person", ref: "@samvit" } })));
  const words = (root: ParentNode) => q("[data-role-now='or-5'] [data-role-now-words]", root)?.textContent;
  expect(words(role.el)).toBe("1 waiting on input");
  expect(words(person.el)).toBe(words(role.el));
  // Never "no session at work" beside a waiting bar; the pill is the session it waits in.
  expect(role.el.textContent).not.toContain("No session at work");
  expect(q("[data-role-now='or-5']", role.el)!.textContent).toContain("waiting in");
  await role.unmount();
  await person.unmount();
  useInboxStore.setState({ orgTree: tree } as any);
});

test("a person with nothing live has no Now on their sheet", async () => {
  const idle: OrgRole = { ...matching, sessions: [], counts: {}, total: 0, standing: null };
  const quiet = tree.people.map((p) => p.user_id === SAM ? { ...p, sessions: [], counts: {}, total: 0 } : p);
  useInboxStore.setState({ orgTree: { ...tree, people: quiet, roles: [growth, idle, people] } } as any);
  const person = await mountNode(inScreen(h(PersonSheet, { sheet: { kind: "person", ref: "@samvit" } })));
  expect(q("[data-sheet-section='Now']", person.el)).toBeNull();
  expect(q("[data-sheet-now]", person.el)).toBeNull();
  await person.unmount();
  useInboxStore.setState({ orgTree: tree } as any);
});

test("a role's Overview says what it is doing in its sheet's words", async () => {
  const { RoleDoing } = await import("../../scope/ScopePanel");
  const waiting = { ...growth.sessions[0], _id: "fixture-session-wait", short_id: "jx7wait", state: "needs_input" as const };
  const stuck: OrgRole = { ...matching, sessions: [waiting], counts: { needs_input: 1 }, total: 1, standing: { ...matching.standing!, state_line: undefined } };
  const doing = await mountNode(h(RoleDoing, { role: stuck }));
  expect(q("[data-scope-doing] [data-role-now-words]", doing.el)!.textContent).toBe("1 waiting on input");
  expect(doing.el.textContent).toContain("waiting in");
  expect(doing.el.textContent).not.toContain("No session at work");
  await doing.render(h(RoleDoing, { role: { ...stuck, sessions: [{ ...waiting, state: "done" as const }], counts: { done: 1 } } }));
  expect(q("[data-scope-doing]", doing.el)!.textContent).toBe("Nothing live right now.");
  await doing.render(h(RoleDoing, { role: { ...stuck, sessions: [], counts: {}, total: 0 } }));
  expect(q("[data-scope-doing]", doing.el)!.textContent).toBe("No sessions under it yet.");
  await doing.unmount();
});

test("the person card says what the person sheet's head says, and opens the sheet", async () => {
  opened.length = 0;
  const sheet = await mountNode(inScreen(h(PersonSheet, { sheet: { kind: "person", ref: "samvit" } })));
  const card = await mountNode(inScreen(h(PersonHoverContent, { person: { userId: SAM } })));
  const facts = (root: ParentNode) => ["[data-person-access]", "[data-person-presence]", "[data-person-carries]", "[data-person-since]"].map((s) => q(s, root)?.textContent ?? null);
  expect(facts(card.el)).toEqual(facts(sheet.el));
  expect(facts(card.el)[0]).toBe("member");
  expect(qa("[data-summary-serves-item]", card.el).map((a) => a.textContent)).toEqual(["Increase top of funnel"]);
  expect(q("[data-summary-carried]", card.el)!.textContent).toContain("1 role");
  await sheet.unmount();
  await card.unmount();
  // Outside the screen the card goes to the person's address.
  pushed.length = 0;
  const outside = await mountNode(h(PersonHoverContent, { person: { userId: SAM } }));
  await act(async () => { q("[data-person-card]", outside.el)!.click(); });
  expect(pushed).toEqual(["/org/@samvit"]);
  await outside.unmount();
  // The foot names a person by handle; without one it shows no raw id.
  const roster = (useInboxStore.getState() as any).teamMembers;
  const named = await mountNode(h(PersonHoverContent, { person: { userId: SAM } }));
  expect(q("[data-object-card] .font-mono", named.el)!.textContent).toBe("@samvit");
  await named.unmount();
  useInboxStore.setState({ teamMembers: roster.map((m: any) => m._id === SAM ? { ...m, github_username: undefined } : m) } as any);
  const bare = await mountNode(h(PersonHoverContent, { person: { userId: SAM } }));
  expect(q("[data-object-card] .font-mono", bare.el)!.textContent).toBe("");
  await bare.unmount();
  useInboxStore.setState({ teamMembers: roster } as any);
});

test("a role sheet's This week (D12): its week, then behind What if its two levers; the limit is set through the store", async () => {
  const { ORG_STAFFING_FIXTURE_HEALTH } = await import("../../orgStaffingFixture");
  const realUpdate = useInboxStore.getState().updateOrgRole;
  const updates: any[] = [];
  useInboxStore.setState({ orgHealth: ORG_STAFFING_FIXTURE_HEALTH, updateOrgRole: (id: string, fields: any) => updates.push({ id, fields }) } as any);
  healthFeed.asks.length = 0;
  const screen = await mountNode(inScreen(h(RoleSheet, { sheet: { kind: "role", ref: "or-1" } })));
  const el = screen.el;
  const week = q("[data-sheet-section='week']", el)!;
  expect(q("[data-role-week='growth']", week)).not.toBeNull();
  // A cached copy is painted, and the feeder still runs so it refreshes.
  expect(healthFeed.asks.length).toBeGreaterThan(0);
  expect(healthFeed.asks.every(Boolean)).toBe(true);
  // The week sits after Now and before what carries the role.
  expect(qa("[data-sheet-section]", el).map((s) => s.getAttribute("data-sheet-section"))).toEqual(["charter", "stands", "Now", "week", "Carried by"]);
  expect(q("[data-what-if]", week)).toBeNull();
  await act(async () => { q("[data-role-week-levers]", week)!.click(); });
  expect(q("[data-what-if]", week)).not.toBeNull();
  // Its Head of People has no thread yet, so the hand-over offers no ask.
  await act(async () => { q("[data-what-if-pick='move']", week)!.click(); });
  expect(q("[data-what-if-ask]", week)).toBeNull();
  await act(async () => { q("[data-what-if-pick='limit']", week)!.click(); });
  const range = q("[data-what-if-limit]", week) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor((window as any).HTMLInputElement.prototype, "value")!.set!.call(range, "60");
    range.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
  });
  await act(async () => { q("[data-what-if-apply]", week)!.click(); });
  expect(updates).toHaveLength(1);
  expect(updates[0].id).toBe(growth._id);
  expect(updates[0].fields.caps.wakes_per_day).toBe(60);
  await screen.unmount();
  useInboxStore.setState({ orgHealth: null, updateOrgRole: realUpdate } as any);
});

test("a role sheet's This week says when the health read failed or the server lacks it, instead of going quiet", async () => {
  useInboxStore.setState({ orgHealth: null } as any);
  healthFeed.error = new Error("Too many reads");
  healthFeed.refreshes = 0;
  const failed = await mountNode(inScreen(h(RoleSheet, { sheet: { kind: "role", ref: "or-1" } })));
  const week = q("[data-sheet-section='week']", failed.el)!;
  expect(q("[data-health-error]", week)!.textContent).toContain("Too many reads");
  await act(async () => { qa("button", week).find((b) => b.textContent === "Retry")!.click(); });
  expect(healthFeed.refreshes).toBe(1);
  await failed.unmount();
  healthFeed.error = undefined;

  healthFeed.missing = true;
  const missing = await mountNode(inScreen(h(RoleSheet, { sheet: { kind: "role", ref: "or-1" } })));
  expect(q("[data-sheet-section='week']", missing.el)!.textContent).toContain("does not read the company's health yet");
  await missing.unmount();
  healthFeed.missing = false;

  // A clean read with no word on the role draws no section.
  const clean = await mountNode(inScreen(h(RoleSheet, { sheet: { kind: "role", ref: "or-1" } })));
  expect(q("[data-sheet-section='week']", clean.el)).toBeNull();
  await clean.unmount();
});
