// Mounts the proposal card (docs/architecture/org-staffing.md S24) in jsdom
// against stubbed store rows: a proposed proposal (a new role under the
// founder and a move onto it, drawn as a small tree with faces, Accept, Skip
// and Ask), an applied one (what happened, compactly), and a failed one
// (Retry, the note). Accept and Skip reach the page's own store actions with
// the seen stamp; Ask puts the proposal in the thread's composer.
// Run: bun test --timeout 120000 components/org/ProposalCard.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/" }));
mock.module("../RoutePane", () => ({ RoutePane: () => h("div", null, "page") }));
mock.module("../stage/SessionPane", () => ({ SessionPane: () => h("div", null, "session") }));
const realShortcuts = { ...(await import("../../shortcuts")) };
mock.module("../../shortcuts", () => ({ ...realShortcuts, hasOpenModal: () => false, isEditableTarget: () => false }));
mock.module("../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));
const realStage = { ...(await import("../../lib/stage")) };
mock.module("../../lib/stage", () => ({ ...realStage, canOpenBeside: () => true }));
const realOpenIntent = { ...(await import("../../lib/openIntent")) };
mock.module("../../lib/openIntent", () => ({ ...realOpenIntent, openIn() {} }));
// No server: every query is skipped or unanswered, so the rows below are the
// store's alone (the local-first seed the card paints from).
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}) }));
const noThrow = await import("../../hooks/useQueryNoThrow");
mock.module("../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }) }));
// The feeders are mounted by the card; here they report "served" without a
// subscription, and the tree comes from the store row seeded below.
const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
mock.module("../../hooks/useSyncOrgProposals", () => ({ ...realProposals, useSyncOrgProposal: (ref: string | null) => ({ ready: !!ref, missing: false }), useSyncOrgProposals: () => ({ ready: true, missing: false }) }));
const realTree = { ...(await import("../../hooks/useSyncOrgTree")) };
const { useInboxStore } = await import("../../store/inboxStore");
mock.module("../../hooks/useSyncOrgTree", () => ({ ...realTree, useSyncOrgTree: () => ({ tree: useInboxStore((s) => s.orgTree), ready: true, missing: false, refused: false, retry() {} }), useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry() {} }) }));

const { createRoot } = await import("react-dom/client");
const { ORG_FIXTURE } = await import("./orgFixture");
const { EntityObjectCard } = await import("../EntityObjectCard");
const { ReviewComposerContext } = await import("../reviewContext");

const AUTHOR = { kind: "role" as const, id: "role-cos", name: "Chief of Staff", handle: "chief-of-staff", short_id: "or-9", avatar: "fox" };
const proposal = (id: string, short_id: string, title: string, status: "open" | "resolved" = "open") =>
  ({ _id: id, short_id, team_id: "fixture-team", author: AUTHOR, title, summary_md: `Why ${title.toLowerCase()}.`, mode: "review", status, created_at: Date.now() - 600_000 });
const change = (id: string, proposal_id: string, seq: number, c: any, status: any = "proposed", extra: Record<string, unknown> = {}) =>
  ({ _id: id, proposal_id, seq, change: c, rationale: `Because ${id}.`, evidence: [], status, ...extra });

const ROLE = { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } };
const MOVE = { kind: "move", handle: "growth", reports_to: "@platform" };
const LIMIT = { kind: "budget", handle: "growth", caps: { wakes_per_day: 12, tokens_per_day: 800_000 } };

useInboxStore.setState({
  orgTree: ORG_FIXTURE,
  orgProposals: {
    p1: proposal("p1", "op-1", "Bring platform under one lead"),
    p2: proposal("p2", "op-2", "Growth reports to platform", "resolved"),
    p3: proposal("p3", "op-3", "A second attempt"),
    p4: proposal("p4", "op-4", "Keep growth within bounds"),
    p5: proposal("p5", "op-5", "Platform lead, within bounds"),
  },
  orgProposalChanges: {
    "c1-role": change("c1-role", "p1", 1, ROLE),
    "c1-move": change("c1-move", "p1", 2, MOVE),
    "c2-role": change("c2-role", "p2", 1, ROLE, "applied", { applied_at: Date.now() - 60_000 }),
    "c2-move": change("c2-move", "p2", 2, MOVE, "applied"),
    "c3-role": change("c3-role", "p3", 1, ROLE, "failed", { applied_note: "A role already answers to @platform" }),
    "c3-move": change("c3-move", "p3", 2, MOVE, "applied"),
    "c4-limit": change("c4-limit", "p4", 1, LIMIT, "proposed", { rationale: "Growth wakes 30 times a day." }),
    "c5-role": change("c5-role", "p5", 1, ROLE),
    "c5-limit": change("c5-limit", "p5", 2, LIMIT, "proposed", { rationale: "Platform gets 800k tokens." }),
  },
} as any);

// The verdicts are the store's own actions; here they record their arguments.
const calls: any[] = [];
const realActions = { acceptAllOrgProposal: useInboxStore.getState().acceptAllOrgProposal, decideOrgProposalChange: useInboxStore.getState().decideOrgProposalChange };
useInboxStore.setState({
  acceptAllOrgProposal: (...args: any[]) => calls.push(["accept", ...args]),
  decideOrgProposalChange: (...args: any[]) => calls.push(["decide", ...args]),
} as any);
afterAll(() => useInboxStore.setState(realActions as any));

const populated: string[] = [];
const composer = { quote() {}, submit() {}, populate: (text: string) => populated.push(text) };

function mount(ui: React.ReactNode) {
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(ui));
  return root;
}
const card = (ref: string) => h("div", { "data-card": ref }, h(EntityObjectCard, { refId: ref, count: 1 }));
const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const qa = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const click = (el: HTMLElement) => React.act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

test("a proposed proposal draws its tree with faces and its three verdicts", () => {
  const root = mount(h(ReviewComposerContext.Provider, { value: composer }, card("op-1")));
  const c = q("[data-card='op-1']");
  expect(c.querySelector(".entity-card")).not.toBeNull();
  expect(c.textContent).toContain("Bring platform under one lead");
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("2 of 2 to decide");
  expect(c.querySelector("[data-proposal-author='role']")!.textContent).toContain("Chief of Staff");

  // The tree: the new role under the founder, then the move onto it, with
  // where growth came from.
  const rows = Array.from(c.querySelectorAll<HTMLElement>("[data-tree-row]"));
  expect(rows.map((r) => r.getAttribute("data-tree-kind"))).toEqual(["role", "move"]);
  const groups = Array.from(c.querySelectorAll<HTMLElement>("[data-tree-group]"));
  expect(groups[0].querySelector("[data-tree-parent]")!.getAttribute("data-tree-parent")).toBe("fixture-user-me");
  expect(groups[0].querySelector("[data-tree-parent] [data-face='person']")).not.toBeNull();
  expect(rows[0].querySelector("[data-tree-node='role']")!.textContent).toContain("Head of Platform");
  expect(rows[0].querySelector("[data-ghost-tag='new role']")).not.toBeNull();
  expect(groups[1].querySelector("[data-tree-parent]")!.getAttribute("data-tree-parent")).toBe("c1-role");
  expect(rows[1].querySelector("[data-tree-node='role']")!.textContent).toContain("Head of Growth");
  expect(rows[1].querySelector("[data-ghost-tag='move']")).not.toBeNull();
  expect(rows[1].querySelector("[data-tree-from]")!.textContent).toContain("was under");
  expect(rows[1].querySelector("[data-tree-from]")!.textContent).toContain("Ashot Petrosian");
  // Faces are the chart's own: a role avatar, a person avatar.
  expect(c.querySelectorAll("[data-face='role']").length).toBeGreaterThanOrEqual(2);

  // Accept: the page's acceptAll with the seen stamp (every waiting seq).
  click(c.querySelector("[data-accept]")!);
  expect(calls.at(-1)).toEqual(["accept", "p1", { seen: { revised_at: 0, seqs: [1, 2] } }]);
  // Skip: one decide per waiting change, the same stamp.
  const before = calls.length;
  click(c.querySelector("[data-skip]")!);
  expect(calls.slice(before)).toEqual([
    ["decide", "c1-role", "skip", undefined, { revised_at: 0, seqs: [1, 2] }],
    ["decide", "c1-move", "skip", undefined, { revised_at: 0, seqs: [1, 2] }],
  ]);
  // Ask: the proposal goes into the thread's composer as the next message.
  click(c.querySelector("[data-ask-about]")!);
  expect(populated).toEqual(['About op-1 ("Bring platform under one lead"):\n\n']);
  // A verdict click never toggles the card open.
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe("false");
  React.act(() => root.unmount());
});

test("an applied proposal says what happened and offers only Ask", () => {
  const root = mount(card("op-2"));
  const c = q("[data-card='op-2']");
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("2 applied");
  expect(c.querySelector("[data-accept]")).toBeNull();
  expect(c.querySelector("[data-skip]")).toBeNull();
  expect(c.querySelector("[data-proposal-outcome]")!.textContent).toContain("2 applied");
  expect(qa("[data-card='op-2'] [data-tree-row]").map((r) => r.getAttribute("data-tree-status"))).toEqual(["applied", "applied"]);
  // The accepted move is drawn under the role it moved to, and the tag reads applied.
  expect(c.querySelectorAll("[data-tree-status='applied']").length).toBeGreaterThanOrEqual(2);
  // Without a composer in reach, Ask is the link to the proposal on the org page.
  expect(c.querySelector("[data-ask-about]")!.getAttribute("href")).toBe("/org?proposal=op-2");
  React.act(() => root.unmount());
});

test("a failed change keeps the card decidable: Retry, Skip and the note", () => {
  const root = mount(card("op-3"));
  const c = q("[data-card='op-3']");
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("1 failed");
  expect(c.querySelector("[data-accept]")!.textContent).toContain("Retry");
  expect(c.querySelector("[data-skip]")).not.toBeNull();
  expect(c.querySelector("[data-failed-note]")!.textContent).toContain("A role already answers to @platform");
  expect(c.querySelector("[data-tree-row='c3-role'] [data-status='failed']")).not.toBeNull();
  click(c.querySelector("[data-accept]")!);
  expect(calls.at(-1)).toEqual(["accept", "p3", { seen: { revised_at: 0, seqs: [1] } }]);
  React.act(() => root.unmount());
});

test("a limit never reaches the person: no row beside drawn changes, plain words when alone (S23.2)", () => {
  const root = mount(h("div", null, card("op-4"), card("op-5")));
  // Alone: one plain sentence naming the role, no unit, and the verdicts still apply.
  const alone = q("[data-card='op-4']");
  expect(alone.querySelector("[data-proposal-tree]")).toBeNull();
  expect(alone.querySelector("[data-proposal-quiet]")!.textContent).toContain("Head of Growth keeps a safety net on its daily work.");
  expect(alone.textContent).not.toMatch(/wakes|tokens|caps|limit/i);
  expect(alone.querySelector("[data-accept]")).not.toBeNull();
  // Beside a drawn change: nothing of it, no chip, no row, no words.
  const beside = q("[data-card='op-5']");
  expect(Array.from(beside.querySelectorAll("[data-tree-row]")).map((r) => r.getAttribute("data-tree-kind"))).toEqual(["role"]);
  expect(beside.querySelector("[data-proposal-quiet]")).toBeNull();
  expect(beside.textContent).not.toMatch(/wakes|tokens|caps|limit|safety net/i);
  expect(beside.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("2 of 2 to decide");
  // Expanded, the rationale of the quiet change stays out too.
  click(beside.querySelector(".entity-card")!);
  expect(beside.textContent).not.toMatch(/800k tokens/);
  expect(beside.querySelectorAll("[data-proposal-rationale] [data-change-row]").length).toBe(1);
  React.act(() => root.unmount());
});

test("an op id the store has never seen is a loading card, then not available once served", () => {
  const root = mount(card("op-404"));
  const c = q("[data-card='op-404']");
  // The feeder reports served and the store holds nothing: not available.
  expect(c.textContent).toContain("Not available to you");
  React.act(() => root.unmount());
});
