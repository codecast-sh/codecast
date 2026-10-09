// Mounts a records proposal (docs/architecture/org-staffing.md S9, S39) in
// jsdom over the fixture world: one collapsed row per record group with its
// title, totals line and three answers, the records behind it twenty at a
// time, the band a staged answer leaves, and the words after a send. The
// card is the real one (EntityObjectCard over the store); only the server and
// the links are mocked. Groups stay closed, and one opens at a time.
// Run: bun test --timeout 240000 components/org/RecordGroupRow.mount.test.tsx
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
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}) }));
const noThrow = await import("../../hooks/useQueryNoThrow");
mock.module("../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined, error: undefined, retry: () => {} }) }));
const realProposals = { ...(await import("../../hooks/useSyncOrgProposals")) };
mock.module("../../hooks/useSyncOrgProposals", () => ({ ...realProposals, useSyncOrgProposal: (ref: string | null) => ({ ready: !!ref, missing: false }), useSyncOrgProposals: () => ({ ready: true, missing: false }) }));
const realTree = { ...(await import("../../hooks/useSyncOrgTree")) };
const { useInboxStore } = await import("../../store/inboxStore");
mock.module("../../hooks/useSyncOrgTree", () => ({ ...realTree, useSyncOrgTree: () => ({ tree: useInboxStore((s) => s.orgTree), ready: true, missing: false, refused: false, retry() {} }), useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry() {} }) }));

const { createRoot } = await import("react-dom/client");
const { ORG_RECORDS_FIXTURE_PROPOSAL, ORG_RECORDS_FIXTURE_PROPOSAL_BARE, ORG_RECORDS_FIXTURE_PROPOSAL_SENT, ORG_RECORDS_FIXTURE_TREE } = await import("./orgRecordsFixture");
const { changeWords } = await import("@codecast/shared/contracts/orgChangeWords");
const { askNames } = await import("./staffingAsks");
const { EntityObjectCard } = await import("../EntityObjectCard");
const { ReviewComposerContext } = await import("../reviewContext");
type OrgProposalRow = import("./orgStaffingTypes").OrgProposalRow;
type OrgProposalChange = import("./orgStaffingTypes").OrgProposalChange;

// Two proposals of this file's own: 55 loose tasks (one group), and 23 loose tasks (one page and three more).
const tasksOf = (p: OrgProposalRow, id: string, short_id: string, count?: number): OrgProposalRow => {
  const tasks = p.changes.filter((c) => c.change.kind === "task_status").slice(0, count);
  return { ...p, _id: id, short_id, changes: tasks.map((c, i) => ({ ...c, _id: `${id}-${i + 1}`, proposal_id: id, seq: i + 1 })) };
};
const LONE = tasksOf(ORG_RECORDS_FIXTURE_PROPOSAL_BARE, "fixture-proposal-904", "op-904");
const PAGED = tasksOf(ORG_RECORDS_FIXTURE_PROPOSAL_BARE, "fixture-proposal-905", "op-905", 23);
// The twins share op-901's short id in the fixture; a card resolves by short id, so each gets its own here.
const BARE: OrgProposalRow = { ...ORG_RECORDS_FIXTURE_PROPOSAL_BARE, short_id: "op-9011" };
const SENT: OrgProposalRow = { ...ORG_RECORDS_FIXTURE_PROPOSAL_SENT, short_id: "op-9012" };
const ALL = [ORG_RECORDS_FIXTURE_PROPOSAL, BARE, SENT, LONE, PAGED];

useInboxStore.setState({
  orgTree: ORG_RECORDS_FIXTURE_TREE,
  orgProposals: Object.fromEntries(ALL.map(({ changes: _c, ...row }) => [row._id, row])),
  // op-901's rows carry the builder's prefix as proposal_id (fixture-records), not the row's _id: the store keys them by the row.
  orgProposalChanges: Object.fromEntries(ALL.flatMap((p) => p.changes.map((c) => [c._id, { ...c, proposal_id: p._id }]))),
} as any);

// A press decides nothing: the old direct verdict actions record any call, and every test expects none.
const calls: any[] = [];
const realActions = { replyOnOrgProposal: useInboxStore.getState().replyOnOrgProposal };
useInboxStore.setState({
  replyOnOrgProposal: (...args: any[]) => calls.push(["reply", ...args]),
} as any);
afterAll(() => useInboxStore.setState(realActions as any));

const CONV = "conv-1";
const composer = { quote() {}, submit() {}, populate() {}, conversationId: CONV, canSend: true, send: () => {} };
const batch = () => (useInboxStore.getState().reviewComments[CONV] ?? []).map((c: any) => [c.proposal.card, c.proposal.verdict, c.body, c.proposal.seqs.length, c.proposal.change_ids.length, c.proposal.subject]);
const clearBatch = () => React.act(() => useInboxStore.getState().clearReviewComments(CONV));

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
const groups = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-subject-kind='group']"));
const group = (c: HTMLElement, key: string) => c.querySelector<HTMLElement>(`[data-subject='group:${key}']`)!;

const TABLE = [
  ["project:pr-901", "Matching Engine & Funnel", "project", "20", "1 plan done, 2 plans abandoned, 14 tasks done and 3 tasks reopened"],
  ["project:pr-902", "Callers & Call Management", "project", "18", "2 plans done, 1 plan abandoned, 12 tasks done, 1 task dropped and 2 tasks reopened"],
  ["project:pr-903", "Infrastructure", "project", "9", "1 plan done, 6 tasks done and 2 tasks reopened"],
  ["plan:pl-911", "Counterparty pitches", "plan", "6", "1 plan done and 5 tasks done"],
  ["plan:pl-912", "Networks", "plan", "5", "1 plan reopened and 4 tasks reopened"],
  ["loose", "Not under a project", null, "6", "2 tasks done, 3 tasks reopened and 1 task to the backlog"],
];

test("op-901 draws six group rows in order, each titled and totalled, all closed; the card carries the proposal's totals", () => {
  const root = mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  expect(c.querySelector("[data-proposal-card]")!.getAttribute("data-proposal-work")).toBe("records");
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toMatch(/^64 records to decide/);
  expect(c.querySelector("[data-proposal-totals]")!.textContent).toBe("64 records: 44 done, 15 reopened, 3 abandoned, 1 dropped and 1 to the backlog.");
  expect(groups(c).map((g) => [g.getAttribute("data-subject")!.replace(/^group:/, ""), g.querySelector("[data-group-toggle] span")!.textContent, g.querySelector("[data-group-toggle] span + span")?.textContent ?? null, g.getAttribute("data-group-count"), g.querySelector("[data-group-totals]")!.textContent])).toEqual(TABLE);
  expect(c.querySelectorAll("[data-subject-kind]").length).toBe(6);
  expect(c.querySelector("[data-group-rows]")).toBeNull();
  expect(groups(c).every((g) => g.querySelector("[data-group-toggle]")!.getAttribute("aria-expanded") === "false")).toBe(true);
  expect(groups(c).every((g) => g.querySelector("[data-subject-approve]") && g.querySelector("[data-subject-reject]") && g.querySelector("[data-subject-reply]"))).toBe(true);
  // One entry's Approve is a quiet outline; the foot offers the rest and the map.
  expect(c.querySelector("[data-approve-rest]")!.textContent).toBe("Approve all 6");
  expect(c.querySelector("[data-open-map='op-901']")!.textContent).toBe("Map");
  expect(c.querySelector("[data-send-answers], [data-proposal-reply], [data-subject-pending]")).toBeNull();
  expect(c.textContent).not.toMatch(/on your next message|Filed under no project/);
  React.act(() => root.unmount());
});

test("Approve on a group stages one answer over every record in it, named by the group; the band replaces the controls; Undo clears", () => {
  const root = mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const a = () => group(c, "project:pr-901");
  click(a().querySelector("[data-subject-approve]")!);
  expect(batch()).toEqual([["group:project:pr-901", "approve", "", 20, 20, "Matching Engine & Funnel"]]);
  expect(calls).toEqual([]);
  expect(a().getAttribute("data-subject-answer")).toBe("approve");
  expect(a().querySelector("[data-staged]")!.textContent).toBe("Approved. Applies when you send.Undo");
  expect(a().querySelector("[data-subject-approve]")).toBeNull();
  expect(c.querySelector("[data-approve-rest]")!.textContent).toBe("Approve the rest");
  click(a().querySelector("[data-staged-undo]")!);
  expect(batch()).toEqual([]);
  expect(a().querySelector("[data-staged]")).toBeNull();
  expect(a().querySelector("[data-subject-approve]")).not.toBeNull();
  React.act(() => root.unmount());
  clearBatch();
});

test("Approve all 6 stages every group, reads pressed with a check, and pressed again takes them all back", () => {
  const root = mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const rest = () => c.querySelector<HTMLElement>("[data-approve-rest]")!;
  click(rest());
  expect(batch().map((b) => [b[0], b[1]])).toEqual(TABLE.map((row) => [`group:${row[0]}`, "approve"]));
  expect(rest().getAttribute("aria-pressed")).toBe("true");
  expect(rest().querySelector("svg")).not.toBeNull();
  // A word, never a filled button.
  expect(rest().style.background).toBe("");
  expect(groups(c).every((g) => g.querySelector("[data-staged='approve']"))).toBe(true);
  click(rest());
  expect(batch()).toEqual([]);
  expect(rest().textContent).toBe("Approve all 6");
  expect(calls).toEqual([]);
  React.act(() => root.unmount());
  clearBatch();
});

test("Reject on a group opens the field with the group's ask; the words and Enter stage a rejection with them", () => {
  const root = mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const b = () => group(c, "project:pr-902");
  click(b().querySelector("[data-subject-reject]")!);
  const ta = b().querySelector<HTMLTextAreaElement>("[data-subject-reply-field] textarea")!;
  expect(ta.placeholder).toBe("Why not? Say which records to leave out, by number, or what to change.");
  type(ta, "Leave #20 out");
  expect(batch()).toEqual([["group:project:pr-902", "reject", "Leave #20 out", 18, 18, "Callers & Call Management"]]);
  key(ta, "Enter");
  expect(b().querySelector("[data-subject-reply-field]")).toBeNull();
  expect(b().querySelector("[data-staged]")!.textContent).toBe("Rejected. Sent when you send.UndoYou: Leave #20 out");
  expect(b().querySelector("[data-subject-you]")!.getAttribute("data-subject-you")).toBe("reject");
  // Reply asks the same way about these records.
  click(group(c, "plan:pl-911").querySelector("[data-subject-reply]")!);
  expect(group(c, "plan:pl-911").querySelector<HTMLTextAreaElement>("[data-subject-reply-field] textarea")!.placeholder).toBe("Say something about these records");
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe("false");
  React.act(() => root.unmount());
  clearBatch();
});

test("open, a group lists its records as numbered sentences, closed ones dim and never struck, long reasons clamped, with no controls; past twenty, Show N more", () => {
  const names = askNames(ORG_RECORDS_FIXTURE_TREE);
  const root = mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const a = () => group(c, "project:pr-901");
  click(a().querySelector("[data-group-toggle]")!);
  expect(a().querySelector("[data-group-toggle]")!.getAttribute("aria-expanded")).toBe("true");
  const rows = () => Array.from(a().querySelectorAll<HTMLElement>("[data-record-row]"));
  expect(a().querySelector("[data-group-rows]")!.getAttribute("data-group-rows")).toBe("20");
  expect(rows().map((r) => r.getAttribute("data-record-row"))).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
  expect(rows()[0].querySelector("[data-record-seq]")!.textContent).toBe("#1");
  expect(rows()[0].querySelector("p")!.textContent).toBe(changeWords(ORG_RECORDS_FIXTURE_PROPOSAL.changes[0].change, { names }).sentence);
  expect(rows()[0].querySelector("p [data-subject-pill]")!.textContent).toBe("Funnel stages v2");
  // A closed row is dim, never struck through: the sentence says the status, and a strike reads as rejected.
  expect(rows()[0].querySelector("p")!.className).toContain("--sol-text-dim");
  expect(rows()[17].querySelector("p")!.className).not.toContain("--sol-text-dim");
  expect(rows().filter((r) => /line-through/.test(r.innerHTML))).toEqual([]);
  // The 220-character reason folds with "show all"; a short one has no word.
  const long = rows().find((r) => (r.textContent ?? "").includes("the health sweep flagged it once"))!;
  expect(long.querySelector("[data-field-more]")!.textContent).toBe("show all");
  expect(rows()[1].querySelector("[data-field-more]")).toBeNull();
  expect(a().querySelector("[data-record-row] [data-subject-approve], [data-record-row] [data-subject-reject], [data-record-row] [data-subject-reply]")).toBeNull();
  expect(a().querySelector("[data-group-more]")).toBeNull();
  click(a().querySelector("[data-group-toggle]")!);
  expect(a().querySelector("[data-group-rows]")).toBeNull();
  React.act(() => root.unmount());
  // Twenty three loose tasks: one group, twenty rows, three more, then all and no word.
  const paged = mount(inThread(card("op-905")));
  const p = q("[data-card='op-905']");
  expect(groups(p).length).toBe(1);
  click(p.querySelector("[data-group-show]")!);
  expect(p.querySelectorAll("[data-record-row]").length).toBe(20);
  const more = p.querySelector<HTMLElement>("[data-group-more]")!;
  expect(more.getAttribute("data-group-more")).toBe("3");
  expect(more.textContent).toBe("Show 3 more");
  click(more);
  expect(p.querySelectorAll("[data-record-row]").length).toBe(23);
  expect(p.querySelector("[data-group-more]")).toBeNull();
  React.act(() => paged.unmount());
});

test("a proposal whose records all fall in one loose group is All N records, carrying the proposal's totals, closed with Show the N records", () => {
  const root = mount(inThread(card("op-904")));
  const c = q("[data-card='op-904']");
  expect(groups(c).length).toBe(1);
  const g = groups(c)[0];
  expect(g.querySelector("[data-group-toggle] span")!.textContent).toBe("All 55 records");
  expect(g.querySelector("[data-group-toggle] span + span")).toBeNull();
  expect(g.querySelector("[data-group-totals]")!.textContent).toBe("55 records: 39 done, 14 reopened, 1 dropped and 1 to the backlog.");
  expect(c.querySelector("[data-proposal-totals]")).toBeNull();
  expect(g.querySelector("[data-group-toggle]")!.getAttribute("aria-expanded")).toBe("false");
  expect(g.querySelector("[data-group-show]")!.textContent).toBe("Show the 55 records");
  // One entry: its Approve is the whole decision, and the foot adds none.
  expect(c.querySelector("[data-approve-rest]")).toBeNull();
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("55 records to decide");
  React.act(() => root.unmount());
  // The bare op-57 shape: the nine plans closed on their own fold into one "N plans" row (no kind word), then the tasks under none.
  const bare = mount(inThread(card(BARE.short_id)));
  const b = q(`[data-card='${BARE.short_id}']`);
  expect(groups(b).map((g) => [g.getAttribute("data-subject"), g.querySelector("[data-group-toggle] span")!.textContent, g.querySelector("[data-group-toggle] span + span")?.textContent ?? null, g.getAttribute("data-group-count")])).toEqual([
    ["group:plans", "9 plans", null, "9"],
    ["group:loose", "Not under a project", null, "55"],
  ]);
  expect(group(b, "plans").querySelector("[data-group-totals]")!.textContent).toBe("5 plans done, 3 plans abandoned and 1 plan reopened");
  React.act(() => bare.unmount());
});

test("after the send: Applied, Applying 10 of 18, Rejected with the words, 2 failed with Retry only where a composer can send", () => {
  const sent = SENT.short_id;
  for (const [name, ui, retry] of [["no composer", card(sent), false], ["a composer", inThread(card(sent)), true]] as const) {
    const root = mount(ui);
    const c = q(`[data-card='${sent}']`);
    const word = (key: string) => group(c, key).querySelector("[data-subject-state]");
    expect(word("project:pr-901")!.textContent, name).toBe("Applied");
    expect(word("project:pr-901")!.getAttribute("data-subject-state"), name).toBe("applied");
    expect(word("project:pr-902")!.textContent, name).toBe("Applying 10 of 18");
    expect(word("project:pr-902")!.getAttribute("data-subject-state"), name).toBe("accepted");
    expect(word("project:pr-903")!.textContent, name).toBe("Rejected");
    expect(group(c, "project:pr-903").querySelector("[data-subject-you]")!.textContent, name).toBe("You: Not yet");
    expect(word("plan:pl-911")!.textContent, name).toBe("2 failed");
    expect(group(c, "project:pr-901").querySelector("[data-subject-approve]"), name).toBeNull();
    const p1 = group(c, "plan:pl-911");
    if (retry) {
      expect(p1.querySelector("[data-subject-approve]")!.textContent, name).toBe("Retry");
      expect(c.querySelector("[data-proposal-readonly]"), name).toBeNull();
    } else {
      expect(p1.querySelector("[data-subject-approve]"), name).toBeNull();
      expect(c.querySelector("[data-proposal-readonly]"), name).not.toBeNull();
      expect(c.querySelector("[data-proposal-readonly-line]")!.textContent, name).toBe("Open this in Head of People's thread to answer.");
    }
    expect(c.querySelector("[data-staged]"), name).toBeNull();
    // The meta line names the failures in red.
    const meta = c.querySelector("[data-proposal-meta]")!;
    expect(meta.getAttribute("data-proposal-meta"), name).toBe("15 of 64 records to decide · 30 applied, 8 approved, 9 rejected, 2 failed");
    expect(Array.from(meta.querySelectorAll("span")).find((s) => s.textContent === "2 failed")!.className, name).toContain("--ink-red");
    // Open, the failed rows carry their note and the applied rows of a part-way group their own word.
    click(p1.querySelector("[data-group-toggle]")!);
    expect(Array.from(p1.querySelectorAll("[data-record-row]")).slice(0, 2).map((r) => r.querySelector("[data-failed-note]")!.textContent), name).toEqual(["Failed: pl-911 is already done", "Failed: pl-911 is already done"]);
    expect(p1.querySelectorAll("[data-record-row='50'] [data-failed-note]").length, name).toBe(0);
    React.act(() => root.unmount());
  }
  expect(calls).toEqual([]);
});

test("the store's focus on a record opens the group holding it and marks the row", () => {
  React.act(() => useInboxStore.getState().setOrgFocusChangeId("fixture-records-40"));
  const root = mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const g = group(c, "project:pr-903");
  expect(g.hasAttribute("data-focused")).toBe(true);
  expect(g.querySelector("[data-group-toggle]")!.getAttribute("aria-expanded")).toBe("true");
  expect(g.querySelector("[data-record-row='40']")!.hasAttribute("data-focused")).toBe(true);
  expect(c.querySelectorAll("[data-group-rows]").length).toBe(1);
  expect(c.querySelectorAll("[data-focused]").length).toBe(2);
  React.act(() => root.unmount());
  React.act(() => useInboxStore.getState().setOrgFocusChangeId(null));
});

// A group part way landed: 15 of Callers' 18 applied, 3 still waiting.
const { orgRecordGroups } = await import("@codecast/shared/contracts/orgProposal");
const { batchSendWords } = await import("../../lib/reviewActions");
const groupSeqs = (key: string) => orgRecordGroups(ORG_RECORDS_FIXTURE_PROPOSAL.changes).find((g) => g.key === key)!.seqs;
const MIXED: OrgProposalRow = (() => {
  const landed = new Set(groupSeqs("project:pr-902").slice(0, 15));
  const id = "fixture-proposal-906";
  return { ...ORG_RECORDS_FIXTURE_PROPOSAL, _id: id, short_id: "op-906", changes: ORG_RECORDS_FIXTURE_PROPOSAL.changes.map((c) => ({ ...c, _id: `${id}-${c.seq}`, proposal_id: id, ...(landed.has(c.seq) ? { status: "applied" as const, decided_at: 1, applied_at: 1 } : {}) })) };
})();
useInboxStore.setState((s: any) => ({
  orgProposals: { ...s.orgProposals, [MIXED._id]: (({ changes: _c, ...row }) => row)(MIXED) },
  orgProposalChanges: { ...s.orgProposalChanges, ...Object.fromEntries(MIXED.changes.map((c) => [c._id, c])) },
}));

test("Approve on a group part way landed stages only the records that wait (3 of 18), so the send's button and words count and name them alone", () => {
  const root = mount(inThread(card("op-906")));
  const c = q("[data-card='op-906']");
  const g = group(c, "project:pr-902");
  expect(g.getAttribute("data-group-count")).toBe("18");
  click(g.querySelector("[data-subject-approve]")!);
  expect(batch()).toEqual([["group:project:pr-902", "approve", "", 3, 3, "Callers & Call Management"]]);
  const pending = useInboxStore.getState().reviewComments[CONV] as any[];
  expect(pending[0].proposal.seqs).toEqual(groupSeqs("project:pr-902").slice(15));
  expect(pending[0].proposal.change_ids.every((id: string) => useInboxStore.getState().orgProposalChanges[id].status === "proposed")).toBe(true);
  expect(batchSendWords(pending)).toMatchObject({ applies: 3, button: "Send and apply 3", head: "3 changes will apply when you send" });
  clearBatch();
  // Approve all counts the same three.
  click(c.querySelector("[data-approve-rest]")!);
  expect(batchSendWords(useInboxStore.getState().reviewComments[CONV]).applies).toBe(64 - 15);
  clearBatch();
  React.act(() => root.unmount());
  expect(calls).toEqual([]);
});

test("a revision landing on a staged group withdraws the answer: the batch empties and the controls come back under Revised since you last looked", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const root = mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const g = () => group(c, "project:pr-903");
  click(g().querySelector("[data-subject-approve]")!);
  expect(batch().map((b) => b[0])).toEqual(["group:project:pr-903"]);
  expect(g().querySelector("[data-staged]")).not.toBeNull();
  expect(g().hasAttribute("data-revised-new")).toBe(false);
  const id = `fixture-records-${groupSeqs("project:pr-903")[0]}`;
  const was = useInboxStore.getState().orgProposalChanges[id];
  await tick();
  React.act(() => useInboxStore.setState((s: any) => ({ orgProposalChanges: { ...s.orgProposalChanges, [id]: { ...was, revision: { kind: "amended", note: "Kept the warm pool.", at: Date.now() } } } })));
  expect(batch()).toEqual([]);
  expect(g().querySelector("[data-staged]")).toBeNull();
  expect(g().querySelector("[data-subject-approve]")).not.toBeNull();
  expect(g().hasAttribute("data-revised-new")).toBe(true);
  expect(g().textContent).toContain("Revised since you last looked");
  // Answering again clears the line.
  await tick();
  click(g().querySelector("[data-subject-approve]")!);
  expect(g().hasAttribute("data-revised-new")).toBe(false);
  clearBatch();
  React.act(() => useInboxStore.setState((s: any) => ({ orgProposalChanges: { ...s.orgProposalChanges, [id]: was } })));
  React.act(() => root.unmount());
  expect(calls).toEqual([]);
});
