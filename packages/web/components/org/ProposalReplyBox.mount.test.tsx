// Mounts the reply box (docs/architecture/org-staffing.md S39) in jsdom over
// the real store's pending batch: nothing but a one line hint while the batch
// is empty, then the tray's rows, a two row field and the filled "Send N
// answers"; Enter sends once through replyOnOrgProposal with the typed words
// riding to the thread; with no thread the box says nobody is told and the
// send says nothing.
// Run: bun test --timeout 240000 components/org/ProposalReplyBox.mount.test.tsx
import { test, expect, afterAll } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { answerProposalCard } = await import("../../lib/reviewActions");
const { ProposalReplyBox, proposalBatchKey, sendProposalAnswers } = await import("./ProposalReplyBox");

const sends: any[] = [];
const realReply = useInboxStore.getState().replyOnOrgProposal;
useInboxStore.setState({ replyOnOrgProposal: (...args: any[]) => sends.push(args) } as any);
afterAll(() => useInboxStore.setState({ replyOnOrgProposal: realReply } as any));

const PROPOSAL = { _id: "p-55", short_id: "op-55", title: "Rank the projects by the goals they carry", status: "open" as const };
const change = (id: string, seq: number) => ({ _id: id, proposal_id: PROPOSAL._id, seq, status: "proposed" as const, change: { kind: "project_meta" as const, project: `Project ${seq}`, priority: "p1" }, rationale: "", evidence: [] });
const CHANGES = [change("c1", 1), change("c2", 2), change("c3", 3)];
const ref = (seq: number) => ({ proposal: { id: PROPOSAL._id, short_id: PROPOSAL.short_id, title: PROPOSAL.title }, key: `project:${seq}`, change_ids: [`c${seq}`], seqs: [seq], sentence: `Make Project ${seq} a high priority.`, ordinal: seq });

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const click = (el: Element | null) => React.act(() => (el as HTMLElement).click());
const type = (el: Element | null, text: string) => React.act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
  el!.dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (el: Element | null, k: string) => React.act(() => { el!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
function mount(ui: React.ReactNode) {
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(ui));
  return root;
}

test("the key is the thread's conversation, else the proposal's own", () => {
  expect(proposalBatchKey("p-55", { conversation_id: "conv-9" })).toBe("conv-9");
  expect(proposalBatchKey("p-55", null)).toBe("proposal:p-55");
  expect(proposalBatchKey("p-55", undefined)).toBe("proposal:p-55");
});

test("a thread: the hint, then the rows, two rows of field, and one send with the words riding to the thread", () => {
  const thread = { conversation_id: "conv-9" };
  const batchKey = proposalBatchKey(PROPOSAL._id, thread);
  const root = mount(h(ProposalReplyBox, { proposal: PROPOSAL, changes: CHANGES, batchKey, thread }));
  // Empty batch: one line, no field, no button.
  expect(q("[data-reply-hint]")!.textContent).toBe("Answer the changes above, then send.");
  expect(q("[data-proposal-reply-box]")).toBeNull();
  // Answers land in the batch (from the cards, elsewhere): the box draws them as the tray would.
  React.act(() => { answerProposalCard(batchKey, ref(1), { verdict: "approve" }); answerProposalCard(batchKey, ref(3), { verdict: "approve" }); });
  React.act(() => answerProposalCard(batchKey, ref(2), { verdict: "reject", text: "P1 is too high" }));
  expect(q("[data-reply-hint]")).toBeNull();
  const box = q("[data-proposal-reply-box]")!;
  expect(box.getAttribute("data-proposal-reply-box")).toBe("3");
  expect(box.querySelector(".cc-review-tray-group")!.textContent).toBe(PROPOSAL.title);
  expect(Array.from(box.querySelectorAll(".cc-review-tray-verdict")).map((el) => el.textContent)).toEqual(["Approve 1 and 3", "Reject 2"]);
  expect(box.querySelector(".cc-review-tray-note")!.textContent).toBe("P1 is too high");
  const field = box.querySelector<HTMLTextAreaElement>("[data-proposal-reply-typed]")!;
  expect(field.rows).toBe(2);
  expect(field.placeholder).toBe("Add a reply (optional)");
  expect(box.querySelector("[data-reply-no-thread]")).toBeNull();
  const send = box.querySelector<HTMLButtonElement>("[data-send-answers]")!;
  expect(send.textContent).toBe("Send 3 answers");
  expect(send.style.background).toBe("var(--sol-violet)");
  // A row's x withdraws it; the count follows.
  click(box.querySelector("[data-review-answer='reject'] .cc-review-tray-x"));
  expect(q("[data-send-answers]")!.textContent).toBe("Send 2 answers");
  React.act(() => answerProposalCard(batchKey, ref(2), { verdict: "reject", text: "P1 is too high" }));
  // Shift+Enter is a new line; Enter sends: one store action, the words on the say, the batch empty, the box gone.
  type(q("[data-proposal-reply-typed]"), "Do the plans next");
  key(q("[data-proposal-reply-typed]"), "Enter");
  expect(sends.length).toBe(1);
  const [proposalId, items, seen, opts] = sends[0];
  expect(proposalId).toBe(PROPOSAL._id);
  expect(items).toEqual([
    { verdict: "approve", change_ids: ["c1"], seqs: [1] },
    { verdict: "approve", change_ids: ["c3"], seqs: [3] },
    { verdict: "reject", change_ids: ["c2"], seqs: [2], text: "P1 is too high" },
  ]);
  expect(seen).toEqual({ revised_at: 0, seqs: [] });
  expect(opts.say.thread).toBe("conv-9");
  expect(opts.say.body).toBe("Do the plans next");
  expect(opts.say.client_id).toMatch(/^optimistic_/);
  expect(useInboxStore.getState().reviewComments[batchKey] ?? []).toEqual([]);
  expect(q("[data-proposal-reply-box]")).toBeNull();
  expect(q("[data-reply-hint]")).toBeNull();
  React.act(() => root.unmount());
  sends.length = 0;
});

test("no thread: the answers apply under the proposal's own key and the box says nobody is told", () => {
  const batchKey = proposalBatchKey(PROPOSAL._id, null);
  expect(batchKey).toBe("proposal:p-55");
  const root = mount(h(ProposalReplyBox, { proposal: PROPOSAL, changes: CHANGES, batchKey, thread: null }));
  React.act(() => answerProposalCard(batchKey, ref(1), { verdict: "approve" }));
  const box = q("[data-proposal-reply-box]")!;
  expect(box.querySelector("[data-reply-no-thread]")!.textContent).toBe("Your answers apply; nobody is told.");
  click(box.querySelector("[data-send-answers]"));
  expect(sends.length).toBe(1);
  expect(sends[0][1]).toEqual([{ verdict: "approve", change_ids: ["c1"], seqs: [1] }]);
  expect(sends[0][3].say).toBeUndefined();
  React.act(() => root.unmount());
  sends.length = 0;
});

test("a host's own send takes over, and the box still clears its field", () => {
  const batchKey = proposalBatchKey(PROPOSAL._id, null);
  const taken: string[] = [];
  const root = mount(h(ProposalReplyBox, { proposal: PROPOSAL, changes: CHANGES, batchKey, thread: null, onSend: (typed: string) => { taken.push(typed); useInboxStore.getState().clearReviewComments(batchKey); } }));
  React.act(() => answerProposalCard(batchKey, ref(2), { verdict: "note", text: "Why this one?" }));
  type(q("[data-proposal-reply-typed]"), "Preview words");
  click(q("[data-send-answers]"));
  expect(taken).toEqual(["Preview words"]);
  expect(sends).toEqual([]);
  expect(q("[data-proposal-reply-box]")).toBeNull();
  React.act(() => root.unmount());
});

test("nothing waits: no hint for a decided proposal", () => {
  const batchKey = proposalBatchKey("p-done", null);
  const root = mount(h(ProposalReplyBox, { proposal: { ...PROPOSAL, _id: "p-done", status: "resolved" as const }, changes: CHANGES.map((c) => ({ ...c, status: "applied" as const })), batchKey, thread: null }));
  expect(document.body.textContent).toBe("");
  React.act(() => root.unmount());
});

test("sendProposalAnswers with nothing pending sends nothing and returns no words", () => {
  expect(sendProposalAnswers("proposal:nothing", "nothing", null, "typed alone")).toBe("");
  expect(sends).toEqual([]);
});
