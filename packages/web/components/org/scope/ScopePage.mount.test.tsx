// The scope page as a conversation (docs/architecture/scopes-and-feed.md
// F4), mounted in jsdom against the org fixture. Proves: the page opens as
// the role's standing conversation with the board beside it, in its three
// widths (a column, an overlay, a phone sheet); the header's control closes
// and reopens the panel; a role has six tabs and opens on Overview, whose
// briefing (F5.1) holds no number outside its own lines (F5.4); a link
// written for a tab that moved still lands on what it named; Talk and Wake
// are gone from the header; a role that has not started says what it is and
// offers the one gesture; the root without an anchor offers to create one;
// pause and retire are the header's menu, retire behind one confirm; and the
// Sessions tab groups sessions by who acts next with the inbox's order, a
// state line, an age and live subtask counts.
// Run: bun components/org/scope/ScopePage.mount.test.tsx
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";
import type { OrgSession, OrgTree } from "../orgTypes";

// The world both tests mount in: jsdom, the org fixture, and every module
// substitution the page's import graph needs. Built once per run: a
// substitution is process global, so the two tests share one set and
// each sets the rows it reads (env, state, collections) before mounting.
let worldOnce: Promise<any> | null = null;
function world() {
  worldOnce ??= (async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
    for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "NodeFilter", "DocumentFragment"]) {
      Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
    }
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (dom.window as any).HTMLElement.prototype.scrollIntoView = () => {};
    const { mock } = await import("bun:test");
    const React = await import("react");
    const { act } = React;

    // ── the world the page reads ──
    const { ORG_FIXTURE } = await import("../orgFixture");
    const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const env = { phone: false, wide: true, qs: "", tree: ORG_FIXTURE as OrgTree, summary: null as any, brief: null as any };
    const calls: string[] = [];
    const state: any = {
      currentUser: { _id: "fixture-user-me" },
      // The Scope tab paints from the store's tree slice, the one the page feeds.
      get orgTree() { return env.tree; },
      sessions: {} as Record<string, any>,
      conversations: {},
      docs: {}, docDetails: {}, sessionDecisions: {},
      // The page reads whether the diff is open (it closes the board for it).
      clientState: { ui: {}, layouts: {} },
      updateOrgRole: (id: string, fields: any) => calls.push(`update:${id}:${JSON.stringify(fields)}`),
      reparentOrgRole: () => {}, retireOrgRole: (id: string, choice?: string) => calls.push(`retire:${id}:${choice ?? ""}`),
    };
    const collections: Record<string, any[]> = { projects: [], plans: [], tasks: [], docs: [] };
    const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });

    mock.module("../../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
    // Spread the real module: a substitution is process-global, so a stub that
    // drops its other exports breaks every file that loads it afterwards.
    const realOrgTree = { ...(await import("../../../hooks/useSyncOrgTree")) };
    mock.module("../../../hooks/useSyncOrgTree", () => ({ ...realOrgTree, useSyncOrgTree: () => ({ tree: env.tree, ready: true, missing: false, refused: false, retry: () => {} }) }));
    for (const h of ["useSyncProjects", "useSyncTasks", "useSyncPlans"]) {
      // Spread the real module: these export ingest helpers other files
      // import, and a substitution answers for the whole run.
      const realSync = { ...(await import(`../../../hooks/${h}`)) };
      mock.module(`../../../hooks/${h}`, () => ({ ...realSync, [h]: () => {} }));
    }
    mock.module("../../../hooks/useSyncDocs", () => ({ useSyncDocs: () => {}, useSyncDocDetail: () => {} }));
    mock.module("../../../hooks/useSyncDecisionStacks", () => ({ useSyncDecisionStacks: () => {} }));
    mock.module("../../../hooks/useCollectionRows", () => ({ useCollectionRows: () => [] }));
    mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined }) }));
    mock.module("../../../hooks/useOrgSessionsUnder", () => ({ useOrgSessionsUnder: () => ({ data: undefined }) }));
    mock.module("../../../hooks/useWorkspaceCollection", () => ({ useWorkspaceCollection: (key: string) => collections[key] ?? [] }));
    mock.module("../../../hooks/useIsPhone", () => ({ useIsPhone: () => env.phone, useMinWidth: () => env.wide, PHONE_MAX_WIDTH: 768 }));
    mock.module("../../../hooks/useCoarseNow", () => ({ useCoarseNow: () => T0 }));
    mock.module("../../../hooks/useScopeQueries", () => ({
      useScopeSummary: () => ({ data: env.summary, missing: false }),
      useRoleBrief: () => ({ data: env.brief, missing: false }),
      useScopeFeedPage: () => ({ data: undefined, missing: false }),
    }));
    mock.module("../../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => (s: any) => calls.push(`open:${s._id}`) }));
    mock.module("next/navigation", () => ({
      useRouter: () => ({ replace: (u: string) => calls.push(`replace:${u}`), push: (u: string) => calls.push(`push:${u}`) }),
      useSearchParams: () => new URLSearchParams(env.qs),
      usePathname: () => "/org/or-1",
    }));
    mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
    mock.module("convex/react", () => ({ useMutation: () => async (args: any) => { calls.push(`mutation:${JSON.stringify(args)}`); return {}; }, useQuery: () => undefined }));
    mock.module("sonner", () => ({ toast: { error: (m: string) => calls.push(`toast:${m}`), success: (m: string) => calls.push(`toast:${m}`), warning: () => {} } }));
    mock.module("../../anchor/AnchorConversation", () => ({
      AnchorConversation: (props: any) => React.createElement("div", { "data-thread": props.conversationId, "data-thread-autofocus": props.autoFocusInput ? "1" : "0", "data-thread-owner": props.seedOwnership ? "1" : "0", "data-thread-fold": props.foldBootstrap ? "1" : "0", "data-thread-fold-working": props.foldWorkingTurns ? "1" : "0", "data-thread-density": props.initialDensity ?? "" }, props.leadNode, React.createElement("textarea", { "data-composer": true })),
      // The onboarding reads the workspace from the org tree itself (S22).
      AnchorOnboarding: (props: any) => React.createElement("div", { "data-anchor-onboarding": props.compact ? "compact" : "full" }, "Meet the workspace's agent"),
    }));
    // The conversation is the inbox's session pane with the seat's options (I3).
    mock.module("../../../app/inbox/QueuePageClient", () => ({
      InboxConversation: ({ sessionId, seat, autoFocusInput }: any) => React.createElement("div", { "data-thread": sessionId, "data-thread-autofocus": autoFocusInput ? "1" : "0", "data-thread-owner": seat.seedOwnership ? "1" : "0", "data-thread-fold": "1", "data-thread-fold-working": seat.layout.foldWorkingTurns ? "1" : "0", "data-thread-density": seat.layout.initialDensity ?? "" }, seat.layout.leadNode, React.createElement("textarea", { "data-composer": true })),
    }));
    mock.module("./ScopeFeed", () => ({ ScopeFeed: (props: any) => React.createElement("div", { "data-scope-feed": JSON.stringify(props.scope) }, "feed") }));
    mock.module("../../../app/tasks/page", () => ({ TaskListContent: () => React.createElement("div", { "data-task-list": true }, "tasks") }));
    mock.module("./ScopeSettings", () => ({ ScopeSettings: (props: any) => React.createElement("div", { "data-scope-settings": "1" }, "settings") }));
    mock.module("./ScopeLineTab", () => ({ ScopeLineTab: () => React.createElement("div", { "data-scope-line": true }) }));
    mock.module("./ScopeTriggersTab", () => ({ ScopeTriggersTab: () => React.createElement("div", { "data-scope-triggers": true }) }));
    mock.module("../../KeyboardShortcutsHelp", () => ({ ShortcutTooltip: ({ children }: any) => children, KeyCap: ({ children }: any) => React.createElement("kbd", null, children) }));
    mock.module("../../tasks/TaskCommentStream", () => ({ Avatar: ({ name }: any) => React.createElement("span", { "data-avatar": name }), TimeAgo: () => null, UserBadge: () => null, TaskCommentComposer: () => null, TaskCommentItem: () => null }));
    mock.module("../RoleFace", () => ({ RoleFace: ({ role }: any) => React.createElement("span", { "data-role-face": role.handle }) }));
    const realPill = { ...(await import("../../EntityIdPill")) };
    mock.module("../../EntityIdPill", () => ({ ...realPill, EntityIdPill: ({ id, shortId }: any) => React.createElement("span", { "data-pill": shortId ?? id }, shortId ?? id) }));
    mock.module("../history/OrgHistory", () => ({ OrgHistory: () => React.createElement("div", { "data-org-history": true }) }));
    mock.module("../TemplateSections", () => ({ TemplateSections: () => null }));
    mock.module("../../initiatives/ProjectInitiatives", () => ({ ProjectInitiatives: ({ projectId }: any) => React.createElement("span", { "data-project-initiatives": projectId }) }));
    mock.module("../../charter/ProjectLeadChip", () => ({ ProjectLeadChip: ({ projectId }: any) => React.createElement("span", { "data-project-lead-chip": projectId }), ProjectLeadMark: () => null, HireLeadDialog: () => null }));
    mock.module("../../../hooks/useProjectLead", () => ({ useProjectLead: () => ({ project: undefined, roles: null, lead: { kind: "none" }, otherWorkspace: false }) }));
    const realRetire = { ...(await import("../../../lib/retireRole")) };
    mock.module("../../../lib/retireRole", () => ({ ...realRetire, retireToastText: () => "retired" }));
    mock.module("../OrgScopePanel", () => ({ DocRow: () => null, InlineEdit: () => null }));
    mock.module("../../ConversationList", () => ({ AgentIcon: ({ agentType }: any) => React.createElement("i", { "data-agent": agentType }) }));
    mock.module("../../DocumentDetailLayout", () => ({ DocumentDetailLayout: () => null }));
    mock.module("../../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: any) => React.createElement("div", null, content), MarkdownBlocks: ({ content }: any) => React.createElement("div", null, content) }));
    mock.module("../../decisions/StackChecklist", () => ({ StackChecklist: () => null }));
    mock.module("../../decisions/DecisionCompactCard", () => ({ DecisionCompactCard: () => null }));
    return { React, act, mock, env, state, collections, calls, ORG_FIXTURE, T0 };
  })();
  return worldOnce;
}

async function verifyScopePage() {
  const { React, act, mock: _mock, env, state, collections, calls, ORG_FIXTURE, T0 } = await world();
  void _mock;
  const { createRoot } = await import("react-dom/client");
  const { ScopePageInner } = await import("./ScopePage");
  const { HandGroups } = await import("./ScopeTabs");
  let root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const text = () => document.body.textContent ?? "";
  const click = async (el: Element | null) => { assert.ok(el, "missing element"); await act(async () => { (el as HTMLElement).click(); }); };
  // A fresh mount per scenario: the panel's first state is decided at mount.
  const mount = async (id: string) => {
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(React.createElement(ScopePageInner, { id })));
  };
  const rerender = (id: string) => act(async () => root.render(React.createElement(ScopePageInner, { id })));

  // The fixture's growth role gets a standing session on the role itself
  // (org.tree stamps it from the conversation carrying standing_role_id).
  const growth = ORG_FIXTURE.roles[0];
  const withStanding: OrgTree = { ...ORG_FIXTURE, roles: [{ ...growth, counts: { ...growth.counts, needs_input: 2 } }] };
  env.tree = withStanding;
  // Three hands under the role wait on a person; they wait on the ROLE, and
  // none of them reaches the first screen or the header.
  const roleHand = (id: string) => ({ _id: id, org_role_id: growth._id, state: "needs_input" });
  const roleRows = () => ({
    "fixture-growth-conv": { _id: "fixture-growth-conv", standing_role_id: growth._id },
    [growth.sessions[0]._id]: roleHand(growth.sessions[0]._id),
    [growth.sessions[1]._id]: roleHand(growth.sessions[1]._id),
    [growth.sessions[2]._id]: roleHand(growth.sessions[2]._id),
  });
  state.sessions = roleRows();

  // ── wide: the conversation is the page, the board a column beside it ──
  await mount("or-1");
  assert.equal(q("[data-scope-layout]")!.getAttribute("data-scope-layout"), "side");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread"), "fixture-growth-conv", "the role's standing conversation is mounted inline");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-owner"), "1", "the host talks to the seat: the composer sends");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-fold"), "1", "the seat's provisioning prompt folds away");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-fold-working"), "1", "working turns and machine prompts fold away (F4.1)");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-density"), "condensed", "working turns fold to receipts");
  assert.match(q("[data-scope-lead]")!.textContent!, /I look after Growth, SEO and AI citations\./, "the agent opens by saying what this area is");
  assert.match(q("[data-scope-stripe]")!.textContent!, /Rewriting the weekly growth review/, "the header says what it is watching");
  assert.equal(q("[data-scope-lead-ask]"), null, "the lead never counts sessions waiting on a person: those wait on the role, which raises what it cannot answer in its own thread");
  for (const word of ["trust", "model", "today", "wakes", "tokens", "host"]) assert.ok(!qa("header *").some((el) => el.children.length === 0 && el.textContent?.trim().toLowerCase() === word), `the header no longer says ${word}`);
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-autofocus"), "1", "the composer comes to hand on a desktop");
  assert.ok(q("[data-composer]"), "the composer is Talk");
  assert.equal(qa("button").filter((b) => /^(Talk|Wake)$/.test(b.textContent?.trim() ?? "")).length, 0, "Talk and Wake left the header");
  assert.ok(q("[data-scope-reports-to]"), "the header keeps the reports to line");
  assert.equal(q("[data-scope-state]")!.getAttribute("data-scope-state"), "awake");
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "side", "the panel is open by default");
  // A role's page opens on Overview (org-roles-run-work.md R3): what it is
  // for, the briefing, its notes behind a fold, then what happened lately.
  assert.equal(q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"), "scope", "a role's page opens on Overview");
  assert.deepEqual(qa("[data-scope-tab]").map((el) => el.textContent), ["Overview", "Work", "Sessions", "Decisions", "Triggers", "Settings"], "a role has six tabs, in this order");
  assert.ok(q("[data-scope-briefing]"), "the Overview carries the briefing (F5.1)");
  assert.deepEqual(qa("[data-scope-briefing] [data-scope-section]").map((el) => el.getAttribute("data-scope-section")), ["doing"], "the sections with something to say, in order; this role has written no line yet, and sessions waiting on the role are not a section");
  assert.deepEqual(qa("[data-role-overview] > [data-scope-section]").map((el) => el.getAttribute("data-scope-section")), ["charter", "notes", "lately"], "what it is for above the briefing; its notes and the activity under it");
  assert.match(q("[data-role-charter]")!.textContent!, /Owns organic search, paid search and the weekly growth review\./, "the charter reads on the first screen");
  assert.equal(q('[data-scope-section="notes"]')!.hasAttribute("open"), false, "its notes stay folded until asked for");
  assert.ok(q('[data-scope-section="lately"] [data-scope-feed]'), "the activity is the Overview's last block, not a tab");
  assert.equal(q('[data-role-scope="page"]'), null, "the project cards, the session groups and the counts left the first screen");
  assert.equal(qa("[data-scope-tab-count]").length, 0, "and the tab strip carries no number");
  assert.equal(q("[data-scope-panel-dot]"), null, "the toggle carries no dot: what the role needs from the person is in its own thread");
  // Close and reopen from the header.
  await click(q("[data-scope-panel-toggle]"));
  assert.equal(q("[data-scope-aside]"), null, "closed");
  assert.equal(q("[data-scope-panel-toggle]")!.getAttribute("data-scope-panel-toggle"), "closed");
  assert.ok(q("[data-thread]"), "the conversation stays");
  await click(q("[data-scope-panel-toggle]"));
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "side");
  // The panel's own close.
  await click(q("[data-scope-panel-close]"));
  assert.equal(q("[data-scope-aside]"), null);
  // A tab click writes the URL, so the tab stays linkable.
  await click(q("[data-scope-panel-toggle]"));
  await click(q('[data-scope-tab="sessions"]'));
  assert.equal(calls.pop(), "replace:/org/or-1?tab=sessions");
  await click(q('[data-scope-tab="work"]'));
  assert.equal(calls.pop(), "replace:/org/or-1?tab=work");
  // The tab the page opens on is its bare URL.
  await click(q('[data-scope-tab="scope"]'));
  assert.equal(calls.pop(), "replace:/org/or-1");

  // ── narrow: the conversation leads; the board overlays it on demand ──
  env.wide = false;
  await mount("or-1");
  assert.equal(q("[data-scope-layout]")!.getAttribute("data-scope-layout"), "overlay");
  assert.equal(q("[data-scope-aside]"), null, "a narrow page opens on the conversation, not covered by the board");
  await click(q("[data-scope-panel-toggle]"));
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "overlay");
  assert.ok(q("[data-thread]"), "the conversation is still there under it");
  await click(q("[data-scope-panel-close]"));
  assert.equal(q("[data-scope-aside]"), null);

  // ── phone: the conversation leads; the panel is a sheet one tap away ──
  env.phone = true;
  await mount("or-1");
  assert.equal(q("[data-scope-layout]")!.getAttribute("data-scope-layout"), "sheet");
  assert.equal(q("[data-scope-aside]"), null, "the conversation leads on the phone");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-autofocus"), "0", "no keyboard pop on the phone");
  await click(q("[data-scope-panel-toggle]"));
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "sheet");
  assert.equal(q("[data-scope-panel-close]")!.getAttribute("aria-label"), "Back to the conversation");
  await click(q("[data-scope-panel-close]"));
  assert.equal(q("[data-scope-aside]"), null, "handed back to the conversation");
  // A link straight to a tab opens the sheet on it.
  env.qs = "tab=sessions";
  await mount("or-1");
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "sheet");
  assert.equal(q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"), "sessions");
  // A link written for a tab that moved lands on what it named: the tasks by
  // status are a view of Work, the role's notes and charter are on Overview.
  env.phone = false; env.wide = true;
  env.qs = "tab=line";
  await mount("or-1");
  assert.equal(q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"), "work");
  assert.ok(q("[data-scope-line]"), "the old Line tab is Work, by status");
  assert.deepEqual(qa("[data-work-view]").map((el) => el.textContent), ["Tasks", "By status", "Plans", "Pages"]);
  await click(q('[data-work-view="tasks"]'));
  assert.ok(q("[data-task-list]"), "Work opens its task list");
  env.qs = "tab=charter";
  await mount("or-1");
  assert.equal(q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"), "scope");
  // A role only tab is refused for the root and falls back to its activity.
  env.qs = "tab=brief";
  await mount("workspace");
  assert.equal(q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"), "feed");
  assert.deepEqual(qa("[data-scope-tab]").map((el) => el.textContent), ["Activity", "Work", "Sessions", "Decisions"], "the workspace has four tabs");
  env.qs = "";

  // ── the root: its agent's conversation; without one, the gesture is to hire the root role ──
  await mount("workspace");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread"), "fixture-anchor-conv");
  env.tree = { ...withStanding, anchors: [] };
  await mount("workspace");
  assert.equal(q("[data-thread]"), null);
  assert.equal(q("[data-anchor-onboarding]")!.getAttribute("data-anchor-onboarding"), "compact");
  env.tree = withStanding;

  // ── a plain member reads the seat's conversation; only the host, the parent or an admin sends ──
  env.tree = { ...withStanding, people: withStanding.people.map((p) => ({ ...p, is_me: false, role: "member" as const })) };
  state.currentUser = { _id: "fixture-user-sam" };
  await mount("or-1");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-owner"), "0", "a member who is neither host nor parent asks to send");
  state.currentUser = { _id: "fixture-user-me" };
  env.tree = withStanding;

  // ── a role that has not started: say what it is, offer to start it ──
  const unseated: OrgTree = { ...withStanding, roles: [{ ...growth, standing: null, anchor_id: undefined, counts: { ...growth.counts, needs_input: 0 } }] };
  env.tree = unseated;
  await mount("or-1");
  assert.equal(q("[data-thread]"), null, "no composer that goes nowhere");
  assert.equal(q("[data-composer]"), null);
  assert.ok(q("[data-scope-unseated]"));
  assert.match(text(), /Head of Growth has not started yet/);
  assert.match(text(), /Owns organic search, paid search and the weekly growth review\./, "the charter says what the area is");
  assert.match(text(), /It looks after Growth, SEO and AI citations\./);
  assert.match(text(), /reports to Ashot Petrosian/);
  assert.equal(q("[data-scope-state]"), null, "no state chip before it starts");
  assert.match(q("[data-scope-stripe]")!.textContent!, /Not started yet/);
  await click(q("[data-scope-provision]"));
  assert.ok(calls.some((c) => c === `mutation:{"role_id":"${growth._id}"}`), "the one gesture starts the role");
  assert.ok(q("[data-scope-aside]"), "the panel is still beside it");
  // A person who cannot reshape the role is told who can.
  env.tree = { ...unseated, people: unseated.people.map((p) => ({ ...p, is_me: false, role: "member" as const })) };
  state.currentUser = { _id: "fixture-user-sam" };
  await mount("or-1");
  assert.equal(q("[data-scope-provision]"), null);
  assert.match(q("[data-scope-ask-host]")!.textContent!, /Ask Ashot Petrosian to start it/);
  state.currentUser = { _id: "fixture-user-me" };
  env.tree = withStanding;

  // ── paused: the note above the composer, resume in one click ──
  env.tree = { ...withStanding, roles: [{ ...withStanding.roles[0], status: "paused" }] };
  await mount("or-1");
  assert.match(q("[data-chief-paused]")!.textContent!, /Head of Growth is paused: its triggers hold until you resume it\. Messages still reach it\./);
  await click(qa("[data-chief-paused] button")[0]);
  assert.equal(calls.pop(), `update:${growth._id}:{"status":"active"}`);
  env.tree = withStanding;

  // ── pause and retire are the header's menu; retire asks first, in one dialog ──
  await mount("or-1");
  const openMenu = () => act(async () => { q("[data-scope-actions]")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await openMenu();
  assert.deepEqual(qa("[data-scope-action]").map((el) => el.textContent), ["Pause role", "Retire role…"], "the same words wherever a role is paused or retired");
  await click(q('[data-scope-action="pause"]'));
  assert.equal(calls.pop(), `update:${growth._id}:{"status":"paused"}`);
  await openMenu();
  await click(q('[data-scope-action="retire"]'));
  assert.match(q("[data-retire-dialog]")!.textContent!, /Retire Head of Growth\?/);
  assert.match(q("[data-retire-dialog]")!.textContent!, /Roles under it report to Ashot Petrosian\. Its triggers are cancelled and its thread is kept\./, "what retiring does is said once, where it is confirmed");
  assert.ok(!calls.some((c) => c.startsWith("retire:")), "nothing is retired before the confirm");
  await click(q("[data-retire-submit]"));
  assert.deepEqual(calls.slice(-3), [`retire:${growth._id}:`, "toast:retired", "push:/org"]);

  // ── F4.3: the Sessions tab groups sessions by who acts next ──
  const hand = (i: number, state: OrgSession["state"], age: number, title: string): OrgSession => ({
    _id: `h${i}`, short_id: `jx7h${i}`, title, agent_type: "claude", state, updated_at: T0 - age, subagent_count: 0, is_anchor: false,
  });
  const rows = [
    hand(1, "working", 60_000, "Draft the release notes"),
    hand(2, "needs_input", 30 * 60_000, "Pick a CTA variant"),
    hand(3, "done", 3 * 3_600_000, "Fix the cold start"),
    hand(4, "dormant", 5 * 60_000, "Watch CI on main"),
    hand(5, "idle", 9 * 60_000, "Blank"),
    hand(6, "needs_input", 2 * 60_000, "Approve the schema"),
  ];
  state.sessions = {
    h1: { _id: "h1", thread_state: "Writing the 1.2 notes\nNext: screenshots", active_task_id: "t-notes" },
    h2: { _id: "h2", thread_state: "Blocked: pick A, B or C" },
  };
  collections.tasks = [
    { _id: "t-notes", short_id: "ct-10", title: "Release notes 1.2", status: "in_progress" },
    { _id: "t-notes-1", short_id: "ct-11", title: "Write", status: "done", parent_id: "t-notes" },
    { _id: "t-notes-2", short_id: "ct-12", title: "Screens", status: "open", parent_id: "t-notes" },
    { _id: "t-notes-3", short_id: "ct-13", title: "Dropped", status: "dropped", parent_id: "t-notes" },
    { _id: "t-cold", short_id: "ct-20", title: "Cold start", status: "done", conversation_ids: ["h3"] },
  ];
  const facts = [{ _id: "h4", short_id: "jx7h4", title: "Watch CI on main", state: "dormant", state_line: "Waiting on run 8841", state_status: "dormant", state_at: T0, updated_at: T0, task: null }];
  await act(async () => root.render(React.createElement(HandGroups, { rows, hands: facts as any, now: T0, onOpen: (s: OrgSession) => calls.push(`open:${s._id}`) })));
  assert.deepEqual(qa("[data-hand-group]").map((g) => g.getAttribute("data-hand-group")), ["needs_input", "done", "working", "dormant", "idle"], "the inbox's order");
  assert.deepEqual(qa("[data-hand-group] h3").map((h) => h.textContent), ["Needs input2", "Done1", "Working1", "Dormant1", "Idle1"], "each header carries its count");
  assert.deepEqual(qa('[data-hand-group="needs_input"] [data-hand]').map((r) => r.getAttribute("data-hand")), ["h2", "h6"], "a queue you clear reads oldest first");
  const line = (id: string) => q(`[data-hand="${id}"] [data-hand-line]`)!.textContent;
  assert.equal(line("h1"), "Writing the 1.2 notes", "the store's state line, first line only");
  assert.equal(line("h2"), "Blocked: pick A, B or C");
  assert.equal(line("h4"), "Waiting on run 8841", "the brief's facts stand in when the store has no row");
  assert.equal(line("h5"), "idle", "no line pinned: the state word");
  assert.equal(q('[data-hand="h1"] [data-hand-task]')!.getAttribute("data-hand-task"), "ct-10", "the session's own task pointer");
  assert.equal(q('[data-hand="h1"] [data-hand-progress]')!.getAttribute("data-hand-progress"), "1/2", "subtasks counted live; the dropped one for neither");
  assert.equal(q('[data-hand="h3"] [data-hand-task]')!.getAttribute("data-hand-task"), "ct-20", "a task listing the session binds it too");
  assert.equal(q('[data-hand="h3"] [data-hand-progress]'), null, "no subtasks, no counter");
  assert.match(q('[data-hand="h2"]')!.textContent!, /30m/, "the age");
  await click(q('[data-hand="h6"]'));
  assert.equal(calls.pop(), "open:h6");
  // The store's task pointer changes: the row follows in the same tick.
  state.sessions.h1.active_task_id = "t-cold";
  await act(async () => root.render(React.createElement(HandGroups, { rows: [...rows], hands: facts as any, now: T0, onOpen: () => {} })));
  assert.equal(q('[data-hand="h1"] [data-hand-task]')!.getAttribute("data-hand-task"), "ct-20");

  await act(async () => root.unmount());
  console.log("scope page as a conversation: ok");
}

test("the scope page mounts as a conversation in its three widths", verifyScopePage, 120_000);

// F5.4: the first screen holds exactly what the person reads, and nothing
// the board holds. The Calling lead's shape: two projects, six plans, 83
// tasks, 33 hands waiting on a person.
async function verifyFirstScreen() {
  const { React, act, env, state, collections, ORG_FIXTURE, T0 } = await world();
  const DAY = 86_400_000;
  const growth = ORG_FIXTURE.roles[0];
  const ROLE = "fixture-role-calling";
  const STANDING = "fixture-calling-conv";
  // 33 hands waiting on a person, 4 at work.
  const hands = Array.from({ length: 37 }, (_, i) => ({ _id: `calling-h${i}`, short_id: `jx7c${String(i).padStart(3, "0")}`, title: `Hand ${i}`, agent_type: "claude", state: i < 33 ? "needs_input" : "working", updated_at: T0 - (i + 1) * 60_000, subagent_count: 0, is_anchor: false, org_role_id: ROLE })) as any[];
  const calling = {
    ...growth,
    _id: ROLE, short_id: "or-7", name: "Calling lead", handle: "calling",
    scope: { project_ids: ["p-union", "p-market"], plan_ids: [] },
    scope_names: { projects: [{ id: "p-union", title: "Union goals", short_id: "pj-union" }, { id: "p-market", title: "Market growth", short_id: "pj-market" }], plans: [] },
    counts: { needs_input: 33, working: 4, done: 0, dormant: 0, idle: 0 },
    sessions: [...hands.slice(33), ...hands.slice(0, 4)], total: hands.length,
    standing: { conversation_id: STANDING, short_id: "jx7call", state: "working", state_line: "Filling the third market", state_status: "working", state_at: T0 - 600_000 },
  };
  const projects = [{ _id: "p-union", title: "Union goals", short_id: "pj-union", status: "active" }, { _id: "p-market", title: "Market growth", short_id: "pj-market", status: "active" }];
  const plans = Array.from({ length: 6 }, (_, i) => ({ _id: `pl${i}`, short_id: `pl-${i}`, title: `Plan ${i}`, status: "active", project_id: i < 3 ? "p-union" : "p-market" }));
  const tasks = Array.from({ length: 83 }, (_, i) => ({ _id: `t${i}`, short_id: `ct-${i}`, title: `Task ${i}`, status: i % 3 ? "open" : "done", project_id: i % 2 ? "p-union" : "p-market" }));
  env.tree = { ...ORG_FIXTURE, roles: [calling] } as OrgTree;
  env.summary = { scope: { project_ids: ["p-union", "p-market"], plan_ids: [] }, projects, plans: plans.map((p) => ({ ...p, updated_at: T0, progress: { total: 14, done: 6, in_progress: 2, open: 6 } })), tasks: { total: 83, open: 55, by_status: { open: 55, done: 28 }, by_priority: {} }, sessions: { needs_input: 33, working: 4, done: 0, dormant: 0, idle: 0, total: 37 }, decisions: { open: 5 }, overlaps: [], generated_at: T0 };
  state.sessions = {
    [STANDING]: { _id: STANDING, standing_role_id: ROLE },
    ...Object.fromEntries(hands.map((h) => [h._id, { _id: h._id, org_role_id: ROLE, state: h.state }])),
  };
  collections.projects = projects; collections.plans = plans; collections.tasks = tasks;

  const { createRoot } = await import("react-dom/client");
  const { ScopeOverviewTab } = await import("./ScopePanel");
  const root = createRoot(document.getElementById("root")!);
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  function Screen({ brief }: { brief: string | null }) {
    return React.createElement(ScopeOverviewTab, { role: calling as any, now: T0, narrative: brief, briefLoaded: true });
  }
  const render = (brief: string | null) => act(async () => root.render(React.createElement(Screen, { brief })));

  const today = new Date(T0).toISOString().slice(0, 10);
  const old = new Date(T0 - 12 * DAY).toISOString().slice(0, 10);
  await render(`Calling: two markets filled\n\n## Where it stands\n- Union goals: the page is written and waits on your read; nothing else moves until it ships. (${today})\n- pj-market: two markets are filled and the third waits on a lawyer. (${old})\n\n## Goals: Ashot\n1. A goal`);

  // Exactly: two project sentences, one activity line. The 33 hands waiting
  // on a person wait on the role and are nowhere on the first screen.
  assert.equal(q('[data-scope-section="needs-you"]'), null, "no needs-you block: the role raises what it cannot answer in its own thread");
  const stands = qa("[data-scope-briefing] [data-scope-stands]");
  assert.equal(stands.length, 2, "two project sentences");
  const union = q('[data-scope-stands="pj-union"]')!, market = q('[data-scope-stands="pj-market"]')!;
  assert.match(union.textContent!, /Union goals.*the page is written and waits on your read/);
  assert.equal(union.querySelector("[data-scope-stands-age]"), null, "a fresh line carries no age");
  assert.match(market.textContent!, /Market growth.*two markets are filled and the third waits on a lawyer/, "matched by the short id the role wrote");
  assert.equal(market.querySelector("[data-scope-stands-age]")!.getAttribute("data-scope-stands-age"), "12", "a line older than a week says how old it is");
  const doing = q("[data-scope-briefing] [data-scope-doing]")!;
  assert.match(doing.textContent!, /^4 sessions at work/, "one activity line");
  assert.ok(doing.querySelector('[data-pill="jx7c033"]'), "and the session it is on now, as a pill");
  // No digit outside those lines: no count of hands waiting, no task count,
  // no plan fraction, no progress bar.
  const briefing = q("[data-scope-briefing]")!.cloneNode(true) as HTMLElement;
  for (const el of [...briefing.querySelectorAll("[data-scope-stands-line], [data-scope-doing]")]) el.remove();
  assert.doesNotMatch(briefing.textContent!, /\d/, `no digit outside the lines: ${briefing.textContent}`);
  for (const word of ["waiting on a person", "plan", "task", "open", "done"]) assert.ok(!briefing.textContent!.toLowerCase().includes(word), `the first screen never says ${JSON.stringify(word)}`);

  // A role with no brief lines.
  await render(null);
  // Nothing to say is said by saying nothing: no empty sections, no placeholder lines.
  assert.equal(q('[data-scope-section="stands"]'), null);
  assert.equal(qa("[data-scope-briefing] [data-scope-stands-line]").length, 0);

  await act(async () => root.unmount());
  console.log("first screen: ok");
}

test("F5.4: the first screen holds two project sentences and one activity line, and no digit outside them", verifyFirstScreen, 120_000);
