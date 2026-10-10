// Mounts the proposal card (docs/architecture/org-staffing.md S24, S39) in
// jsdom against stubbed store rows: a proposed proposal (a new role under the
// founder and a move onto it, drawn as two entries with their own Approve,
// Reject and Reply and a foot with Map and Approve the rest), an applied one
// (what happened, in words), and a failed one (Retry, the note). An answer
// joins the pending batch of the conversation whose composer is in reach and
// decides nothing; the controls give way to a band until the composer sends.
// Run: bun test --timeout 240000 components/org/ProposalCard.mount.test.tsx
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
// A clamp asks scrollHeight; jsdom answers 0. Twenty pixels a line, ninety characters to a line.
Object.defineProperty(dom.window.Element.prototype, "scrollHeight", { configurable: true, get() { return Math.ceil(((this as Element).textContent?.length ?? 0) / 90) * 20; } });
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
const { OrgHoverContext } = await import("./proposalContexts");

const AUTHOR = { kind: "role" as const, id: "role-cos", name: "Head of People", handle: "head-of-people", short_id: "or-9", avatar: "fox" };
const proposal = (id: string, short_id: string, title: string, status: "open" | "resolved" = "open", summary_md = `Why ${title.toLowerCase()}.`) =>
  ({ _id: id, short_id, team_id: "fixture-team", author: AUTHOR, title, summary_md, mode: "review", status, created_at: Date.now() - 600_000 });
const change = (id: string, proposal_id: string, seq: number, c: any, status: any = "proposed", extra: Record<string, unknown> = {}) =>
  ({ _id: id, proposal_id, seq, change: c, rationale: `Because ${id}.`, evidence: [], status, ...extra });

const ROLE = { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } };
const MOVE = { kind: "move", handle: "growth", reports_to: "@platform" };
const LIMIT = { kind: "budget", handle: "growth", caps: { wakes_per_day: 12, tokens_per_day: 800_000 } };
// A letter past four lines: the lead folds and "Read the rest" opens the whole of it.
const LONG_LETTER = `${"Platform work is spread over four people and nobody owns the week. ".repeat(14).trim()}\n\nThe rest of the letter names the sessions this would move.`;

useInboxStore.setState({
  orgTree: ORG_FIXTURE,
  orgProposals: {
    p1: proposal("p1", "op-1", "Bring platform under one lead"),
    // The whole-proposal note the person sent with their approvals, stored on the row (S39).
    p2: { ...proposal("p2", "op-2", "Growth reports to platform", "resolved"), reply: { verdict: "note", text: "Do the plans next", at: Date.now() - 60_000, by: "user-1" } },
    p3: proposal("p3", "op-3", "A second attempt"),
    p4: proposal("p4", "op-4", "Keep growth within bounds"),
    p5: proposal("p5", "op-5", "Platform lead, within bounds"),
    p7: proposal("p7", "op-7", "Platform, landing"),
    p8: proposal("p8", "op-8", "A long letter", "open", LONG_LETTER),
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
    // The limit rides on the role this proposal creates.
    "c5-limit": change("c5-limit", "p5", 2, { ...LIMIT, handle: "platform" }, "proposed", { rationale: "Platform gets 800k tokens." }),
    "c7-role": change("c7-role", "p7", 1, ROLE, "accepted"),
    "c7-move": change("c7-move", "p7", 2, MOVE, "accepted"),
    "c8-role": change("c8-role", "p8", 1, ROLE),
  },
} as any);

// A press decides nothing: the old direct verdict actions record any call, and every test expects none.
const calls: any[] = [];
const realActions = { replyOnOrgProposal: useInboxStore.getState().replyOnOrgProposal };
useInboxStore.setState({
  replyOnOrgProposal: (...args: any[]) => calls.push(["reply", ...args]),
} as any);
afterAll(() => useInboxStore.setState(realActions as any));

// The conversation's composer: the batch's key.
const CONV = "conv-1";
const composer = { quote() {}, submit() {}, populate() {}, conversationId: CONV, canSend: true, send: () => {} };
// The same conversation read by someone whose composer is not there (a guest, a non-owner): the bridge carries the id and no send.
const readOnlyComposer = { quote() {}, submit() {}, populate() {}, conversationId: CONV, canSend: false };
/** The answers a batch holds, as the tray would read them. */
const batch = (key = CONV) => (useInboxStore.getState().reviewComments[key] ?? []).map((c: any) => [c.proposal.card, c.proposal.verdict, c.body, c.proposal.seqs, c.proposal.change_ids, c.proposal.ordinal, c.proposal.subject]);
const clearBatch = (key = CONV) => React.act(() => useInboxStore.getState().clearReviewComments(key));

function mount(ui: React.ReactNode) {
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(ui));
  return root;
}
const card = (ref: string) => h("div", { "data-card": ref }, h(EntityObjectCard, { refId: ref, count: 1 }));
const inThread = (ui: React.ReactNode) => h(ReviewComposerContext.Provider, { value: composer }, ui);
const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const qa = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const click = (el: HTMLElement) => React.act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const key = (el: HTMLElement, k: string) => React.act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
const type = (el: HTMLTextAreaElement, text: string) => React.act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

const sentences = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-subject-sentence]")).map((s) => s.textContent);
const subjects = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-subject]"));
const foot = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-ledger-close]")!;

test("a proposed proposal: meta, lead, totals, one entry per subject; Approve stages a band in the batch and decides nothing; Undo takes it back", () => {
  const root = mount(inThread(card("op-1")));
  const c = q("[data-card='op-1']");
  expect(c.querySelector(".entity-card")).not.toBeNull();
  expect(c.textContent).toContain("Bring platform under one lead");
  // The meta line counts the cards a person sees.
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("2 to decide");
  expect(c.querySelector("[data-proposal-author='role']")!.textContent).toContain("Head of People");
  // The head names the author by face and name; the handle stays off it. In a thread the head links to the proposal's page.
  expect(c.querySelector("[data-proposal-author='role']")!.textContent).not.toContain("@");
  expect(c.querySelector(".entity-card")!.getAttribute("data-entity-card")).toBe("proposal");
  expect(c.querySelector("a[title='Open proposal']")).not.toBeNull();
  // The letter's lead, then the totals in one sentence.
  expect(c.querySelector("[data-proposal-letter]")!.textContent).toBe("Why bring platform under one lead.");
  expect(c.querySelector("[data-letter-more]")).toBeNull();
  expect(c.querySelector("[data-proposal-totals]")!.textContent).toBe("2 changes: 1 new role and 1 move.");
  expect(c.querySelector("[data-proposal-card]")!.getAttribute("data-proposal-card")).toBe("op-1");
  expect(c.querySelector("[data-proposal-card]")!.getAttribute("data-proposal-work")).toBe("structure");
  expect(c.querySelector("[data-proposal-readonly]")).toBeNull();

  // The ledger: the new role first, then the role moved under it, each a plain sentence.
  expect(subjects(c).map((s) => [s.getAttribute("data-subject"), s.getAttribute("data-subject-status"), s.getAttribute("data-change-ids")])).toEqual([
    ["role:platform", "proposed", "c1-role"],
    ["role:growth", "proposed", "c1-move"],
  ]);
  expect(sentences(c)).toEqual(["Add the role Head of Platform, reporting to you.", "Have Head of Growth report to Head of Platform."]);
  expect(Array.from(c.querySelectorAll("[data-subject-ordinal]")).map((n) => n.textContent)).toEqual(["1", "2"]);
  // The move says where the role reported before, as a face and a name.
  const reports = c.querySelector<HTMLElement>("[data-subject='role:growth'] [data-field='reports_to']")!;
  expect(reports.getAttribute("data-field-before")).toBe("Ashot Petrosian");
  expect(reports.getAttribute("data-field-after")).toBe("Head of Platform");
  expect(reports.querySelector("[data-face='person']")).not.toBeNull();
  expect(reports.querySelector("[data-face='role']")).not.toBeNull();
  expect(c.querySelector("[data-subject='role:platform'] [data-subject-reasons]")!.textContent).toBe("Because c1-role.");
  expect(c.querySelector("[data-tree-row], [data-ghost-tag], [data-proposal-rationale], [data-subject-edit], [data-send-answers], [data-proposal-reply], [data-subject-pending]")).toBeNull();
  expect(c.textContent).not.toMatch(/accept|skip|\bask\b|on your next message|\bEdit\b|Send \d/i);

  // Before any answer the foot has Map and Approve all, nothing filled.
  expect(foot(c).querySelector("[data-open-map='op-1']")!.textContent).toBe("Map");
  expect(foot(c).querySelector("[data-approve-rest]")!.textContent).toBe("Approve all 2");
  expect(foot(c).querySelector<HTMLElement>("[data-approve-rest]")!.style.background).toBe("");

  // One entry's Approve: one answer in the batch, naming the card, its changes, the number the person sees and the subject.
  click(c.querySelector("[data-subject='role:growth'] [data-subject-approve]")!);
  expect(batch()).toEqual([["role:growth", "approve", "", [2], ["c1-move"], 2, "Head of Growth"]]);
  expect(calls).toEqual([]);
  const growth = () => c.querySelector<HTMLElement>("[data-subject='role:growth']")!;
  expect(growth().getAttribute("data-subject-answer")).toBe("approve");
  expect(growth().getAttribute("data-subject-status")).toBe("proposed");
  expect(growth().querySelector("[data-subject-approve]")).toBeNull();
  expect(growth().querySelector("[data-staged]")!.getAttribute("data-staged")).toBe("approve");
  expect(growth().querySelector("[data-staged]")!.textContent).toBe("Approved. Applies when you send.Undo");
  expect(foot(c).querySelector("[data-approve-rest]")!.textContent).toBe("Approve the rest");
  // Undo empties the batch and brings the controls back.
  click(growth().querySelector("[data-staged-undo]")!);
  expect(batch()).toEqual([]);
  expect(growth().querySelector("[data-staged]")).toBeNull();
  expect(growth().querySelector("[data-subject-approve]")).not.toBeNull();
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe("false");
  React.act(() => root.unmount());
  clearBatch();
});

test("Reject opens the field inside the band; typing writes the body; Enter closes it and shows You; the frame never toggles", () => {
  const root = mount(inThread(card("op-1")));
  const c = q("[data-card='op-1']");
  click(c.querySelector("[data-subject='role:platform'] [data-subject-reject]")!);
  const platform = () => c.querySelector<HTMLElement>("[data-subject='role:platform']")!;
  expect(platform().querySelector("[data-staged]")!.textContent).toBe("Rejected. Sent when you send.Undo");
  const ta = platform().querySelector<HTMLTextAreaElement>("[data-answer-area] [data-subject-reply-field] textarea")!;
  expect(ta.placeholder).toBe("Why not? Say what you want instead.");
  type(ta, "Not yet");
  expect(batch()).toEqual([["role:platform", "reject", "Not yet", [1], ["c1-role"], 1, "Head of Platform"]]);
  // Typing never folds or opens the frame: a space and Enter stay in the field.
  const live = () => platform().querySelector<HTMLTextAreaElement>("[data-subject-reply-field] textarea")!;
  expect(live().value).toBe("Not yet");
  key(live(), " ");
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe("false");
  key(live(), "Enter");
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe("false");
  expect(platform().querySelector("[data-subject-reply-field]")).toBeNull();
  expect(platform().querySelector("[data-staged] [data-subject-you]")!.textContent).toBe("You: Not yet");
  // Every card answered: nothing is left for "Approve the rest".
  click(c.querySelector("[data-subject='role:growth'] [data-subject-approve]")!);
  expect(foot(c).querySelector("[data-approve-rest]")).toBeNull();
  // Open, the card is the same ledger under the whole letter, reading the same batch.
  click(c.querySelector(".entity-card")!);
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe("true");
  const open = c.querySelector<HTMLElement>(".entity-card-expand")!;
  expect(sentences(open)).toEqual(["Add the role Head of Platform, reporting to you.", "Have Head of Growth report to Head of Platform."]);
  expect(open.querySelector("[data-subject='role:platform'] [data-subject-you]")!.textContent).toBe("You: Not yet");
  expect(open.querySelector("[data-subject='role:growth'] [data-staged='approve']")).not.toBeNull();
  expect(calls).toEqual([]);
  React.act(() => root.unmount());
  clearBatch();
});

test("Approve all 2 with nothing answered, Approve the rest after one answer, pressed again withdraws only what it put; a word with a check", () => {
  const root = mount(inThread(card("op-1")));
  const c = q("[data-card='op-1']");
  const rest = () => c.querySelector<HTMLElement>("[data-ledger-close] [data-approve-rest]")!;
  expect(rest().textContent).toBe("Approve all 2");
  // One card answered by hand first.
  click(c.querySelector("[data-subject='role:growth'] [data-subject-reject]")!);
  expect(rest().textContent).toBe("Approve the rest");
  click(rest());
  expect(batch().map((b) => [b[0], b[1]])).toEqual([["role:growth", "reject"], ["role:platform", "approve"]]);
  expect(rest().getAttribute("aria-pressed")).toBe("true");
  expect(rest().querySelector("svg")).not.toBeNull();
  expect(rest().style.background).toBe("");
  expect(rest().tagName).toBe("BUTTON");
  click(rest());
  expect(batch().map((b) => [b[0], b[1]])).toEqual([["role:growth", "reject"]]);
  expect(rest().getAttribute("aria-pressed")).toBe("false");
  expect(rest().querySelector("svg")).toBeNull();
  // With nothing answered it reads "Approve all 2" and answers both.
  click(c.querySelector("[data-subject='role:growth'] [data-staged-undo]")!);
  expect(batch()).toEqual([]);
  expect(rest().textContent).toBe("Approve all 2");
  click(rest());
  expect(batch().map((b) => [b[0], b[1]])).toEqual([["role:platform", "approve"], ["role:growth", "approve"]]);
  expect(qa("[data-staged='approve']").length).toBe(2);
  expect(calls).toEqual([]);
  React.act(() => root.unmount());
  clearBatch();
});

test("after the send: no bands; accepted reads Approved, applying, then applied reads Applied; the meta and the outcome say what happened; Map stays", () => {
  const landing = mount(inThread(card("op-7")));
  const l = q("[data-card='op-7']");
  expect(l.querySelector("[data-staged], [data-subject-approve], [data-approve-rest]")).toBeNull();
  expect(Array.from(l.querySelectorAll("[data-subject-state]")).map((s) => [s.getAttribute("data-subject-state"), s.textContent])).toEqual([["accepted", "Approved, applying"], ["accepted", "Approved, applying"]]);
  expect(l.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("2 approved");
  React.act(() => useInboxStore.setState((s: any) => ({ orgProposalChanges: { ...s.orgProposalChanges, "c7-role": { ...s.orgProposalChanges["c7-role"], status: "applied", applied_at: Date.now() }, "c7-move": { ...s.orgProposalChanges["c7-move"], status: "applied", applied_at: Date.now() } } })));
  expect(Array.from(l.querySelectorAll("[data-subject-state]")).map((s) => [s.getAttribute("data-subject-state"), s.textContent])).toEqual([["applied", "Applied"], ["applied", "Applied"]]);
  React.act(() => landing.unmount());

  const root = mount(card("op-2"));
  const c = q("[data-card='op-2']");
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("2 approved");
  expect(c.querySelector("[data-approve-rest], [data-send-answers], [data-proposal-reply], [data-staged]")).toBeNull();
  expect(c.querySelector("[data-subject-approve], [data-subject-reject], [data-subject-reply]")).toBeNull();
  expect(c.querySelector("[data-proposal-outcome]")!.textContent).toBe("2 approved");
  expect(subjects(c).map((s) => s.getAttribute("data-subject-status"))).toEqual(["applied", "applied"]);
  expect(c.querySelector("[data-open-map='op-2']")!.textContent).toBe("Map");
  // Nothing to answer, so no line asks the reader to open a thread.
  expect(c.querySelector("[data-proposal-readonly-line]")).toBeNull();
  React.act(() => root.unmount());
});

test("a failed change keeps the card answerable: Retry, Reject and the note; staged, Retry says it runs again; with no composer the card is read only", () => {
  const root = mount(inThread(card("op-3")));
  const c = q("[data-card='op-3']");
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("1 approved, 1 failed");
  const meta = Array.from(c.querySelector("[data-proposal-meta]")!.children) as HTMLElement[];
  expect(meta.map((m) => m.textContent?.trim())).toEqual(["1 approved, 1 failed", "fromHead of People"]);
  const failed = () => c.querySelector<HTMLElement>("[data-subject='role:platform']")!;
  expect(failed().getAttribute("data-subject-status")).toBe("failed");
  expect(failed().querySelector("[data-failed-note]")!.textContent).toBe("Failed: A role already answers to @platform");
  expect(failed().querySelector("[data-subject-approve]")!.textContent).toBe("Retry");
  expect(failed().querySelector("[data-subject-reject]")).not.toBeNull();
  click(failed().querySelector("[data-subject-approve]")!);
  expect(batch()).toEqual([["role:platform", "approve", "", [1], ["c3-role"], 1, "Head of Platform"]]);
  expect(failed().querySelector("[data-staged]")!.textContent).toBe("Retry. Runs again when you send.Undo");
  React.act(() => root.unmount());
  clearBatch();
  // No bridge at all (team chat drawing the proposal), or a bridge whose composer cannot send: nothing could carry an answer, so none is offered.
  for (const [name, ui] of [["no bridge", card("op-3")], ["a bridge whose composer cannot send", h(ReviewComposerContext.Provider, { value: readOnlyComposer }, card("op-3"))]] as const) {
    const r = mount(ui);
    const ro = q("[data-card='op-3']");
    expect(ro.querySelector("[data-subject-approve], [data-subject-reject], [data-subject-reply], [data-staged]"), name).toBeNull();
    expect(ro.querySelector("[data-approve-rest], [data-proposal-reply], [data-send-answers]"), name).toBeNull();
    expect(ro.querySelector("[data-proposal-readonly]"), name).not.toBeNull();
    expect(ro.querySelector("[data-proposal-readonly-line]")!.textContent, name).toBe("Open this in Head of People's thread to answer.");
    expect(ro.querySelectorAll("[data-proposal-readonly-line]").length, name).toBe(1);
    expect(ro.querySelector("[data-failed-note]")!.textContent, name).toBe("Failed: A role already answers to @platform");
    expect(ro.querySelector("[data-open-map='op-3']")!.textContent, name).toBe("Map");
    expect(Object.keys(useInboxStore.getState().reviewComments), name).toEqual([]);
    React.act(() => r.unmount());
  }
  expect(calls).toEqual([]);
});

test("a limit never reaches the person: no row beside drawn changes, plain words when alone (S23.2)", () => {
  const root = mount(inThread(h("div", null, card("op-4"), card("op-5"))));
  // Alone: one plain sentence naming the role, no unit, and the answers still apply.
  const alone = q("[data-card='op-4']");
  expect(sentences(alone)).toEqual(["Head of Growth keeps a safety net on its daily work."]);
  expect(alone.querySelector("[data-field]")).toBeNull();
  expect(alone.textContent).not.toMatch(/wakes|tokens|caps|limit/i);
  expect(alone.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("1 to decide");
  // One card is the whole decision: its Approve is an outline like any other, the body has no totals line, and the foot adds no "Approve the rest".
  expect(alone.querySelector<HTMLElement>("[data-subject-approve]")!.style.background).toBe("");
  expect(alone.querySelector("[data-approve-rest], [data-proposal-totals], [data-subject-ordinal]")).toBeNull();
  click(alone.querySelector("[data-subject-approve]")!);
  expect(batch()).toEqual([["role:growth", "approve", "", [1], ["c4-limit"], 1, "Head of Growth"]]);
  // Beside a drawn change: nothing of it, no row, no words, and it is answered with the role it rides on.
  const beside = q("[data-card='op-5']");
  expect(subjects(beside).map((s) => [s.getAttribute("data-subject"), s.getAttribute("data-change-ids")])).toEqual([["role:platform", "c5-role c5-limit"]]);
  expect(beside.textContent).not.toMatch(/wakes|tokens|caps|limit|safety net/i);
  click(beside.querySelector("[data-subject-approve]")!);
  expect(batch()[1]).toEqual(["role:platform", "approve", "", [1], ["c5-role", "c5-limit"], 1, "Head of Platform"]);
  expect(calls).toEqual([]);
  React.act(() => root.unmount());
  clearBatch();
});

test("the letter: a long lead draws Read the rest; pressed, the whole letter reads in place and the frame stays collapsed", () => {
  const root = mount(inThread(card("op-8")));
  const c = q("[data-card='op-8']");
  const more = () => c.querySelector<HTMLElement>("[data-letter-more]")!;
  expect(more().getAttribute("data-letter-more")).toBe("closed");
  expect(more().textContent).toBe("Read the rest");
  expect(c.querySelector("[data-proposal-letter] p")!.className).toContain("line-clamp-4");
  expect(c.querySelector("[data-proposal-letter]")!.textContent).not.toContain("names the sessions this would move");
  click(more());
  expect(more().getAttribute("data-letter-more")).toBe("open");
  expect(more().textContent).toBe("Read less");
  expect(c.querySelector("[data-proposal-letter]")!.textContent).toContain("names the sessions this would move");
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe("false");
  click(more());
  expect(more().getAttribute("data-letter-more")).toBe("closed");
  // The open frame shows the whole letter and no word.
  click(c.querySelector(".entity-card")!);
  const open = c.querySelector<HTMLElement>(".entity-card-expand")!;
  expect(open.querySelector("[data-letter-more]")).toBeNull();
  expect(open.querySelector("[data-proposal-letter]")!.textContent).toContain("names the sessions this would move");
  React.act(() => root.unmount());
});

test("in a message, op-N#seq alone on its line is the proposal's pill, opening the screen with the change in focus, and never a card", async () => {
  const { default: ReactMarkdown } = await import("react-markdown");
  const { MemoryRouter } = await import("react-router");
  const { ASSISTANT_MD_REMARK, MESSAGE_MD_COMPONENTS } = await import("../messageMarkdown");
  const body = "Start with the one everything else waits on.\n\nop-1#2\n\nThen op-1#1 can follow.";
  const root = mount(h(MemoryRouter, null, h(ReactMarkdown, { remarkPlugins: ASSISTANT_MD_REMARK as any, components: MESSAGE_MD_COMPONENTS as any }, body)));
  expect(qa("[data-subject], [data-change-ref], [data-proposal-card]")).toEqual([]);
  const pills = qa("a.entity-ref");
  expect(pills.map((p) => [p.textContent, p.getAttribute("href")])).toEqual([["#2", "/org?proposal=op-1&focus=2"], ["#1", "/org?proposal=op-1&focus=1"]]);
  expect(pills[0].closest(".entity-card-row")).not.toBeNull();
  expect(pills[1].closest("p")!.textContent).toBe("Then #1 can follow.");
  React.act(() => root.unmount());
});

test("the store's focus on a change marks its card; on the org screen the card lights the map and draws no Map word and no Open proposal link", () => {
  React.act(() => useInboxStore.getState().setOrgFocusChangeId("c1-move"));
  const lit: (string | null)[] = [];
  const root = mount(h(OrgHoverContext.Provider, { value: (id: string | null) => lit.push(id) }, inThread(card("op-1"))));
  const c = q("[data-card='op-1']");
  expect(qa("[data-focused]").map((e) => e.getAttribute("data-subject"))).toEqual(["role:growth"]);
  expect(c.querySelector("[data-open-map]")).toBeNull();
  // Nor an Open proposal link: the person is on the page it opens.
  expect(c.querySelector("a[title='Open proposal']")).toBeNull();
  React.act(() => { c.querySelector("[data-subject='role:platform']")!.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })); });
  expect(lit.splice(0)).toEqual(["c1-role"]);
  React.act(() => root.unmount());
  React.act(() => useInboxStore.getState().setOrgFocusChangeId(null));
});

test("a revision landing on a staged card withdraws the answer: the batch empties and the controls come back under Revised since you last looked", () => {
  const root = mount(inThread(card("op-1")));
  const c = q("[data-card='op-1']");
  const platform = () => c.querySelector<HTMLElement>("[data-subject='role:platform']")!;
  click(platform().querySelector("[data-subject-approve]")!);
  expect(batch().map((b) => b[0])).toEqual(["role:platform"]);
  expect(platform().querySelector("[data-staged]")).not.toBeNull();
  const was = useInboxStore.getState().orgProposalChanges["c1-role"];
  React.act(() => useInboxStore.setState((s: any) => ({ orgProposalChanges: { ...s.orgProposalChanges, "c1-role": { ...was, revision: { kind: "amended", note: "Narrowed to the platform project.", at: Date.now() + 60_000 } } } })));
  expect(batch()).toEqual([]);
  expect(platform().querySelector("[data-staged]")).toBeNull();
  expect(platform().querySelector("[data-subject-approve]")).not.toBeNull();
  expect(platform().hasAttribute("data-revised-new")).toBe(true);
  expect(platform().textContent).toContain("Revised since you last looked");
  expect(platform().querySelector("[data-revision]")!.textContent).toContain("Changed Narrowed to the platform project.");
  expect(calls).toEqual([]);
  React.act(() => root.unmount());
  React.act(() => useInboxStore.setState((s: any) => ({ orgProposalChanges: { ...s.orgProposalChanges, "c1-role": was } })));
  clearBatch();
});

test("an op id the store has never seen is a loading card, then not available once served", () => {
  const root = mount(card("op-404"));
  const c = q("[data-card='op-404']");
  expect(c.textContent).toContain("Not available to you");
  React.act(() => root.unmount());
});
