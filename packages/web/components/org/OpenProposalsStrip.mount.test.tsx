// The open proposals strip (docs/architecture/org-staffing.md S41) mounted in
// jsdom over rows the model builds: one line by default (the count, the
// changes, the answers staged), the rows behind its chevron that close after a
// pick, the breadcrumb for the current proposal and its x, the count and the
// answered words a row prints and the sentence it keeps for its hover, the
// foreign row's card under the line answering into the head's batch inside
// its own cap, the link line in its three kinds, and no section at all with
// nothing to show.
// Run: bun test --timeout 240000 components/org/OpenProposalsStrip.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
const { act } = React;
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
// The card is the cards worker's; here it echoes the batch the composer bridge hands it.
const { useReviewComposer } = await import("../reviewContext");
// Spread the real module: bun shares mock.module across files in one run, so
// a mock missing an export breaks a later file that imports it.
const realCard = { ...(await import("../EntityObjectCard")) };
mock.module("../EntityObjectCard", () => ({ ...realCard, EntityObjectCard: ({ refId }: { refId: string }) => h("div", { "data-card-stub": refId, "data-card-batch": useReviewComposer()?.conversationId ?? "" }) }));

const { createRoot } = await import("react-dom/client");
const { OpenProposalsStrip } = await import("./OpenProposalsStrip");
const { stripRows } = await import("./orgScreenModel");
const { OrgOpenContext } = await import("./company/orgOpenContext");
import type { NeedsYouItem } from "./staffingModel";
import type { OrgProposalRow } from "./orgStaffingTypes";
import type { PendingComment } from "../../lib/quoteFormat";

const AUTHOR = { kind: "role" as const, id: "role-head", name: "Head of People", handle: "head-of-people", short_id: "or-9", avatar: "owl" };
const HEAD = "fixture-head-conv";
const T0 = 1_700_000_000_000;
const NOW = T0 + 3 * 86_400_000;
const proposal = (n: number, extra: Partial<OrgProposalRow> = {}): OrgProposalRow => ({
  _id: `p${n}`, short_id: `op-${n}`, team_id: "fixture-team", author: AUTHOR, title: `Proposal ${n}`, summary_md: "", mode: "review", status: "open",
  created_at: T0 + n * 60_000, thread: { conversation_id: HEAD }, changes: [], counts: { total: 9, decided: 0, applied: 0, failed: 0, skipped: 0 }, ...extra,
});
const change = (proposal_id: string, seq: number, c: any) => ({ _id: `${proposal_id}-c${seq}`, proposal_id, seq, change: c, rationale: "", evidence: [], status: "proposed" as const });
const ROLE = { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } };
const answer = (id: string, proposalId: string, seq: number): PendingComment => ({ id, messageId: "", blockIndex: 0, quote: "", body: "", createdAt: T0, proposal: { id: proposalId, card: `role:${seq}`, verdict: "approve", change_ids: [`${proposalId}-c${seq}`], seqs: [seq] } } as any);

const open = [
  proposal(1, { changes: [change("p1", 1, ROLE)] }),
  proposal(2, { changes: [change("p2", 1, ROLE), change("p2", 2, ROLE)] }),
  proposal(3, { counts: { total: 9, decided: 9, applied: 9, failed: 0, skipped: 0 } }),
  proposal(4, { thread: { conversation_id: "other-conv" } }),
  proposal(5, { thread: undefined }),
];
const comments = [answer("a1", "p2", 1), answer("a2", "p2", 2)];

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const qa = (sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as HTMLElement[];

async function mount(props: Partial<React.ComponentProps<typeof OpenProposalsStrip>> = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const picked: string[] = [], events: string[] = [];
  const base: React.ComponentProps<typeof OpenProposalsStrip> = {
    rows: stripRows(open, HEAD, comments, NOW), current: null, expanded: null, batchConversationId: HEAD, linkLine: null,
    onPick: (row) => picked.push(row.proposal.short_id), onCollapse: () => events.push("collapse"), onClearCurrent: () => events.push("clear"), onSwitchWorkspace: (teamId) => events.push(`switch:${teamId}`),
  };
  const render = (next: Partial<React.ComponentProps<typeof OpenProposalsStrip>> = {}) => act(async () => { root.render(h(OpenProposalsStrip, { ...base, ...props, ...next })); });
  await render();
  return { el, render, picked, events, unmount: async () => { await act(async () => { root.unmount(); }); el.remove(); } };
}

test("one line by default: how many wait, the changes in all, the answers staged; the rows open on the chevron, oldest first, and close after a pick", async () => {
  const { el, picked, unmount } = await mount();
  expect(q("[data-org-strip]", el)!.getAttribute("data-org-strip")).toBe("5");
  expect(q("[data-org-strip-head]", el)!.textContent).toBe("5 wait on you: 5 proposals·2 answered, waiting for your send");
  expect(q("[data-org-strip-toggle]", el)!.getAttribute("aria-expanded")).toBe("false");
  expect(q("[data-org-strip-rows]", el)).toBeNull();
  expect(q("[data-org-strip]", el)!.hasAttribute("data-org-strip-open")).toBe(false);
  await act(async () => { q("[data-org-strip-toggle]", el)!.click(); });
  expect(q("[data-org-strip]", el)!.getAttribute("data-org-strip-open")).toBe("rows");
  expect(q("[data-org-strip-toggle]", el)!.getAttribute("aria-expanded")).toBe("true");
  expect(qa("[data-org-strip-row]", el).map((r) => r.getAttribute("data-org-strip-row"))).toEqual(["op-1", "op-2", "op-3", "op-4", "op-5"]);
  // Open, the rows scroll inside their cap (a share of the column; the viewport's while the column is not laid out).
  expect(q("[data-org-strip-rows]", el)!.className).toContain("overflow-y-auto");
  expect(q("[data-org-strip-rows]", el)!.style.maxHeight).toBe("38vh");
  // Waiting: the title and the count, nothing else on the row; the age in the hover.
  const waiting = q("[data-org-strip-row='op-1']", el)!;
  expect(waiting.getAttribute("data-org-strip-state")).toBe("waiting");
  expect(waiting.textContent).toBe("Proposal 11 to decide");
  expect(waiting.getAttribute("title")).toMatch(/^1 change · \S+ ago$/);
  // Answered: the staged count, in the proposal's colour.
  const answered = q("[data-org-strip-row='op-2']", el)!;
  expect(answered.getAttribute("data-org-strip-state")).toBe("answered");
  expect(answered.getAttribute("data-org-strip-answered")).toBe("2");
  expect(answered.textContent).toBe("Proposal 21 to decide2 answered");
  // Decided, from the list row's counts while its rows load: the hover says so, the row stays the count.
  const decided = q("[data-org-strip-row='op-3']", el)!;
  expect(decided.getAttribute("data-org-strip-state")).toBe("decided");
  expect(decided.textContent).toBe("Proposal 39 changes");
  expect(decided.getAttribute("title")).toContain("all 9 decided");
  // Foreign: another thread, or none.
  for (const id of ["op-4", "op-5"]) {
    const row = q(`[data-org-strip-row='${id}']`, el)!;
    expect(row.getAttribute("data-org-strip-foreign")).toBe("true");
    expect(q("[data-org-strip-foreign-words]", row)!.textContent).toBe("from another thread");
    expect(row.getAttribute("title")).toContain("from another thread");
  }
  expect(q("[data-org-strip-row='op-1']", el)!.getAttribute("data-org-strip-foreign")).toBeNull();
  // A pick closes the rows.
  await act(async () => { q("[data-org-strip-row='op-1']", el)!.click(); });
  expect(picked).toEqual(["op-1"]);
  expect(q("[data-org-strip-rows]", el)).toBeNull();
  expect(q("[data-org-strip]", el)!.hasAttribute("data-org-strip-open")).toBe(false);
  await unmount();
});

test("the breadcrumb names the current proposal and its x clears it; the current row is marked when the rows open; the chevron closes them again", async () => {
  const { el, events, render, unmount } = await mount({ current: "op-5" });
  const crumb = q("[data-org-strip-current]", el)!;
  expect(crumb.getAttribute("data-org-strip-current")).toBe("op-5");
  expect(crumb.textContent).toBe("·Proposal 5");
  // The chevron stays beside the crumb: the line still opens into rows.
  expect(q("[data-org-strip-chevron]", el)).not.toBeNull();
  expect(q("[data-org-strip-clear]", el)!.getAttribute("aria-label")).toBe("Leave Proposal 5");
  await act(async () => { q("[data-org-strip-clear]", el)!.click(); });
  expect(events).toEqual(["clear"]);
  await act(async () => { q("[data-org-strip-toggle]", el)!.click(); });
  expect(q("[data-org-strip-row='op-5']", el)!.getAttribute("aria-current")).toBe("true");
  expect(q("[data-org-strip-row='op-2']", el)!.getAttribute("aria-current")).toBeNull();
  await act(async () => { q("[data-org-strip-toggle]", el)!.click(); });
  expect(q("[data-org-strip-rows]", el)).toBeNull();
  // A current the rows do not hold draws no breadcrumb.
  await render({ current: "op-77" });
  expect(q("[data-org-strip-current]", el)).toBeNull();
  await unmount();
});

test("a foreign row's card opens under the line into the head's batch inside its own cap, with Close; the rows take its place while open; no batch draws it read only", async () => {
  const { el, events, render, unmount } = await mount({ current: "op-4", expanded: "op-4" });
  expect(q("[data-org-strip]", el)!.getAttribute("data-org-strip-open")).toBe("card");
  const card = q("[data-org-strip-expanded='op-4']", el)!;
  expect(card.textContent).toContain("Written by Head of People. Your answers go out with your next message here, and that thread is told.");
  expect(q("[data-card-stub]", card)!.getAttribute("data-card-stub")).toBe("op-4");
  expect(q("[data-card-stub]", card)!.getAttribute("data-card-batch")).toBe(HEAD);
  const scroll = q("[data-org-strip-card-scroll]", card)!;
  expect(scroll.className).toContain("overflow-y-auto");
  expect(scroll.style.maxHeight).toBe("min(50vh, 480px)");
  expect(q("[data-org-strip-rows]", el)).toBeNull();
  await act(async () => { q("[data-org-strip-collapse]", card)!.click(); });
  expect(events).toEqual(["collapse"]);
  // The rows, opened, stand in front of the card; closed again, the card is back.
  await act(async () => { q("[data-org-strip-toggle]", el)!.click(); });
  expect(q("[data-org-strip]", el)!.getAttribute("data-org-strip-open")).toBe("rows");
  expect(q("[data-org-strip-expanded]", el)).toBeNull();
  await act(async () => { q("[data-org-strip-toggle]", el)!.click(); });
  expect(q("[data-org-strip-expanded='op-4']", el)).not.toBeNull();
  // No batch to join: the card is read only.
  await render({ batchConversationId: null });
  expect(q("[data-card-stub]", el)!.getAttribute("data-card-batch")).toBe("");
  // The card gone from the props, the line stands alone.
  await render({ expanded: null });
  expect(q("[data-org-strip]", el)!.hasAttribute("data-org-strip-open")).toBe(false);
  await unmount();
});

test("the link line in its three kinds; Switch calls back with the team", async () => {
  const { el, events, render, unmount } = await mount({ rows: [], linkLine: { kind: "foreign", shortId: "op-77", workspaceName: "Union", teamId: "team-union" } });
  expect(q("[data-org-strip]", el)!.getAttribute("data-org-strip")).toBe("0");
  expect(q("[data-org-strip-head]", el)).toBeNull();
  const line = q("[data-org-link-line='foreign']", el)!;
  expect(line.textContent).toBe("op-77 is in Union.Switch");
  await act(async () => { (line.querySelector("button") as HTMLButtonElement).click(); });
  expect(events).toEqual(["switch:team-union"]);
  await render({ rows: [], linkLine: { kind: "unreadable", shortId: "op-77" } });
  expect(q("[data-org-link-line='unreadable']", el)!.textContent).toBe("op-77 is not a proposal you can read.");
  await render({ rows: [], linkLine: { kind: "loading", shortId: "op-77" } });
  expect(q("[data-org-link-line='loading']", el)!.textContent).toBe("Looking for op-77…");
  // Nothing to show: no section.
  await render({ rows: [], linkLine: null });
  expect(q("[data-org-strip]", el)).toBeNull();
  await unmount();
});

test("a lone proposal reads in the singular; no answers staged, no answered words", async () => {
  const { el, render, unmount } = await mount({ rows: stripRows([open[0]], HEAD, undefined, NOW) });
  expect(q("[data-org-strip-head]", el)!.textContent).toBe("1 waits on you: 1 proposal");
  expect(q("[data-org-strip-answered-line]", el)).toBeNull();
  await render({ rows: stripRows([open[0], proposal(6, { counts: undefined })], HEAD, undefined, NOW) });
  expect(q("[data-org-strip-head]", el)!.textContent).toBe("2 wait on you: 2 proposals");
  await unmount();
});

// What else waits on you (D7): a decision from the Growth lead's thread, one
// from the Head of People's, and the Calling lead stuck.
const role = (handle: string, name: string, short_id: string) => ({ _id: `role-${handle}`, short_id, handle, name, avatar: "owl" }) as any;
const GROWTH = role("growth", "Growth lead", "or-3");
const CALLING = role("calling", "Calling lead", "or-7");
const decision = (key: string, r: any, question: string, createdAt: number): NeedsYouItem => ({ kind: "decision", key, role: r, canAnswerInPlace: false, item: { key, source: "decide", conversationId: `${r.handle}-conv`, question, options: [], blocking: true, createdAt } as any });
const ASKS: NeedsYouItem[] = [
  decision("decide:1", GROWTH, "Move pj-k3x under in-2?", 1),
  decision("decide:2", role("head-of-people", "Head of People", "or-9"), "Which market goes first?", 2),
  { kind: "blocked", key: "blocked:calling", role: CALLING, conversationId: "calling-conv", line: "Needs the call list approved" },
];

test("the line counts every kind (4 wait on you: 2 proposals · 2 decisions · Calling lead is stuck); the rows list proposals, then decisions, then stuck roles; each ask opens what it is about", async () => {
  const opened: string[] = [];
  const { el, render, unmount } = await mount({ rows: stripRows(open.slice(0, 2), HEAD, undefined, NOW), asks: ASKS, holds: (ref) => ref === "pj-k3x", onOpen: (t) => opened.push(`${t.kind}:${t.ref}`) });
  expect(q("[data-org-strip]", el)!.getAttribute("data-org-strip")).toBe("5");
  expect(q("[data-org-strip-lead]", el)!.textContent).toBe("5 wait on you:");
  expect(qa("[data-org-strip-part]", el).map((p) => p.textContent)).toEqual(["2 proposals", "·2 decisions", "·Calling lead is stuck"]);
  // The dot takes the most pressing item's colour, and that item is drawn in it: a stuck role red, decisions yellow, proposals violet.
  const dot = q("[data-org-strip-dot]", el)!;
  expect(dot.getAttribute("data-org-strip-dot")).toBe("stuck");
  const tone = (kind: string) => (q(`[data-org-strip-part='${kind}'] .tabular-nums`, el)!).style.color;
  expect(dot.style.background).toBe(tone("stuck"));
  expect([tone("proposals"), tone("decisions"), tone("stuck")]).toEqual(["var(--sol-violet)", "var(--sol-yellow)", "var(--sol-red)"]);
  // The chevron sits in the toggle right after the words, not pushed to the far edge.
  const toggle = q("[data-org-strip-toggle]", el)!;
  expect(toggle.lastElementChild!.hasAttribute("data-org-strip-chevron")).toBe(true);
  expect(toggle.className).not.toContain("flex-1");
  await act(async () => { q("[data-org-strip-toggle]", el)!.click(); });
  const rows = q("[data-org-strip-rows]", el)!;
  expect(qa("[data-org-strip-row], [data-org-strip-ask]", rows).map((r) => r.getAttribute("data-org-strip-row") ?? r.getAttribute("data-org-strip-kind"))).toEqual(["op-1", "op-2", "decision", "decision", "blocked"]);
  const growth = q("[data-org-strip-ask='decide:1']", el)!;
  expect(growth.textContent).toBe("Move pj-k3x under in-2?asked by Growth leaddecision");
  const stuck = q("[data-org-strip-ask='blocked:calling']", el)!;
  expect(stuck.textContent).toBe("Calling lead is stuckNeeds the call list approvedstuck");
  // A decision citing a project the workspace holds opens the project; the rows close after the pick.
  await act(async () => { growth.click(); });
  expect(opened).toEqual(["project:pj-k3x"]);
  expect(q("[data-org-strip-rows]", el)).toBeNull();
  // One that cites nothing opens the role that asked; a stuck role opens its own sheet.
  await act(async () => { q("[data-org-strip-toggle]", el)!.click(); });
  await act(async () => { q("[data-org-strip-ask='decide:2']", el)!.click(); });
  await act(async () => { q("[data-org-strip-toggle]", el)!.click(); });
  await act(async () => { q("[data-org-strip-ask='blocked:calling']", el)!.click(); });
  expect(opened).toEqual(["project:pj-k3x", "role:or-9", "role:or-7"]);
  // Asks alone still draw the line, in the singular when one.
  await render({ rows: [], asks: [ASKS[2]] });
  expect(q("[data-org-strip-head]", el)!.textContent).toBe("1 waits on you: Calling lead is stuck");
  await unmount();
});

test("with no onOpen, an ask opens through the screen's OrgOpenContext", async () => {
  const opened: string[] = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const props: React.ComponentProps<typeof OpenProposalsStrip> = { rows: [], asks: [ASKS[2]], current: null, expanded: null, batchConversationId: HEAD, linkLine: null, onPick: () => {}, onCollapse: () => {}, onClearCurrent: () => {}, onSwitchWorkspace: () => {} };
  await act(async () => { root.render(h(OrgOpenContext.Provider, { value: { open: (kind: string, ref: string) => opened.push(`${kind}:${ref}`) } }, h(OpenProposalsStrip, props))); });
  await act(async () => { q("[data-org-strip-toggle]", el)!.click(); });
  await act(async () => { q("[data-org-strip-ask='blocked:calling']", el)!.click(); });
  expect(opened).toEqual(["role:or-7"]);
  await act(async () => { root.unmount(); });
  el.remove();
});
