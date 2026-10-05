// Mounts the staffing pane in jsdom against the fixture proposals and health
// and checks its states: a proposal as its asks (org-staffing.md S19: one
// line of header, one card per ask with Approve, Reject and Reply, and inside
// the fold the ask's ledger entries, S39: one per goal, project, role or
// record, each a sentence, its fields and its own Approve, Reject and Reply),
// a proposal that is one ask drawn as its entries straight under the title
// with the ledger's closing row, the reply box where no composer is on
// screen, the pointer to the health page with no proposal, and the two
// buttons with no head of people. An answer decides nothing: it joins the
// pending batch under the thread's conversation (the composer's own tray),
// and one send applies it through replyOnOrgProposal. S19's own test is
// applied to both first screens: every word a cold reader meets before
// scrolling, checked against the words the glossary exists to define.
// Run: bun components/org/StaffingPane.mount.test.tsx
import assert from "node:assert/strict";

import { closeDomWindow } from "../../test-helpers/domGlobals";
async function verifyStaffingPane() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  // The Head of People's thread embed pulls the whole store and the message pipeline;
  // the pane only places it.
  mock.module("../anchor/AnchorConversation", () => ({ AnchorConversation: ({ conversationId }: { conversationId: string }) => React.createElement("div", { "data-thread": conversationId }, "thread") }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { StaffingPane } = await import("./StaffingPane");
  const { useInboxStore } = await import("../../store/inboxStore");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_SESSION_PROPOSAL, ORG_STAFFING_FIXTURE_BIG_PROPOSAL } = await import("./orgStaffingFixture");
  const { UNION_GOALS_DATA, UNION_GOALS_PROPOSAL, UNION_GOALS_TREE } = await import("./goalsFixture");
  const { findHeadOfPeople } = await import("./staffingModel");
  const headOfPeopleTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-head", short_id: "or-9", handle: "head-of-people", name: "Head of People", standing: { conversation_id: "fixture-head-conv", short_id: "jx7ch1f" } }] };
  const calls: string[] = [];
  // The send: one store action per proposal, recorded instead of dispatched.
  const sends: any[] = [];
  const realReply = useInboxStore.getState().replyOnOrgProposal;
  useInboxStore.setState({ replyOnOrgProposal: (...args: any[]) => sends.push(args) } as any);
  // The proposal's thread: the key its answers wait under, shared with that conversation's composer.
  const THREAD = "fixture-thread-conv";
  const base = {
    tree: headOfPeopleTree,
    health: ORG_STAFFING_FIXTURE_HEALTH,
    proposals: [ORG_STAFFING_FIXTURE_PROPOSAL],
    head: findHeadOfPeople(headOfPeopleTree),
    reviewing: false,
    now: Date.now(),
    thread: { conversation_id: THREAD },
    // The desktop: the thread's composer is beside the pane, so no reply box here.
    threadComposerOnScreen: true,
    onSelectChange: (id: string | null) => calls.push(`select:${id}`),
    onDecide: (id: string, verdict: string, edits: Record<string, unknown> | undefined, seen: unknown) => calls.push(`decide:${id}:${verdict}${edits ? ":" + JSON.stringify(edits) : ""}:${JSON.stringify(seen)}`),
    onEditRole: (c: any) => calls.push(`editRole:${c._id}`),
    onSelectNode: (id: string) => calls.push(`node:${id}`),
    onOpenSession: (id: string) => calls.push(`open:${id}`),
    onPickProposal: (id: string) => calls.push(`pick:${id}`),
    onHireHeadOfPeople: () => calls.push("hire"),
    onProposeNow: () => calls.push("propose"),
  };
  const root = createRoot(document.getElementById("root")!);
  const render = (props: any) => act(async () => root.render(React.createElement(StaffingPane, { ...base, ...props })));
  const text = () => document.body.textContent ?? "";
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const button = (label: string) => {
    const el = qa("button").find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
    assert.ok(el, `Missing button "${label}"`);
    return el!;
  };
  const card = (i: number) => q(`[data-ask="${i}"]`)!;
  // An entry of the open list, by the goal, project, role or record it changes.
  const entry = (key: string) => q(`[data-ask-rows] [data-subject="${key}"]`)!;
  const entries = () => qa("[data-ask-rows] [data-subject]");
  const field = (key: string, name: string) => entry(key).querySelector<HTMLElement>(`[data-field="${name}"]`);
  const needsGlossary = /standing agent|\bscope\b|\bcharter\b|\bwakes?\b|\bhands?\b|\btokens?\b|\bop-\d+|\bseq\b|\bproposal\b|\bhead of staff\b/i;
  /** The answers a batch holds, as the tray reads them: the card, the verdict, the words, the numbers, the ids. */
  const batch = (key = THREAD) => (useInboxStore.getState().reviewComments[key] ?? []).map((c: any) => [c.proposal.card, c.proposal.verdict, c.body, c.proposal.seqs, c.proposal.change_ids]);
  const clearBatch = async (key = THREAD) => act(async () => useInboxStore.getState().clearReviewComments(key));
  const click = (el: Element | null | undefined) => { assert.ok(el, "nothing to press"); return act(async () => (el as HTMLElement).click()); };
  const type = (el: HTMLTextAreaElement | null, value: string) => { assert.ok(el, "no field"); return act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value); el!.dispatchEvent(new Event("input", { bubbles: true })); }); };
  const key = (el: Element | null, k: string) => { assert.ok(el, "no field"); return act(async () => { el!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); };

  // ── a proposal: one line of header, one card per ask, the three answers ──
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "proposal");
  assert.match(q("[data-asks-header]")!.textContent!, /^Split growth, own the platform work, budget the reviews0 of 4 answered$/);
  // What goes (S19): no op-N pill, no picker, no provenance line, no progress
  // strip, no summary controls, no section label, no group headers, no
  // accept all box, no intro banner, no glossary link. The author and the
  // date are the letter's, on the left. The word Skip appears nowhere.
  assert.doesNotMatch(text(), /op-7|from a company review|ago|Accept|Skip|Changes|Findings|Budget|How this works|Words/);
  assert.equal(q("select"), null);
  assert.equal(q('[role="group"]'), null);
  assert.equal(q("[data-proposal-intro]"), null);
  // The asks the fixture derives (it stores none): the records, one per new
  // role, and the rest as one; every card reads title, why, effect, and the
  // three answers, with its rows folded and counted.
  assert.deepEqual(qa("[data-ask-title]").map((el) => el.textContent), ["Bring 2 records up to date", "Add an agent: Head of Platform", "Add an agent: Content Lead", "3 smaller changes: filing, goals and settings"]);
  assert.deepEqual(qa("[data-ask]").map((el) => el.getAttribute("data-ask-state")), ["open", "open", "open", "open"]);
  assert.match(card(1).querySelector("[data-ask-why]")!.textContent!, /^The Platform project has 14 open tasks and no owner role/);
  assert.match(card(1).querySelector("[data-ask-effect]")!.textContent!, /^If you approve: Platform decisions get a recommendation/);
  assert.deepEqual([...card(1).querySelectorAll("[data-ask-controls] button")].map((b) => b.textContent?.trim()), ["Approve", "Reject", "Reply"]);
  // The fourth ask holds four rows and folds as three: the limit among them is never a row (S23.2).
  assert.deepEqual(qa("[data-ask-fold]").map((el) => el.textContent?.trim()), ["2 records", "1 change", "1 change", "3 changes"]);
  assert.ok(!/tokens|800,000|800k|wakes/.test(document.body.textContent ?? ""), "no limit number reaches the pane");
  assert.equal(qa("[data-subject]").length, 0, "no entry on the first screen");
  // The half answered ask says so under its title and keeps its controls.
  assert.equal(card(3).querySelector("[data-ask-verdict]")!.textContent, "2 of 4 changes answered");
  assert.ok(card(3).querySelector("[data-ask-approve]"));
  // No reply box beside a composer that shows the batch.
  assert.equal(q("[data-proposal-reply-box], [data-reply-hint]"), null);
  // Approve on a card answers the ask whole: one answer in the batch over
  // every change it holds, the numbers ascending, the ids in the order they
  // apply. Nothing is decided; the card says the answer waits.
  await click(card(0).querySelector("[data-ask-approve]"));
  assert.deepEqual(batch(), [["ask:0", "approve", "", [7, 8], ORG_STAFFING_FIXTURE_PROPOSAL.changes.filter((c) => c.seq === 8 || c.seq === 7).sort((a, b) => b.seq - a.seq).map((c) => c._id)]]);
  assert.equal(card(0).getAttribute("data-ask-answer"), "approve");
  assert.equal(card(0).querySelector("[data-ask-approve]")!.getAttribute("aria-pressed"), "true");
  assert.equal(card(0).querySelector("[data-ask-pending]")!.textContent, "on your next message");
  assert.equal(card(0).getAttribute("data-ask-state"), "open", "an answer decides nothing");
  assert.deepEqual(calls, [], "and fires no verdict");
  // Pressed again, it withdraws.
  await click(card(0).querySelector("[data-ask-approve]"));
  assert.deepEqual(batch(), []);
  assert.equal(card(0).getAttribute("data-ask-answer"), null);
  // Reject opens the field under the controls; the words are the batch's as they are typed.
  await click(card(2).querySelector("[data-ask-reject]"));
  const contentSeq = ORG_STAFFING_FIXTURE_PROPOSAL.changes.find((c) => c.change.kind === "role" && c.change.handle === "content")!.seq;
  assert.deepEqual(batch().map((r) => r.slice(0, 4)), [["ask:2", "reject", "", [contentSeq]]]);
  const why = card(2).querySelector<HTMLTextAreaElement>("[data-ask-reply-field] textarea");
  assert.equal(why!.placeholder, "Why not? Say what you want instead.");
  await type(why, "Not this quarter");
  assert.deepEqual(batch().map((r) => r.slice(0, 3)), [["ask:2", "reject", "Not this quarter"]]);
  // Enter saves and closes; the words show as the person's own.
  await key(card(2).querySelector("[data-ask-reply-field] textarea"), "Enter");
  assert.equal(card(2).querySelector("[data-ask-reply-field]"), null);
  assert.equal(card(2).querySelector("[data-ask-you]")!.textContent, "You: Not this quarter");
  // Reply alone is a note: words with no verdict.
  await click(card(1).querySelector("[data-ask-reply]"));
  assert.equal(card(1).querySelector<HTMLTextAreaElement>("[data-ask-reply-field] textarea")!.placeholder, "Say something about this");
  await type(card(1).querySelector("[data-ask-reply-field] textarea"), "Who else was considered?");
  assert.deepEqual(batch().map((r) => r.slice(0, 3)), [["ask:2", "reject", "Not this quarter"], ["ask:1", "note", "Who else was considered?"]]);
  await clearBatch();
  // No cost line and no arithmetic (org-staffing.md S23.2): a proposal says
  // nothing about what a role may do in a day.
  assert.equal(q("[data-cost]"), null);
  assert.equal(q("[data-cost-line]"), null);
  assert.equal(q('[data-summary-detail="budget"]'), null);
  // No composer of the Head of People's: the page renders the author's thread.
  assert.equal(q("[data-composer]"), null);
  assert.equal(q("[data-thread]"), null);

  // ── the fold: the ask's entries, one fold at a time ──
  await act(async () => (card(3).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(card(3).getAttribute("data-ask-state"), "open");
  assert.equal(qa("[data-ask-rows]").length, 1, "one fold open at a time");
  // One entry per thing changed: the project, the role, the new project.
  assert.deepEqual(entries().map((el) => el.getAttribute("data-subject")), ["project:growth", "role:growth", "projects:fixture-change-3"]);
  assert.deepEqual(entries().map((el) => el.getAttribute("data-subject-variant")), ["full", "full", "full"], "a short fold draws every entry in full");
  // The limit (fixture-change-4) is never drawn (S23.2): it rides on its role's entry and is answered with it.
  assert.deepEqual(entries().map((el) => el.getAttribute("data-change-ids")), ["fixture-change-6", "fixture-change-4 fixture-change-5", "fixture-change-3"]);
  assert.ok(!/tokens|800,000|800k|wakes/.test(q("[data-ask-rows]")!.textContent ?? ""), "no limit number inside the fold either");
  // An entry reads as a sentence with the name of what it changes in bold, and its fields under it.
  assert.match(entry("project:growth").querySelector("[data-subject-sentence]")!.textContent!, /^Make Growth a high priority/);
  assert.equal(entry("project:growth").querySelector("[data-subject-sentence] b")!.textContent, "Growth");
  assert.equal(field("project:growth", "priority")!.getAttribute("data-field-after"), "P1");
  // An entry that waits carries Approve, Reject and Reply; a decided one says where it stands.
  assert.equal(qa('[data-ask-rows] [data-subject-status="proposed"] [data-subject-approve]').length, 1);
  assert.equal(qa('[data-ask-rows] [data-subject-status="accepted"] [data-subject-approve]').length, 0);
  assert.equal(entry("projects:fixture-change-3").querySelector("[data-subject-state]")!.textContent, "Approved");
  // Edit belongs to the entry in hand.
  assert.equal(q("[data-ask-rows] [data-subject-edit]"), null);
  // A card's Reject saves its words in the batch, over the card's own changes, and decides nothing.
  await click(entry("project:growth").querySelector("[data-subject-reject]"));
  await type(entry("project:growth").querySelector("[data-subject-reply-field] textarea"), "P2 is enough");
  assert.deepEqual(batch(), [["project:growth", "reject", "P2 is enough", [6], ["fixture-change-6"]]]);
  assert.deepEqual(calls, []);
  // The ask's own Approve over it withdraws the card's answer: one answer stands for a change.
  await click(card(3).querySelector("[data-ask-approve]"));
  assert.deepEqual(batch().map((r) => r.slice(0, 2)), [["ask:3", "approve"]]);
  assert.equal(entry("project:growth").getAttribute("data-subject-answer"), null);
  // And a card's answer inside withdraws the ask's.
  await click(entry("project:growth").querySelector("[data-subject-approve]"));
  assert.deepEqual(batch().map((r) => r.slice(0, 2)), [["project:growth", "approve"]]);
  assert.equal(card(3).getAttribute("data-ask-answer"), null);
  await clearBatch();
  await act(async () => entry("project:growth").querySelector<HTMLElement>("[data-subject-sentence]")!.click());
  assert.equal(calls.pop(), "select:fixture-change-6");
  // Opening another fold closes this one. An entry alone in its fold is the
  // one in hand: Edit on a role is the hire dialog, and the role says how long it stays (S10).
  await act(async () => (card(1).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.deepEqual(entries().map((el) => el.getAttribute("data-subject")), ["role:platform"]);
  assert.equal(entry("role:platform").querySelector("[data-subject-sentence]")!.textContent, "Add the role Head of Platform, reporting to you.");
  await act(async () => entry("role:platform").querySelector<HTMLButtonElement>("[data-subject-edit]")!.click());
  assert.equal(calls.pop(), "editRole:fixture-change-1");
  assert.equal(field("role:platform", "stays")!.getAttribute("data-field-after"), "standing");
  assert.equal(field("role:platform", "area")!.getAttribute("data-field-after"), "Platform");
  // A change focused from the chart opens the card that holds it, with its
  // entry in hand: the reason under the fields, then Edit.
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: "fixture-change-6" });
  assert.equal(q('[data-ask="3"] [data-subject="project:growth"]')!.getAttribute("data-selected"), "true", "the focused change's card opens with its entry in hand");
  assert.match(entry("project:growth").querySelector("[data-subject-reasons]")!.textContent!, /The Growth project has no goal on record/);
  assert.deepEqual([...entry("project:growth").querySelectorAll("[data-subject-verdicts] button")].map((b) => b.textContent?.trim()), ["Approve", "Reject", "Reply"]);
  assert.ok(entry("project:growth").querySelector("[data-subject-edit]"));
  assert.equal(qa("[data-ask-rows] [data-subject-edit]").length, 1, "and no other entry offers it");
  // Closing the card lets go of the focused change.
  await act(async () => (card(3).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "select:null");
  // Edit on a project's change is the inline form, under its entry; accept
  // with edits is the one direct verdict left, and says what the page had read (S18).
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: "fixture-change-6" });
  await act(async () => entry("project:growth").querySelector<HTMLButtonElement>("[data-subject-edit]")!.click());
  assert.equal(calls.pop(), "select:fixture-change-6");
  const input = entry("project:growth").querySelector('[data-edit-form] span[title="goal"]')?.parentElement?.querySelector<HTMLInputElement>("input") ?? null;
  assert.ok(input, "the edit form, inside the entry");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Triple organic signups by December");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => q("[data-edit-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(calls.pop(), 'decide:fixture-change-6:accept:{"goal":"Triple organic signups by December"}:{"revised_at":0}');
  // A record's entry inside the records ask (S9): the record by its title, the
  // status it moves to, and the evidence as the reason. No id stands for it.
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: "fixture-change-7" });
  assert.deepEqual(entries().map((el) => el.getAttribute("data-subject")), ["plan:pl-61", "task:ct-4102"]);
  assert.equal(entry("plan:pl-61").querySelector("[data-subject-sentence]")!.textContent, "Mark the plan Onboarding emails as done.");
  assert.equal(entry("plan:pl-61").querySelector("[data-subject-sentence] b")!.textContent, "Onboarding emails");
  assert.equal(field("plan:pl-61", "status")!.getAttribute("data-field-after"), "done");
  assert.match(entry("plan:pl-61").querySelector("[data-subject-reasons]")!.textContent!, /Every task closed 19 days ago/);
  assert.doesNotMatch(entry("plan:pl-61").querySelector("[data-subject-sentence]")!.textContent!, /pl-61/, "the id never stands for the record");
  await act(async () => entry("plan:pl-61").querySelector<HTMLButtonElement>("[data-subject-edit]")!.click());
  const statusSelect = q<HTMLSelectElement>('[data-edit-form] select[data-edit-select="status"]');
  assert.deepEqual([...statusSelect!.options].map((o) => o.value), ["done", "abandoned", "active"]);

  // ── decided asks: the verdict under the title, the controls gone, the fold kept ──
  const decided = { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => c.seq === 7 || c.seq === 8 ? { ...c, status: "applied" as const } : c.seq === 1 ? { ...c, status: "skipped" as const } : c.seq === 2 ? { ...c, status: "failed" as const, applied_note: "handle content is taken" } : c) };
  await render({ proposal: decided, proposals: [decided], selectedChangeId: null });
  assert.match(q("[data-asks-header]")!.textContent!, /2 of 4 answered$/);
  assert.equal(card(0).getAttribute("data-ask-state"), "accepted");
  // The verdict line is staffingAsks' (verdictLine); its words are that file's to move.
  assert.equal(card(0).querySelector("[data-ask-verdict]")!.textContent, "Approved");
  assert.equal(card(0).querySelector("[data-ask-controls]"), null);
  assert.equal(card(0).querySelector("[data-ask-why]"), null);
  assert.equal(card(1).getAttribute("data-ask-state"), "skipped");
  assert.equal(card(1).querySelector("[data-ask-verdict]")!.textContent, "Rejected");
  // A failed row is still the person's (the server takes it again): the ask stays open and its Approve reads Retry.
  assert.equal(card(2).getAttribute("data-ask-state"), "open");
  assert.equal(card(2).querySelector("[data-ask-verdict]")!.textContent, "1 change failed. Approve tries it again");
  assert.equal(card(2).querySelector("[data-ask-approve]")!.textContent, "Retry");
  await act(async () => (card(0).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(qa('[data-ask="0"] [data-subject-status="applied"]').length, 2);
  assert.deepEqual(qa('[data-ask="0"] [data-subject-state]').map((el) => el.textContent), ["Approved", "Approved"]);
  assert.equal(q('[data-ask="0"] [data-subject-approve]'), null, "a decided entry has nothing left to press");

  // ── the author revised rows since the reader last looked (S18): the card says so ──
  const amendedRow = { ...ORG_STAFFING_FIXTURE_PROPOSAL.changes[5], revision: { kind: "amended" as const, note: "Raised on your note.", at: Date.now(), before: ORG_STAFFING_FIXTURE_PROPOSAL.changes[5].change } };
  const revisedProposal = { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => c._id === amendedRow._id ? amendedRow : c) };
  await render({ proposal: revisedProposal, proposals: [revisedProposal], selectedChangeId: null, revised: { rows: [amendedRow], who: "Head of People", onSeen: () => calls.push("seen") } });
  assert.equal(qa("[data-ask-revised]").length, 1);
  assert.match(card(3).querySelector("[data-ask-revised]")!.textContent!, /Head of People changed 1 since you last looked/);
  // An answer on the revised ask still only waits; what the send read is
  // built at the send from the store's rows (proposalSeen), not here.
  await click(card(3).querySelector("[data-ask-approve]"));
  assert.deepEqual(batch().map((r) => r.slice(0, 2)), [["ask:3", "approve"]]);
  await clearBatch();
  await act(async () => (card(3).querySelector("[data-revised-seen]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "seen");
  await act(async () => (card(3).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(entry("project:growth").getAttribute("data-revised-new"), "true");
  assert.match(entry("project:growth").querySelector("[data-revision]")!.textContent!, /Changed.*Raised on your note/);

  // ── a records ask at scale (S9 inside S19): one card, the entries paged inside the fold ──
  const big = ORG_STAFFING_FIXTURE_BIG_PROPOSAL;
  await render({ proposal: big, proposals: [big], selectedChangeId: null });
  assert.match(q("[data-asks-header]")!.textContent!, /0 of \d+ answered$/);
  assert.equal(card(0).querySelector("[data-ask-title]")!.textContent, "Bring 111 records up to date");
  assert.match(card(0).querySelector("[data-ask-fold]")!.textContent!, /^111 records/);
  assert.equal(qa("[data-subject]").length, 0);
  await act(async () => (card(0).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(entries().length, 25, "a page of entries, not a hundred");
  assert.deepEqual([...new Set(entries().map((el) => el.getAttribute("data-subject-variant")))], ["row"], "a long fold draws one line an entry");
  assert.ok(entries().every((el) => el.querySelector("[data-subject-approve]") && el.querySelector("[data-subject-reject]")), "each line with its own Approve and Reject");
  await act(async () => q<HTMLButtonElement>("[data-ask-show-all]")!.click());
  assert.equal(entries().length, 111 - 9, "nine carried tasks are answered with their plan instead of standing alone");
  assert.equal(q("[data-ask-show-all]"), null);
  // A plan that closes its tasks holds them: one press answers the tasks and
  // the plan as one, with every id in the order they apply.
  assert.equal(entry("plan:pl-501").getAttribute("data-change-ids"), "fixture-big-9 fixture-big-10 fixture-big-11 fixture-big-12 fixture-big-1");
  await click(entry("plan:pl-501").querySelector("[data-subject-approve]"));
  assert.deepEqual(batch(), [["plan:pl-501", "approve", "", [1], ["fixture-big-9", "fixture-big-10", "fixture-big-11", "fixture-big-12", "fixture-big-1"]]]);
  await clearBatch();
  // Picked, the line opens in full and names the tasks that close with the plan.
  await act(async () => entry("plan:pl-501").click());
  assert.equal(calls.pop(), "select:fixture-big-1");
  await render({ proposal: big, proposals: [big], selectedChangeId: "fixture-big-1" });
  assert.equal(entry("plan:pl-501").getAttribute("data-subject-variant"), "full");
  assert.equal(field("plan:pl-501", "carried")!.getAttribute("data-field-after")!.split(", ").length, 4);
  // A change focused from the chart that sits past the first page is still shown.
  const late = big.changes.filter((c) => c.change.kind === "task_status").at(-1)!;
  await render({ proposal: big, proposals: [big], selectedChangeId: late._id });
  assert.ok(entries().length > 25 && q("[data-ask-rows] [data-selected]"), "the page opens far enough to hold the focused entry");
  // The ask's Approve puts one answer over every record in it.
  await click(card(0).querySelector("[data-ask-approve]"));
  assert.equal(batch()[0][4].length, 111);
  await clearBatch();

  // ── before the change rows land, the header says so ──
  await render({ proposal: { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: [], counts: { total: 12, decided: 3, applied: 1, failed: 1, skipped: 1 } }, selectedChangeId: null });
  assert.match(q("[data-asks-header]")!.textContent!, /loading$/);
  assert.ok(q("[data-changes-loading]"));
  assert.equal(q("[data-cost]"), null);

  // ── supersession (S4): the replaced proposal says so, with Withdraw; the newer says what it replaces ──
  const older = { ...ORG_STAFFING_FIXTURE_SESSION_PROPOSAL, superseded_by: { id: ORG_STAFFING_FIXTURE_PROPOSAL._id, short_id: ORG_STAFFING_FIXTURE_PROPOSAL.short_id, status: "open" as const, created_at: ORG_STAFFING_FIXTURE_PROPOSAL.created_at } };
  const newer = { ...ORG_STAFFING_FIXTURE_PROPOSAL, supersedes: { id: older._id, short_id: older.short_id, status: "open" as const, created_at: older.created_at } };
  await render({ proposal: older, proposals: [older, newer], selectedChangeId: null, onWithdraw: (id: string) => calls.push(`withdraw:${id}`) });
  const replaced = q("[data-superseded-by]")!;
  assert.equal(replaced.getAttribute("data-superseded-by"), "op-7");
  assert.match(replaced.textContent!, /^A newer proposal replaced this one \d+[smhd] ago\. Open itWithdraw$/);
  assert.equal(q("[data-supersedes]"), null);
  await act(async () => q<HTMLButtonElement>("[data-withdraw]")!.click());
  assert.equal(calls.pop(), `withdraw:${older._id}`);
  await act(async () => q<HTMLButtonElement>("[data-superseded-by] button")!.click());
  assert.equal(calls.pop(), "pick:op-7");
  await render({ proposal: { ...older, status: "withdrawn" as const }, proposals: [older, newer], selectedChangeId: null, onWithdraw: () => calls.push("withdraw") });
  assert.ok(q("[data-superseded-by]"));
  assert.equal(q("[data-withdraw]"), null);
  await render({ proposal: newer, proposals: [older, newer], selectedChangeId: null });
  assert.equal(q("[data-superseded-by]"), null);
  assert.match(q("[data-supersedes]")!.textContent!, /Replaces an earlier proposal/);
  // Another open proposal is reachable from the foot, by its title, never a picker.
  assert.match(q("[data-other-proposals]")!.textContent!, /One more proposal is openRetire the ops seat/);
  await act(async () => q<HTMLButtonElement>("[data-other-proposals] button")!.click());
  assert.equal(calls.pop(), "pick:op-8");

  // ── a proposal no agent wrote: the Head of People's composer, and answers that apply with nobody told ──
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null, thread: null, threadComposerOnScreen: false });
  assert.ok(q("[data-composer]"));
  assert.equal(q("[data-thread]")!.getAttribute("data-thread"), "fixture-head-conv");
  // With no thread the answers wait under the proposal's own key, and the box says nobody is told.
  const OWN = `proposal:${ORG_STAFFING_FIXTURE_PROPOSAL._id}`;
  assert.ok(q("[data-reply-hint]"), "the hint, the first time");
  assert.equal(q("[data-reply-hint]")!.textContent, "Answer the changes above, then send.");
  await click(card(1).querySelector("[data-ask-approve]"));
  assert.deepEqual(batch(OWN).map((r) => r.slice(0, 2)), [["ask:1", "approve"]]);
  assert.deepEqual(batch(), [], "not under the thread's key");
  assert.equal(q("[data-reply-hint]"), null);
  assert.ok(q("[data-reply-no-thread]"));
  assert.equal(q("[data-proposal-reply-box] [data-send-answers]")!.textContent, "Send 1 answer");
  sends.length = 0;
  await click(q("[data-proposal-reply-box] [data-send-answers]"));
  assert.equal(sends.length, 1, "one store action");
  assert.equal(sends[0][0], ORG_STAFFING_FIXTURE_PROPOSAL._id);
  assert.deepEqual(sends[0][1].map((i: any) => i.verdict), ["approve"]);
  assert.equal(sends[0][3].say, undefined, "no thread, nothing said");
  assert.deepEqual(batch(OWN), [], "the answers left the batch");
  assert.equal(q("[data-proposal-reply-box], [data-reply-hint]"), null, "and the box is gone");

  // ── S19's test on the first screen: a cold reader, no scrolling ──
  // Every word before the fold, in screen order, checked against the words
  // the glossary exists to define. None may be needed to say what is asked,
  // what it changes, and what to press.
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  const firstScreen = [q("[data-asks-header]"), ...qa("[data-ask]")].map((el) => el!.textContent).join("\n");
  console.log("first screen, in order:\n" + firstScreen.replace(/\n/g, "\n  "));
  const hit = firstScreen.match(needsGlossary);
  assert.equal(hit, null, `the first screen needs the glossary for "${hit?.[0]}"`);
  assert.match(firstScreen, /Approve/);
  assert.match(firstScreen, /Reject/);
  assert.match(firstScreen, /Reply/);
  assert.match(firstScreen, /If you approve:/);

  // ── no proposal, a Head of People: the health page has it, and the sheet says so ──
  await render({ proposal: null, selectedChangeId: null, onOpenHealth: () => calls.push("health") });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "health");
  assert.match(q("[data-health-pointer]")!.textContent!, /No proposal is open/);
  assert.equal(q("[data-composer]"), null, "the Head of People's conversation lives on the health page");
  await act(async () => q<HTMLButtonElement>("[data-open-health]")!.click());
  assert.equal(calls.pop(), "health");

  // ── no head of people: the two buttons, then reviewing ──
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, head: null });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "no_head_of_people");
  await act(async () => button("Hire a Head of People").click());
  assert.equal(calls.pop(), "hire");
  await act(async () => button("Propose an org now").click());
  assert.equal(calls.pop(), "propose");
  assert.equal(q("[data-composer]"), null);
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, head: null, reviewing: true, reviewSessionId: "stub-review-1" });
  assert.ok(q("[data-reviewing]"));
  assert.equal(qa("button").find((b) => b.textContent?.trim() === "Hire a Head of People"), undefined);
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, head: null, reviewing: false, reviewEnded: true, reviewSessionId: "conv-ended" });
  assert.match(q("[data-review-ended]")!.textContent!, /The review stopped without making a proposal/);
  assert.ok(qa("button").find((b) => b.textContent?.trim() === "Propose an org now"), "the buttons are back");
  await act(async () => q<HTMLButtonElement>("[data-review-ended] button")!.click());
  assert.equal(calls.pop(), "open:conv-ended");
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, head: null, reviewing: true, reviewSessionId: "stub-review-1" });
  await act(async () => q<HTMLButtonElement>("[data-review-session]")!.click());
  assert.equal(calls.pop(), "open:stub-review-1");

  // ── a link into another workspace: the line alone ──
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null, link: { kind: "foreign", shortId: "op-4", workspaceName: "Codecast", onSwitch: () => calls.push("switch") } });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "link");
  assert.match(q("[data-proposal-link]")!.textContent!, /op-4belongs to Codecast/);
  assert.doesNotMatch(text(), /Split growth, own the platform work/);
  assert.equal(qa("[data-ask]").length, 0);
  await act(async () => button("Switch").click());
  assert.equal(calls.pop(), "switch");
  await render({ proposal: null, selectedChangeId: null, proposals: [], tree: ORG_FIXTURE, head: null, link: { kind: "unreadable", shortId: "op-99" } });
  assert.match(q("[data-proposal-link]")!.textContent!, /op-99is not a proposal you can read/);
  assert.equal(q("[data-no-head]"), null, "the hire buttons of the active workspace do not answer a link elsewhere");
  await render({ proposal: null, selectedChangeId: null, proposals: [], link: { kind: "loading", shortId: "op-99" } });
  assert.match(q("[data-proposal-link]")!.textContent!, /looking it up/);

  // ── what an approval takes over, said before it (R1) ──
  // The page reads the counts in one query and hands them in by change id;
  // only a change that would move a session has one. The ask and, inside the
  // fold, the entry both say it. (The "leave them" edit does not ride on an
  // answer yet: SubjectAnswer carries no leave_sessions.)
  const moves = { "fixture-change-1": { phrase: "12 sessions now report to @platform and leave your needs input", count: 12, kept_in_front: 0, over_cap: 0 } };
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null, takeovers: moves });
  const holder = qa("[data-ask]").find((el) => el.querySelector("[data-takeover]"));
  assert.ok(holder, "the ask that holds the role change says what approving it moves");
  assert.equal(qa("[data-ask] [data-takeover]").length, 1, "and no other ask says anything");
  assert.match(holder!.querySelector("[data-takeover-phrase]")!.textContent!, /^12 sessions now report to @platform and leave your needs input\.$/);
  assert.match(holder!.querySelector("[data-takeover]")!.textContent!, /Leave the sessions where they are/);
  await act(async () => holder!.querySelector<HTMLButtonElement>("[data-ask-fold]")!.click());
  const moving = entry("role:platform");
  assert.match(moving.querySelector("[data-takeover-phrase]")!.textContent!, /12 sessions now report to @platform/);
  // An entry that moves nothing says nothing.
  await act(async () => (card(3).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.equal(entries().length, 3);
  assert.equal(q("[data-ask-rows] [data-takeover]"), null);

  // ── the company's goals (initiatives-projects-role-page.md "I1, revised") ──
  // Three goal changes fold into one goals ask and read as two entries, one a
  // goal: a sentence for a cold reader, the projects named from the chart
  // where it knows them, the owner as a role's face or a person's face.
  await render({ proposal: ORG_STAFFING_FIXTURE_SESSION_PROPOSAL, proposals: [ORG_STAFFING_FIXTURE_SESSION_PROPOSAL], selectedChangeId: null });
  assert.equal(qa("[data-ask-title]")[0].textContent, "1 goal to set, and 2 changes to the goals that exist", "the goals ask comes before the seats");
  assert.equal(qa("[data-ask-fold]")[0].textContent?.trim(), "3 changes");
  await act(async () => (card(0).querySelector("[data-ask-fold]") as HTMLButtonElement).click());
  assert.deepEqual(entries().map((el) => el.getAttribute("data-subject")), ["goal:fixture-change-10", "goal:in-3"]);
  assert.deepEqual(entries().map((el) => el.getAttribute("data-change-ids")), ["fixture-change-10", "fixture-change-11 fixture-change-12"], "two changes to one goal are one entry");
  const goal = entry("goal:fixture-change-10");
  assert.equal(goal.querySelector("[data-subject-sentence]")!.textContent, "Add the goal Win the private network at the top level.");
  assert.equal(field("goal:fixture-change-10", "projects")!.getAttribute("data-field-after"), "Growth, pr-77", "projects by the chart's name where it knows one");
  assert.equal(field("goal:fixture-change-10", "owner")!.getAttribute("data-field-after"), "Head of Growth");
  assert.ok(field("goal:fixture-change-10", "owner")!.querySelector('[data-face="role"]'), "the role's face");
  assert.equal(field("goal:fixture-change-10", "metrics")!.getAttribute("data-field-after"), "no number yet");
  const kept = entry("goal:in-3");
  assert.equal(kept.querySelector("[data-subject-sentence]")!.textContent, "Have Growth carry Every project has a lead and make Ashot Petrosian its owner.");
  assert.equal(kept.querySelector("[data-subject-sentence] b")!.textContent, "Every project has a lead");
  assert.equal(field("goal:in-3", "projects")!.getAttribute("data-field-after"), "Growth");
  assert.equal(field("goal:in-3", "owner")!.getAttribute("data-field-after"), "Ashot Petrosian");
  assert.ok(field("goal:in-3", "owner")!.querySelector('[data-face="person"]'), "the person's face");
  // Its Approve answers both changes as one, in the order they apply.
  await click(kept.querySelector("[data-subject-approve]"));
  const seqOf = (id: string) => ORG_STAFFING_FIXTURE_SESSION_PROPOSAL.changes.find((c) => c._id === id)!.seq;
  assert.deepEqual(batch(), [["goal:in-3", "approve", "", [seqOf("fixture-change-11"), seqOf("fixture-change-12")].sort((a, b) => a - b), ["fixture-change-11", "fixture-change-12"]]]);
  await clearBatch();
  // The card's why and effect are the author's for a lone change, and the
  // derived sentence for a fold of several.
  assert.match(card(0).querySelector("[data-ask-effect]")!.textContent!, /3 changes on the initiatives page/);

  // ── a proposal that is one ask (S39): its entries under the title, the ledger's closing row ──
  // Eleven goal changes in one stored ask: no card, no fold. The purpose
  // leads, every goal under it follows, and two changes to one goal are one
  // entry, so ten entries stand under the title with the count in entries.
  const goalsLive = { tree: UNION_GOALS_TREE, goals: UNION_GOALS_DATA.initiatives, projects: UNION_GOALS_DATA.projects, plans: [], tasks: [] };
  const union = { tree: UNION_GOALS_TREE, head: findHeadOfPeople(UNION_GOALS_TREE), proposal: UNION_GOALS_PROPOSAL, proposals: [UNION_GOALS_PROPOSAL], live: goalsLive, selectedChangeId: null };
  await render(union);
  assert.equal(q("[data-asks-header]")!.textContent, "Name the goals the work already serves10 to decide");
  assert.equal(qa("[data-ask]").length, 1);
  assert.equal(card(0).getAttribute("data-ask-state"), "open");
  assert.equal(q("[data-ask-fold]"), null, "nothing to open");
  assert.equal(q("[data-ask-title]"), null);
  assert.equal(entries().length, 10);
  assert.deepEqual([...new Set(entries().map((el) => el.getAttribute("data-subject-variant")))], ["full"], "every entry in full, however many");
  assert.deepEqual(entries().map((el) => el.querySelector("[data-subject-ordinal]")!.textContent), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.equal(entries()[0].querySelector("[data-subject-sentence]")!.textContent, "Set Broker high-value introductions that become real transactions as the purpose.");
  // A goal with goals under it does not list its projects: it says how many, and where to read them.
  assert.match(entries()[0].querySelector('[data-field="projects"]')!.textContent!, /^9 projects, through the goals below/);
  // A target reads as its author wrote it.
  assert.match(q("[data-ask-rows]")!.textContent!, /Fees collected, target The first dollar/);
  // What was there before comes from the live records: the goal that exists moves from the top level.
  const moved = entry("goal:union-in-4");
  assert.equal(moved.getAttribute("data-change-ids"), "union-quality-projects union-quality-shape", "two changes to one goal, in the order they apply");
  assert.equal(moved.querySelector('[data-field="parent"]')!.getAttribute("data-field-before"), "at the top level");
  assert.equal(moved.querySelector('[data-field="parent"]')!.getAttribute("data-field-after"), "under the purpose");
  // The closing row is the ledger's: Chart, Approve all, Reply, and no filled
  // button until something is answered. With the composer on screen there is
  // no box here; the row's Send sends the batch itself.
  const close = () => q("[data-ask-close] [data-ledger-close]")!;
  assert.deepEqual([...close().querySelectorAll("button")].map((b) => b.textContent?.trim()), ["Chart", "Approve all 10", "Reply"]);
  assert.equal(q("[data-proposal-reply-box]"), null);
  // An entry's own Approve is that entry alone: its two changes, in the order they apply, one answer.
  await click(moved.querySelector("[data-subject-approve]"));
  assert.deepEqual(batch(), [["goal:union-in-4", "approve", "", [9, 10], ["union-quality-projects", "union-quality-shape"]]]);
  assert.equal(moved.querySelector("[data-subject-pending]")!.textContent, "on your next message");
  assert.deepEqual([...close().querySelectorAll("button")].map((b) => b.textContent?.trim()), ["Chart", "Approve the rest", "Reply", "Send 1 answer"]);
  // Approve the rest: an answer on every card that waits and has none, ten in all.
  await click(close().querySelector("[data-approve-rest]"));
  assert.equal(batch().length, 10);
  assert.equal(close().querySelector("[data-send-answers]")!.textContent, "Send 10 answers");
  // Send: one store action for the proposal, every answer in it, said into the thread; the batch empties.
  sends.length = 0;
  await click(close().querySelector("[data-send-answers]"));
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], UNION_GOALS_PROPOSAL._id);
  assert.equal(sends[0][1].length, 10);
  assert.deepEqual(sends[0][1].flatMap((i: any) => i.seqs).sort((x: number, y: number) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(sends[0][3].say.thread, THREAD);
  assert.deepEqual(batch(), []);
  assert.ok(!calls.some((c) => c.startsWith("decide:")), "no direct verdict anywhere");
  calls.length = 0;
  // Edit comes with the entry in hand, picked here or focused from the chart.
  await act(async () => moved.querySelector<HTMLElement>("[data-subject-sentence]")!.click());
  assert.equal(calls.pop(), "select:union-quality-shape");
  await render({ ...union, selectedChangeId: "union-quality-projects" });
  assert.equal(entry("goal:union-in-4").getAttribute("data-selected"), "true", "either of its changes puts the entry in hand");
  assert.equal(entry("goal:union-in-4").querySelector("[data-subject-edit]"), null, "two changes: nothing single to edit");
  // S19's test on this first screen too: the entries are what a cold reader meets now.
  await render(union);
  const loneScreen = [q("[data-asks-header]"), ...qa("[data-ask]")].map((el) => el!.textContent).join("\n");
  console.log("first screen of a lone ask, in order:\n  " + loneScreen.replace(/\n/g, "\n  "));
  const loneHit = loneScreen.match(needsGlossary);
  assert.equal(loneHit, null, `the lone ask's first screen needs the glossary for "${loneHit?.[0]}"`);
  // Mid way the header and the closing row count what is left; decided, the row says what happened.
  const decide = (p: typeof UNION_GOALS_PROPOSAL, status: Record<number, "applied" | "skipped" | "failed">) => ({ ...p, changes: p.changes.map((c) => (status[c.seq] ? { ...c, status: status[c.seq], ...(status[c.seq] === "failed" ? { applied_note: "No goal by that name." } : {}) } : c)) });
  const midway = decide(UNION_GOALS_PROPOSAL, { 1: "applied", 2: "skipped", 3: "failed" });
  await render({ ...union, proposal: midway, proposals: [midway] });
  assert.equal(q("[data-progress]")!.textContent, "7 of 10 to decide · 1 approved, 1 rejected, 1 failed");
  assert.deepEqual([...q("[data-ask-close]")!.querySelectorAll("button")].map((b) => b.textContent?.trim()), ["Chart", "Approve the rest", "Reply"]);
  assert.match(entry("goal:union-funnel").querySelector("[data-failed-note]")!.textContent!, /^Failed: No goal by that name\.$/);
  assert.equal(entry("goal:union-funnel").querySelector("[data-subject-approve]")!.textContent, "Retry");
  const done = decide(UNION_GOALS_PROPOSAL, Object.fromEntries(UNION_GOALS_PROPOSAL.changes.map((c) => [c.seq, c.seq === 2 ? "skipped" : "applied"] as const)));
  await render({ ...union, proposal: done, proposals: [done] });
  assert.equal(card(0).getAttribute("data-ask-state"), "accepted");
  assert.equal(q("[data-ask-close] [data-proposal-outcome]")!.textContent, "9 approved, 1 rejected");
  assert.deepEqual([...q("[data-ask-close]")!.querySelectorAll("button")].map((b) => b.textContent?.trim()), ["Chart"], "nothing left to answer");

  // ── the lone ask with no composer on screen: the box under the closing row ──
  await render({ ...union, threadComposerOnScreen: false });
  assert.ok(q("[data-ask-close] [data-reply-hint]"), "the hint, under the row");
  assert.deepEqual([...close().querySelectorAll("button")].map((b) => b.textContent?.trim()), ["Chart", "Approve all 10", "Reply"]);
  await click(entry("goal:union-in-4").querySelector("[data-subject-reject]"));
  await type(entry("goal:union-in-4").querySelector("[data-subject-reply-field] textarea"), "Keep it at the top level");
  // The row has no filled button of its own now: the box's Send is the frame's one.
  assert.deepEqual([...close().querySelectorAll("button")].map((b) => b.textContent?.trim()), ["Chart", "Approve the rest", "Reply"]);
  const box = () => q("[data-ask-close] [data-proposal-reply-box]")!;
  assert.ok(box(), "the box, once something is answered");
  assert.equal(box().querySelector("[data-review-answer='reject'] .cc-review-tray-verdict")!.textContent, `Reject ${entry("goal:union-in-4").querySelector("[data-subject-ordinal]")!.textContent}`, "the tray names the card by the number the person sees");
  assert.equal(box().querySelector(".cc-review-tray-note")!.textContent, "Keep it at the top level");
  assert.equal(box().querySelector("[data-send-answers]")!.textContent, "Send 1 answer");
  assert.equal(box().querySelector("[data-reply-no-thread]"), null, "a thread: the author is told");
  // A typed reply rides with the answers: Enter sends once, with the words, into the thread.
  await type(box().querySelector("[data-proposal-reply-typed]"), "Thanks, the rest reads right");
  sends.length = 0;
  await key(box().querySelector("[data-proposal-reply-typed]"), "Enter");
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0][1], [{ verdict: "reject", change_ids: ["union-quality-projects", "union-quality-shape"], seqs: [9, 10], text: "Keep it at the top level" }]);
  assert.equal(sends[0][3].say.thread, THREAD);
  assert.equal(sends[0][3].say.body, "Thanks, the rest reads right");
  assert.match(sends[0][3].say.client_id, /^optimistic_/);
  assert.deepEqual(batch(), []);
  assert.equal(q("[data-proposal-reply-box], [data-reply-hint]"), null, "sent: the box is gone, and the hint does not come back");

  // ── a project's priority: what it was, read from the live record ──
  const projectChange = (id: string, seq: number, project: string, priority: string) => ({ _id: id, proposal_id: "fixture-priorities", seq, status: "proposed" as const, change: { kind: "project_meta" as const, project, priority }, rationale: `Its goal is the furthest from target (${id}).`, evidence: [] });
  const priorities = { ...UNION_GOALS_PROPOSAL, _id: "fixture-priorities", short_id: "op-55", title: "Rank the projects by the goals they carry", asks: undefined, changes: [projectChange("rank-network", 1, "Broker / Private Network", "p1"), projectChange("rank-infra", 2, "Infrastructure", "p0"), projectChange("rank-ideas", 3, "camerons ideas", "p3")] };
  const ranked = { ...goalsLive, projects: goalsLive.projects.map((p) => (p.title === "Broker / Private Network" ? { ...p, priority: "p2" } : p)) };
  await render({ ...union, proposal: priorities, proposals: [priorities], live: ranked });
  assert.equal(q("[data-ask-fold]"), null, "three changes of one kind are one ask, so one list");
  // The top priority first, whatever number its author gave it.
  assert.deepEqual(entries().map((el) => el.querySelector("[data-subject-sentence]")!.textContent), ["Make Infrastructure the top priority.", "Raise Broker / Private Network to a high priority.", "Make camerons ideas a low priority."]);
  const raised = entries()[1].querySelector<HTMLElement>('[data-field="priority"]')!;
  assert.deepEqual([raised.getAttribute("data-field-op"), raised.getAttribute("data-field-before"), raised.getAttribute("data-field-after")], ["change", "P2", "P1"]);
  const fresh = entries()[0].querySelector<HTMLElement>('[data-field="priority"]')!;
  assert.deepEqual([fresh.getAttribute("data-field-before"), fresh.getAttribute("data-field-after")], ["not set", "P0"]);
  assert.equal(q("[data-ask-close] [data-approve-rest]")!.textContent, "Approve all 3");
  assert.doesNotMatch([q("[data-asks-header]"), ...qa("[data-ask]")].map((el) => el!.textContent).join("\n"), needsGlossary);
  // With no live records in hand there is nothing to compare: the new value alone, and no claim about what was.
  await render({ ...union, proposal: priorities, proposals: [priorities], live: null });
  const cold = entries().map((el) => el.querySelector<HTMLElement>('[data-field="priority"]')!);
  assert.deepEqual(cold.map((el) => el.getAttribute("data-field-before")), [null, null, null]);
  assert.deepEqual(cold.map((el) => el.getAttribute("data-field-op")), ["set", "set", "set"]);
  assert.match(q("[data-ask-rows]")!.textContent!, /Make Broker \/ Private Network a high priority\./);

  // ── a role with what rides on it: one entry, one press, one answer over every change in the order they apply ──
  // The limit, the routine and the switch all name the role this proposal
  // adds, so they are one ask and one entry. Nothing else is in the column, so
  // there is no closing row: the entry's Approve is the whole decision, and it
  // is the column's filled button.
  const rider = (id: string, seq: number, change: any) => ({ _id: id, proposal_id: "fixture-riders", seq, status: "proposed" as const, change, rationale: `Platform has no lead (${id}).`, evidence: [] });
  const riders = { ...ORG_STAFFING_FIXTURE_PROPOSAL, _id: "fixture-riders", short_id: "op-11", title: "Give Platform a lead", asks: undefined, changes: [
    rider("ride-limit", 1, { kind: "budget", handle: "platform", caps: { tokens_per_day: 800_000 } }),
    rider("ride-routine", 2, { kind: "routine", handle: "platform", title: "Weekly platform review", prompt: "Review the week.", every: "7d" }),
    rider("ride-role", 3, { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } }),
    rider("ride-switch", 4, { kind: "trust", handle: "platform", trust: "direct" }),
  ] };
  await render({ proposal: riders, proposals: [riders], selectedChangeId: null, takeovers: { "ride-role": { phrase: "4 sessions now report to @platform and leave your needs input", count: 4, kept_in_front: 0, over_cap: 0 } } });
  assert.equal(qa("[data-ask]").length, 1);
  assert.equal(entries().length, 1);
  assert.equal(q("[data-ask-close]"), null, "one entry: no closing row");
  const seat = entry("role:platform");
  assert.equal(seat.querySelector("[data-subject-ordinal]"), null, "nothing to number");
  assert.equal(seat.querySelector("[data-subject-sentence]")!.textContent, "Add the role Head of Platform, reporting to you.");
  assert.deepEqual([...seat.querySelectorAll("[data-field]")].map((el) => el.getAttribute("data-field")), ["handle", "area", "routine", "starts_work"], "what rides along is in the fields; the limit is not");
  assert.ok(!/tokens|800,000|800k/.test(seat.textContent ?? ""));
  assert.ok(seat.querySelector("[data-subject-edit]"), "alone, it is the entry in hand");
  assert.equal(seat.querySelector("[data-subject-approve]")!.style.background, "var(--sol-violet)", "the column's one filled button");
  await click(seat.querySelector("[data-subject-approve]"));
  const [seatAnswer] = batch();
  assert.deepEqual(seatAnswer.slice(0, 2), ["role:platform", "approve"]);
  assert.deepEqual(seatAnswer[4], ["ride-role", "ride-limit", "ride-switch", "ride-routine"], "every change, the role first, in the order they apply");
  assert.ok(seatAnswer[3].includes(3) && !seatAnswer[3].includes(1), "the words name the role, never the limit");
  await clearBatch();

  await act(async () => root.unmount());
  useInboxStore.setState({ replyOnOrgProposal: realReply } as any);
  closeDomWindow(dom);
  console.log("staffing pane mount: passed");
}

if (import.meta.main) await verifyStaffingPane();
