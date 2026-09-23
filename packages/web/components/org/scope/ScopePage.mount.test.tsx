// The scope page as a conversation (docs/architecture/scopes-and-feed.md
// F4), mounted in jsdom against the org fixture. Proves: the page opens as
// the role's standing conversation with the board beside it, in its three
// widths (a column, an overlay, a phone sheet); the header's control closes
// and reopens the panel and carries the dot when the role put something in
// front of the person (F5); the Scope tab is the three block briefing of F5.1
// and holds no number outside its own lines (F5.4);
// Talk and Wake are gone from the header; a link straight to a tab opens the
// panel on it; a seat with no standing agent says what it is and offers the
// one gesture; the root without an anchor offers to create one; and the
// Sessions tab groups hands by who acts next with the inbox's order, a state
// line, an age and live subtask counts.
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
    for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
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
      reparentOrgRole: () => {}, retireOrgRole: () => {},
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
      useRoleWakes: () => ({ data: undefined, missing: false }),
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
    mock.module("./ScopeSettings", () => ({ ScopeSettings: (props: any) => React.createElement("div", { "data-scope-settings": props.armRetire ? "armed" : "idle" }, "settings") }));
    mock.module("./ScopeLineTab", () => ({ ScopeLineTab: () => React.createElement("div", { "data-scope-line": true }) }));
    mock.module("./ScopeWakesTab", () => ({ ScopeWakesTab: () => React.createElement("div", { "data-scope-wakes": true }) }));
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
    mock.module("../../../lib/retireRole", () => ({ retireToastText: () => "retired" }));
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
  // Two hands the role put in front of the person (R1, revised), read off
  // the store's rows by the inbox's own helper; a third waits unescalated
  // and must never reach the first screen.
  const escalated = (id: string, line: string, at: number, extra: Record<string, any> = {}) => ({ _id: id, org_role_id: growth._id, state: "needs_input", escalated_by_role: { role_id: growth._id, line, at }, ...extra });
  const roleRows = () => ({
    "fixture-growth-conv": { _id: "fixture-growth-conv", standing_role_id: growth._id },
    [growth.sessions[0]._id]: escalated(growth.sessions[0]._id, "Pick the pricing page's headline: A reads safer, B tests better", T0 - 3_600_000),
    [growth.sessions[1]._id]: escalated(growth.sessions[1]._id, "The ads budget needs a yes before Monday", T0 - 600_000),
    [growth.sessions[2]._id]: { _id: growth.sessions[2]._id, org_role_id: growth._id, state: "needs_input" },
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
  assert.match(q("[data-scope-lead]")!.textContent!, /I look after Growth, SEO and AI citations and report to Ashot Petrosian/, "the agent opens by saying what this area is");
  assert.match(q("[data-scope-stripe]")!.textContent!, /Rewriting the weekly growth review/, "the header says what it is watching");
  assert.match(q("[data-scope-lead-ask]")!.textContent!, /2 things need you/, "and what the role put in front of them, never a count of sessions waiting");
  for (const word of ["trust", "model", "today", "wakes", "tokens", "host"]) assert.ok(!qa("header *").some((el) => el.children.length === 0 && el.textContent?.trim().toLowerCase() === word), `the header no longer says ${word}`);
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-autofocus"), "1", "the composer comes to hand on a desktop");
  assert.ok(q("[data-composer]"), "the composer is Talk");
  assert.equal(qa("button").filter((b) => /^(Talk|Wake)$/.test(b.textContent?.trim() ?? "")).length, 0, "Talk and Wake left the header");
  assert.ok(q("[data-scope-reports-to]"), "the header keeps the reports to line");
  assert.equal(q("[data-scope-state]")!.getAttribute("data-scope-state"), "awake");
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "side", "the panel is open by default");
  // A role's page opens on Scope (org-roles-run-work.md R3): what it looks
  // after, at full size, before any feed.
  assert.equal(q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"), "scope", "a role's page opens on Scope");
  assert.equal(qa("[data-scope-tab]")[0].getAttribute("data-scope-tab"), "scope", "and Scope is the first tab");
  assert.ok(q("[data-scope-briefing]"), "the Scope tab is the briefing (F5.1)");
  assert.equal(q("[data-scope-feed]"), null, "the feed waits behind its tab");
  assert.deepEqual(qa("[data-scope-briefing] [data-scope-section]").map((el) => el.getAttribute("data-scope-section")), ["needs-you", "stands", "doing"], "three questions, in that order");
  assert.equal(qa("[data-scope-briefing] [data-role-escalation]").length, 2, "what needs you: the two escalations, never the third hand that only waits");
  assert.equal(q('[data-role-scope="page"]'), null, "the project cards, the hand groups and the counts left the first screen");
  assert.equal(qa("[data-scope-tab]").length, 12, "every tab survives");
  assert.equal(qa("[data-scope-tab-count]").length, 0, "and the tab strip carries no number");
  // The dot: the role put two things in front of the person.
  assert.equal(q("[data-scope-panel-toggle]")!.getAttribute("data-scope-needs-you"), "2");
  assert.ok(q("[data-scope-panel-dot]"), "the toggle carries the dot");
  // Close and reopen from the header.
  await click(q("[data-scope-panel-toggle]"));
  assert.equal(q("[data-scope-aside]"), null, "closed");
  assert.equal(q("[data-scope-panel-toggle]")!.getAttribute("data-scope-panel-toggle"), "closed");
  assert.ok(q("[data-scope-panel-dot]"), "a closed panel still tells you a hand waits");
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
  await click(q('[data-scope-tab="feed"]'));
  assert.equal(calls.pop(), "replace:/org/or-1?tab=feed");
  // The tab the page opens on is its bare URL.
  await click(q('[data-scope-tab="scope"]'));
  assert.equal(calls.pop(), "replace:/org/or-1");

  // No dot when the role put nothing in front of the person, however many
  // of its hands wait on it.
  state.sessions = { "fixture-growth-conv": { _id: "fixture-growth-conv", standing_role_id: growth._id }, [growth.sessions[2]._id]: { _id: growth.sessions[2]._id, org_role_id: growth._id, state: "needs_input" } };
  await rerender("or-1");
  assert.equal(q("[data-scope-panel-dot]"), null);
  assert.match(q("[data-scope-lead-ask]")!.textContent!, /Nothing needs you\./);
  state.sessions = roleRows();

  // ── narrow: the panel overlays the conversation ──
  env.wide = false;
  await mount("or-1");
  assert.equal(q("[data-scope-layout]")!.getAttribute("data-scope-layout"), "overlay");
  assert.equal(q("[data-scope-aside]")!.getAttribute("data-scope-aside"), "overlay", "open by default on a narrow desktop too");
  assert.ok(q("[data-thread]"), "the conversation is still there under it");
  await click(q("[data-scope-panel-close]"));
  assert.equal(q("[data-scope-aside]"), null);

  // ── phone: the conversation leads; the panel is a sheet one tap away ──
  env.phone = true;
  await mount("or-1");
  assert.equal(q("[data-scope-layout]")!.getAttribute("data-scope-layout"), "sheet");
  assert.equal(q("[data-scope-aside]"), null, "the conversation leads on the phone");
  assert.equal(q("[data-thread]")!.getAttribute("data-thread-autofocus"), "0", "no keyboard pop on the phone");
  assert.ok(q("[data-scope-panel-dot]"), "the dot rides the compact toggle");
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
  // A role only tab is refused for the root and falls back to the feed.
  env.qs = "tab=brief";
  env.phone = false; env.wide = true;
  await mount("workspace");
  assert.equal(q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"), "feed");
  assert.equal(qa("[data-scope-tab]").length, 7, "the root has no role only tabs");
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

  // ── a seat never provisioned: say what it is, offer to bring it online ──
  const unseated: OrgTree = { ...withStanding, roles: [{ ...growth, standing: null, anchor_id: undefined, counts: { ...growth.counts, needs_input: 0 } }] };
  env.tree = unseated;
  await mount("or-1");
  assert.equal(q("[data-thread]"), null, "no composer that goes nowhere");
  assert.equal(q("[data-composer]"), null);
  assert.ok(q("[data-scope-unseated]"));
  assert.match(text(), /Head of Growth is not online yet/);
  assert.match(text(), /Owns organic search, paid search and the weekly growth review\./, "the charter says what the area is");
  assert.match(text(), /It covers Growth, SEO and AI citations\./);
  assert.match(text(), /reports to Ashot Petrosian/);
  assert.equal(q("[data-scope-state]"), null, "no state chip without a standing agent");
  assert.match(q("[data-scope-stripe]")!.textContent!, /Not online yet/);
  await click(q("[data-scope-provision]"));
  assert.ok(calls.some((c) => c === `mutation:{"role_id":"${growth._id}"}`), "the one gesture provisions the role");
  assert.ok(q("[data-scope-aside]"), "the board is still beside it");
  // A person who cannot reshape the role is told who can.
  env.tree = { ...unseated, people: unseated.people.map((p) => ({ ...p, is_me: false, role: "member" as const })) };
  state.currentUser = { _id: "fixture-user-sam" };
  await mount("or-1");
  assert.equal(q("[data-scope-provision]"), null);
  assert.match(q("[data-scope-ask-host]")!.textContent!, /Ask Ashot Petrosian to bring it online/);
  state.currentUser = { _id: "fixture-user-me" };
  env.tree = withStanding;

  // ── paused: the note above the composer, resume in one click ──
  env.tree = { ...withStanding, roles: [{ ...withStanding.roles[0], status: "paused" }] };
  await mount("or-1");
  assert.match(q("[data-chief-paused]")!.textContent!, /Head of Growth is paused: what you send waits until you resume it/);
  await click(qa("[data-chief-paused] button")[0]);
  assert.equal(calls.pop(), `update:${growth._id}:{"status":"active"}`);
  env.tree = withStanding;

  // ── Retire from the header lands on Settings, armed, with the panel open ──
  await mount("or-1");
  await click(q("[data-scope-panel-close]"));
  await click(qa("button").find((b) => b.textContent?.trim() === "Retire")!);
  assert.equal(calls.pop(), "replace:/org/or-1?tab=settings");
  env.qs = "tab=settings";
  await rerender("or-1");
  assert.equal(q("[data-scope-settings]")!.getAttribute("data-scope-settings"), "armed");
  env.qs = "";

  // ── F4.3: the Sessions tab groups hands by who acts next ──
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
// tasks, 33 hands waiting on a person, two escalations.
async function verifyFirstScreen() {
  const { React, act, env, state, collections, ORG_FIXTURE, T0 } = await world();
  const DAY = 86_400_000;
  const growth = ORG_FIXTURE.roles[0];
  const ROLE = "fixture-role-calling";
  const STANDING = "fixture-calling-conv";
  // 33 hands waiting on a person, 4 at work, 2 of the waiting ones escalated.
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
  state.sessions["calling-h5"].escalated_by_role = { role_id: ROLE, line: "Which lawyer signs the third market: ours is slow, theirs is dear", at: T0 - 2 * 3_600_000 };
  state.sessions["calling-h9"].escalated_by_role = { role_id: ROLE, line: "The Union goals page needs your read before it ships", at: T0 - 20 * 60_000 };
  collections.projects = projects; collections.plans = plans; collections.tasks = tasks;

  const { createRoot } = await import("react-dom/client");
  const { ScopeOverviewTab } = await import("./ScopePanel");
  const { useRoleEscalations } = await import("../../../hooks/useRoleEscalations");
  const root = createRoot(document.getElementById("root")!);
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  function Screen({ brief }: { brief: string | null }) {
    const escalations = useRoleEscalations(ROLE, STANDING);
    return React.createElement(ScopeOverviewTab, { role: calling as any, now: T0, canEdit: true, escalations, narrative: brief, briefLoaded: true });
  }
  const render = (brief: string | null) => act(async () => root.render(React.createElement(Screen, { brief })));

  const today = new Date(T0).toISOString().slice(0, 10);
  const old = new Date(T0 - 12 * DAY).toISOString().slice(0, 10);
  await render(`Calling: two markets filled\n\n## Where it stands\n- Union goals: the page is written and waits on your read; nothing else moves until it ships. (${today})\n- pj-market: two markets are filled and the third waits on a lawyer. (${old})\n\n## Goals: Ashot\n1. A goal`);

  // Exactly: two escalation lines, two project sentences, one activity line.
  const lines = qa("[data-scope-briefing] [data-role-escalation]");
  assert.equal(lines.length, 2, "two escalation lines");
  assert.deepEqual(lines.map((l) => l.getAttribute("data-role-escalation")), ["calling-h9", "calling-h5"], "newest first");
  assert.match(lines[0].textContent!, /The Union goals page needs your read before it ships/);
  assert.ok(lines[0].querySelector('[data-pill="calling-h9"]'), "each with its session pill");
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
  for (const el of [...briefing.querySelectorAll("[data-role-escalation], [data-scope-stands-line], [data-scope-doing]")]) el.remove();
  assert.doesNotMatch(briefing.textContent!, /\d/, `no digit outside the lines: ${briefing.textContent}`);
  for (const word of ["waiting on a person", "plan", "task", "open", "done"]) assert.ok(!briefing.textContent!.toLowerCase().includes(word), `the first screen never says ${JSON.stringify(word)}`);

  // A role with no escalations and no brief lines.
  for (const id of ["calling-h5", "calling-h9"]) delete state.sessions[id].escalated_by_role;
  await render(null);
  assert.equal(q("[data-scope-needs-nothing]")!.textContent, "Nothing needs you.");
  assert.equal(qa("[data-scope-briefing] [data-role-escalation]").length, 0);
  assert.deepEqual(qa("[data-scope-briefing] [data-scope-stands-line]").map((el) => el.textContent), ["no word from @calling yet", "no word from @calling yet"]);

  await act(async () => root.unmount());
  console.log("first screen: ok");
}

test("F5.4: the first screen holds two escalation lines, two project sentences and one activity line, and no digit outside them", verifyFirstScreen, 120_000);
