// Waits on you mounted against a seeded store: the rail count and the list
// read one source and agree, the list draws one row per decision and per
// proposer with its one action, an inline option answers through the store,
// and the folded form says the count with Show.
// Run: bun test components/org/WaitsOnYouList.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { AVATAR_KEYS } = await import("@codecast/shared/contracts/orgAvatars");
const byKey = <T,>(f: (k: string) => T) => Object.fromEntries(AVATAR_KEYS.map((k) => [k, f(k)]));
mock.module("../../lib/orgAvatars", () => ({ AVATAR_URLS: byKey((k) => `/avatars/${k}.webp`), AVATAR_LABELS: byKey((k) => k), AVATAR_ART: byKey(() => () => null), avatarLength: (size: number | string) => (typeof size === "number" ? `${size}px` : size) }));

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/org", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let queue: any[] = [];
const realQueue = { ...(await import("../../hooks/useDecisionQueue")) };
mock.module("../../hooks/useDecisionQueue", () => ({ ...realQueue, useDecisionQueue: () => queue }));
const realFeatures = { ...(await import("../../lib/teamFeatures")) };
mock.module("../../lib/teamFeatures", () => ({ ...realFeatures, useWorkspaceFeature: () => true }));

const { createElement: h } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { ORG_FIXTURE_WITH_HEAD } = await import("./orgFixture");
const { ORG_STAFFING_FIXTURE_PROPOSAL } = await import("./orgStaffingFixture");
const { OrgNeedsYouBadge } = await import("./OrgNeedsYouBadge");
const { WaitsOnYou } = await import("./WaitsOnYouList");

afterAll(() => closeDomWindow(dom));

const TEAM = "k17fixtureteam0000000000000000aa";
const tree = { ...ORG_FIXTURE_WITH_HEAD, workspace: { ...ORG_FIXTURE_WITH_HEAD.workspace, id: TEAM } };
const listRow = (n: number) => {
  const { changes: _c, ...rest } = ORG_STAFFING_FIXTURE_PROPOSAL;
  return { ...rest, _id: `p${n}`, short_id: `op-${n}`, title: `Proposal ${n}`, team_id: TEAM, created_at: n, counts: { total: 2, decided: 0, applied: 0, failed: 0, skipped: 0 } };
};
const decision = { key: "decide:sd1", source: "decide", conversationId: "fixture-growth-conv", question: "Keep the spring ads running?", options: [{ label: "Yes" }, { label: "No" }], blocking: true, createdAt: Date.now() - 35 * 60_000, decisionId: "sd1" };

const answered: unknown[] = [];
function seed() {
  queue = [decision];
  useInboxStore.setState({
    orgTree: tree,
    orgProposals: { p1: listRow(1), p2: listRow(2), p3: listRow(3) },
    orgProposalChanges: {},
    // A stale snapshot that once said Growth waits on you: it must add nothing.
    orgHealth: { roles: [{ role_id: tree.roles[0]._id, area: { status: "waiting_on_you", status_line: "Waiting on you: stale" }, flags: [] }], people: [], company: { flags: [] } },
    currentUser: { _id: "u-me" },
    clientState: { ...useInboxStore.getState().clientState, ui: { ...(useInboxStore.getState().clientState?.ui ?? {}), active_team_id: TEAM } },
    answerDecision: (id: string, answer: unknown) => { answered.push([id, answer]); queue = []; return undefined as any; },
  } as any);
}

async function mount(node: any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(node); });
  return { host, rerender: async (n: any) => act(async () => { root.render(n); }), unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

test("the rail count and the list agree: one decision, one proposer's three proposals, nothing from a stale snapshot", async () => {
  seed();
  const opened: unknown[] = [];
  const list = await mount(h(WaitsOnYou, { onOpen: (t: unknown) => opened.push(t) }));
  const badge = await mount(h(OrgNeedsYouBadge));
  const rows = [...list.host.querySelectorAll("[data-wait-row]")];
  expect(rows.map((r) => r.getAttribute("data-wait-kind"))).toEqual(["decision", "proposals"]);
  expect(badge.host.querySelector("[data-org-nav-count]")!.getAttribute("data-org-nav-count")).toBe("2");
  expect(list.host.querySelector("[data-waits-on-you]")!.getAttribute("data-waits-on-you")).toBe("2");
  expect(rows[0].textContent).toContain("Head of Growth asks: Keep the spring ads running?");
  expect(rows[0].textContent).toContain("35m");
  expect(rows[1].textContent).toContain("Head of People proposes 3 changes: Proposal 1, and 2 more");
  // One action per row; Review opens the oldest proposal.
  (rows[1].querySelector("[data-wait-action='review']") as HTMLButtonElement).click();
  expect(opened).toEqual([{ kind: "proposal", id: "op-1" }]);
  // No dismiss anywhere.
  expect(list.host.textContent).not.toMatch(/dismiss|clear/i);
  await list.unmount();
  await badge.unmount();
});

test("an inline option answers through the store, and the row leaves", async () => {
  seed();
  answered.length = 0;
  const list = await mount(h(WaitsOnYou, { onOpen: () => {} }));
  const yes = list.host.querySelector("[data-wait-option='0']") as HTMLButtonElement;
  expect(yes.textContent).toBe("Yes");
  await act(async () => { yes.click(); });
  expect(answered).toEqual([["sd1", { index: 0 }]]);
  await list.rerender(h(WaitsOnYou, { onOpen: () => {}, folded: false }));
  expect([...list.host.querySelectorAll("[data-wait-row]")].map((r) => r.getAttribute("data-wait-kind"))).toEqual(["proposals"]);
  await list.unmount();
});

test("folded, the list is one line with the count and Show; nothing at all when nothing waits", async () => {
  seed();
  const list = await mount(h(WaitsOnYou, { onOpen: () => {}, folded: true }));
  expect(list.host.querySelector("[data-waits-folded]")!.textContent).toContain("2 wait on you");
  expect(list.host.querySelector("[data-wait-row]")).toBeNull();
  await act(async () => { (list.host.querySelector("[data-waits-show]") as HTMLButtonElement).click(); });
  expect(list.host.querySelectorAll("[data-wait-row]").length).toBe(2);
  queue = [];
  await act(async () => { useInboxStore.setState({ orgProposals: {} } as any); });
  expect(list.host.innerHTML).toBe("");
  await list.unmount();
});
