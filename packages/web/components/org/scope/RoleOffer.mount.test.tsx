// The Head of People's offer, mounted in jsdom (org-staffing.md S24). Proves:
// the row renders only in the Head of People's own thread; it offers "Set up
// the org" before any proposal and "Review the org now" after, with "Plan
// the goal tree" beside it; each press is the store's one trigger verb (run
// now, the goal tree with its focus), never a second way to start a review;
// a run in flight shows its state and offers no second run; an open proposal
// is one click away; a reader who may not talk to the seat gets no run
// buttons; and the fake seam moves the row without dispatching anything.
// Run: bun test components/org/scope/RoleOffer.mount.test.tsx
import { test } from "bun:test";
import assert from "node:assert/strict";
import { realInboxStore, restoreInboxStoreAfterAll } from "../../__tests__/mockInboxStore";
import type { OrgTree } from "../orgTypes";

restoreInboxStoreAfterAll();

// The world imports the store's graph once; on a loaded machine that alone
// outlasts bun's default 5s.
const WORLD_TIMEOUT_MS = 180_000;

let worldOnce: Promise<any> | null = null;
function world() {
  worldOnce ??= (async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
    for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
      Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
    }
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const { mock } = await import("bun:test");
    const React = await import("react");
    const { act } = React;

    const { ORG_FIXTURE } = await import("../orgFixture");
    const { COMPANY_REVIEW_TITLE } = await import("@codecast/shared/contracts/orgReview");
    const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const SEAT = "conv-head-seat";
    const base = ORG_FIXTURE as OrgTree;
    const me = base.people.find((p) => p.is_me) ?? base.people[0];
    const head: any = { ...base.roles[0], _id: "role-head", short_id: "or-90", handle: "head-of-people", name: "Head of People", status: "active", reports_to: { kind: "user", user_id: me.user_id }, host_user_id: me.user_id, anchor_id: undefined, standing: { conversation_id: SEAT, state: "idle" } };
    const env = {
      tree: { ...base, roles: [head, ...base.roles] } as OrgTree,
      tasks: [] as any[],
      proposals: [] as any[],
      meId: String(me.user_id),
    };
    const calls: string[] = [];
    const state: any = {
      get currentUser() { return { _id: env.meId }; },
      triggerAction: (id: string, verb: string, focus?: string) => calls.push(`trigger:${id}:${verb}:${focus ?? ""}`),
    };
    const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });
    mock.module("../../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
    const realOrgTree = { ...(await import("../../../hooks/useSyncOrgTree")) };
    mock.module("../../../hooks/useSyncOrgTree", () => ({ ...realOrgTree, useSyncOrgTree: () => ({ tree: env.tree, ready: true, missing: false, refused: false, retry: () => {} }) }));
    const realTriggers = { ...(await import("../../../hooks/useSyncTriggers")) };
    mock.module("../../../hooks/useSyncTriggers", () => ({ ...realTriggers, useSeatTriggers: (id: string | null) => (id === SEAT ? env.tasks : []) }));
    const realProposals = { ...(await import("../../../hooks/useSyncOrgProposals")) };
    mock.module("../../../hooks/useSyncOrgProposals", () => ({ ...realProposals, useSyncOrgProposals: () => ({ ready: true, missing: false }) }));
    mock.module("../../../hooks/useCollectionRows", () => ({ useCollectionRows: (key: string, opts: any) => (key === "orgProposals" ? env.proposals.filter((p) => !opts?.where || opts.where(p)) : []) }));
    const realNow = { ...(await import("../../../hooks/useCoarseNow")) };
    mock.module("../../../hooks/useCoarseNow", () => ({ ...realNow, useCoarseNow: () => NOW }));
    mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
    mock.module("../RoleFace", () => ({ RoleFace: ({ role }: any) => React.createElement("span", { "data-role-face": role.handle }) }));
    const realPill = { ...(await import("../../EntityIdPill")) };
    mock.module("../../EntityIdPill", () => ({ ...realPill, EntityIdPill: ({ shortId }: any) => React.createElement("span", { "data-pill": shortId }, shortId) }));

    const { createRoot } = await import("react-dom/client");
    const { RoleOffer, fakeRoleOffer } = await import("./RoleOffer");
    const root = createRoot(dom.window.document.getElementById("root")!);
    const mount = async (conversationId: string | null = SEAT) => { await act(async () => { root.render(React.createElement(RoleOffer, { conversationId, key: Math.random() })); }); };
    const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null;
    const click = async (sel: string) => { await act(async () => { q(sel)!.click(); }); };
    const review = (over: any = {}) => ({ _id: "task-review", short_id: "tr-12", title: COMPANY_REVIEW_TITLE, status: "scheduled", originating_conversation_id: SEAT, run_at: NOW + 5 * 86_400_000, last_run_at: NOW - 2 * 86_400_000, ...over });
    const proposal = (over: any = {}) => ({ _id: "p1", short_id: "op-4", title: "Company review: Acme", status: "open", created_at: NOW - 86_400_000, team_id: env.tree.workspace.kind === "team" ? env.tree.workspace.id : undefined, scope_user_id: env.tree.workspace.kind === "user" ? env.tree.workspace.id : undefined, counts: { total: 5, decided: 2, applied: 0, failed: 0, skipped: 0 }, ...over });
    return { act, env, calls, mount, q, click, review, proposal, head, NOW, SEAT, fakeRoleOffer };
  })();
  return worldOnce;
}

test("renders only in the Head of People's own thread, and only with a live Company review", async () => {
  const w = await world();
  w.env.tasks = [w.review()]; w.env.proposals = [];
  await w.mount("conv-somebody-else");
  assert.equal(w.q("[data-role-offer]"), null, "another thread has no offer");
  w.env.tasks = [];
  await w.mount();
  assert.equal(w.q("[data-role-offer]"), null, "no routine, no offer");
  w.env.tasks = [w.review({ status: "cancelled" })];
  await w.mount();
  assert.equal(w.q("[data-role-offer]"), null, "a cancelled routine offers nothing");
}, WORLD_TIMEOUT_MS);

test("offers to set up, then to review; each press is the trigger's run now, the goal tree with its focus", async () => {
  const w = await world();
  w.env.tasks = [w.review()]; w.env.proposals = []; w.calls.length = 0;
  await w.mount();
  assert.equal(w.q("[data-role-offer]")!.getAttribute("data-role-offer"), "offer");
  assert.equal(w.q("[data-offer-action='set-up']")!.textContent, "Set up the org");
  assert.equal(w.q("[data-offer-action='review']"), null);
  assert.equal(w.q("[data-offer-open]"), null, "nothing to open yet");
  await w.click("[data-offer-action='set-up']");
  assert.deepEqual(w.calls, ["trigger:task-review:runNow:"]);

  w.env.proposals = [w.proposal({ status: "resolved" })]; w.calls.length = 0;
  await w.mount();
  assert.equal(w.q("[data-offer-action='review']")!.textContent, "Review the org now");
  assert.equal(w.q("[data-offer-action='goal-tree']")!.textContent, "Plan the goal tree");
  await w.click("[data-offer-action='goal-tree']");
  assert.deepEqual(w.calls, ["trigger:task-review:runNow:goal_tree"]);
}, WORLD_TIMEOUT_MS);

test("an open proposal is one click away, with what is left to decide", async () => {
  const w = await world();
  w.env.tasks = [w.review()]; w.env.proposals = [w.proposal()];
  await w.mount();
  const open = w.q("[data-offer-open='op-4']")!;
  assert.equal(open.getAttribute("href"), "/org?proposal=op-4");
  assert.match(open.textContent!, /Open the proposal/);
  assert.match(open.textContent!, /3 to decide/);
  // A proposal of another workspace is not this org's.
  w.env.proposals = [w.proposal({ team_id: "team-elsewhere", scope_user_id: undefined })];
  await w.mount();
  assert.equal(w.q("[data-offer-open]"), null);
  assert.ok(w.q("[data-offer-action='set-up']"), "and does not count as this org's set up");
}, WORLD_TIMEOUT_MS);

test("a run in flight shows its state and offers no second run", async () => {
  const w = await world();
  w.env.proposals = [w.proposal()];
  w.env.tasks = [w.review({ run_at: w.NOW - 5_000, requested_run_source: "manual", requested_run_focus: "goal_tree" })];
  await w.mount();
  assert.equal(w.q("[data-role-offer]")!.getAttribute("data-role-offer"), "starting");
  assert.match(w.q("[data-offer-run='starting']")!.textContent!, /Plan the goal tree: starting/);
  assert.ok(w.q("[data-pill='tr-12']"), "the run is the trigger's, named by its pill");
  assert.equal(w.q("[data-offer-action]"), null, "nothing here starts a second run");
  assert.ok(w.q("[data-offer-open='op-4']"), "the open proposal stays reachable");

  w.env.tasks = [w.review({ last_run_at: w.NOW - 4 * 60_000 })];
  w.env.tree = { ...w.env.tree, roles: w.env.tree.roles.map((r: any) => (r._id === "role-head" ? { ...r, standing: { ...r.standing, state: "working" } } : r)) };
  await w.mount();
  assert.equal(w.q("[data-role-offer]")!.getAttribute("data-role-offer"), "reviewing");
  assert.match(w.q("[data-offer-run='reviewing']")!.textContent!, /Reviewing the org…/);
  assert.match(w.q("[data-offer-run='reviewing']")!.textContent!, /4m/);
  assert.equal(w.q("[data-offer-action]"), null);
  w.env.tree = { ...w.env.tree, roles: w.env.tree.roles.map((r: any) => (r._id === "role-head" ? w.head : r)) };
}, WORLD_TIMEOUT_MS);

test("a paused review says so and resumes with the trigger's own verb", async () => {
  const w = await world();
  w.env.tasks = [w.review({ status: "paused" })]; w.env.proposals = []; w.calls.length = 0;
  await w.mount();
  assert.equal(w.q("[data-role-offer]")!.getAttribute("data-role-offer"), "paused");
  assert.equal(w.q("[data-offer-action='set-up']"), null);
  await w.click("[data-offer-action='resume']");
  assert.deepEqual(w.calls, ["trigger:task-review:resume:"]);
}, WORLD_TIMEOUT_MS);

test("a reader who may not talk to the seat sees the proposal and no run buttons", async () => {
  const w = await world();
  const stranger = "user-stranger";
  const tree = w.env.tree;
  w.env.tree = { ...tree, workspace: { ...tree.workspace, kind: "team" }, people: tree.people.map((p: any) => ({ ...p, is_me: false, role: "member" })) } as OrgTree;
  w.env.meId = stranger;
  w.env.tasks = [w.review()]; w.env.proposals = [w.proposal({ team_id: w.env.tree.workspace.id, scope_user_id: undefined })];
  await w.mount();
  assert.ok(w.q("[data-offer-open='op-4']"));
  assert.equal(w.q("[data-offer-action]"), null);
  w.env.tree = tree; w.env.meId = String((tree.people.find((p: any) => p.is_me) ?? tree.people[0]).user_id);
}, WORLD_TIMEOUT_MS);

test("the fake seam moves the row and dispatches nothing", async () => {
  const w = await world();
  w.env.tasks = [w.review()]; w.env.proposals = []; w.calls.length = 0;
  await w.mount();
  await w.act(async () => { w.fakeRoleOffer({ proposals: [w.proposal({ status: "resolved" })] }); });
  assert.ok(w.q("[data-offer-action='review']"), "the fake's proposals are what the row reads");
  await w.click("[data-offer-action='goal-tree']");
  assert.deepEqual(w.calls, [], "a press under a fake starts nothing");
  assert.equal(w.q("[data-role-offer]")!.getAttribute("data-role-offer"), "starting");
  await w.act(async () => { w.fakeRoleOffer(null); });
  assert.ok(w.q("[data-offer-action='set-up']"), "clearing the fake returns the row to the store");
}, WORLD_TIMEOUT_MS);
