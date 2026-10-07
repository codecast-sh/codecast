// Mounts the ledger entry (docs/architecture/org-staffing.md S39) in jsdom on
// cards built by the real model from synthetic rows: the sentence with its one
// bold name, each field with what was there before, the reasons, the answers
// (Approve, Reject, Reply and the field), the band a staged answer leaves in
// their place, and every state an entry can be in before and after the send.
// The card takes callbacks and reads no store, so nothing but the link is
// mocked. Nothing in jsdom lays out, so a line's height is faked from its
// text: ninety characters to a line.
// Run: bun test --timeout 240000 components/org/ProposalSubjectCard.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
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

const { createRoot } = await import("react-dom/client");
const { ORG_FIXTURE } = await import("./orgFixture");
const { ORG_CHARTER_EDIT_FIXTURE_PROPOSAL, ORG_LONG_CHARTER_FIXTURE_PROPOSAL, ORG_RECORDS_FIXTURE_LIVE, ESCALATIONS_CHARTER_SENTENCES } = await import("./orgRecordsFixture");
const { proposalSubjects } = await import("./proposalSubjects");
const { ProposalSubjectCard, LedgerClosingRow, StateWord } = await import("./ProposalSubjectCard");
const { StagedBand } = await import("./StagedBand");
const { OrgHoverContext } = await import("./proposalContexts");
const { passageDiff } = await import("@codecast/shared/contracts/orgChangeWords");
type OrgProposalChange = import("./orgStaffingTypes").OrgProposalChange;
type SubjectLive = import("./proposalSubjects").SubjectLive;
type SubjectCard = import("./proposalSubjects").SubjectCard;
type Props = import("./ProposalSubjectCard").ProposalSubjectCardProps;

const change = (id: string, seq: number, c: any, status: OrgProposalChange["status"] = "proposed", extra: Partial<OrgProposalChange> = {}): OrgProposalChange =>
  ({ _id: id, proposal_id: "p1", seq, change: c, rationale: `Because ${id}.`, evidence: [], status, ...extra });

const PROJECTS: SubjectLive["projects"] = [
  { _id: "p-infra", short_id: "pr-1", title: "Infrastructure", status: "active" },
  { _id: "p-funnel", short_id: "pr-2", title: "Matching & Funnel", status: "active" },
  { _id: "p-deals", short_id: "pr-3", title: "People & Deals", status: "active", owner_role_id: "fixture-role-growth", goal: "Close the first fee" },
  { _id: "p-network", short_id: "pr-5", title: "Private Network", status: "active", priority: "p2" },
  { _id: "p-quality", short_id: "pr-6", title: "Agent Quality", status: "active" },
  { _id: "fixture-project-growth", short_id: "pr-4", title: "Growth", status: "active" },
  { _id: "p-platform", short_id: "pr-11", title: "Platform", status: "active" },
];
const goal = (id: string, short: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, short_id: short, title, status: "active", project_ids: [], health: "none", workspace: "team:x", user_id: "fixture-user-me", created_at: 0, updated_at: 0, ...extra }) as any;
const LIVE: SubjectLive = {
  tree: ORG_FIXTURE,
  goals: [goal("g-net", "in-2", "Win the private network"), goal("g-proud", "in-4", "Proud relationships")],
  projects: PROJECTS,
  plans: [],
  tasks: [{ _id: "t9", short_id: "ct-9", title: "Remove the pilot", status: "in_progress" }],
};

const PURPOSE = "Broker introductions that close";
const G1 = change("g1", 1, { kind: "initiative", title: PURPOSE, description: "The business earns its fee when an introduction becomes a transaction.", owner: "Ashot Petrosian", projects: PROJECTS.slice(0, 5).map((p) => p.title) });
const G2 = change("g2", 2, { kind: "initiative", title: "Improve conversion", description: "", owner: "me", parent: PURPOSE, projects: ["Matching & Funnel"], metrics: [{ name: "Email to intro rate", target: "0.20%" }, { name: "Cold email reply rate", target: "1% higher (Cameron)" }], evidence: ["North star goals, admin home page"] });
const G9 = change("g9", 9, { kind: "initiative_shape", initiative: "in-4", parent: PURPOSE, title: "Proud relationships", metrics: [{ name: "Trust breaks per day", target: "0" }] });
const G10 = change("g10", 10, { kind: "initiative_projects", initiative: "in-4", projects: ["Agent Quality"], title: "Proud relationships" });
const RAISE = change("r4", 4, { kind: "project_meta", project: "Private Network", priority: "p1" });
const FIRST = change("r1", 1, { kind: "project_meta", project: "Infrastructure", priority: "p0" });
const ROLE = [
  change("limit", 1, { kind: "budget", handle: "platform", caps: { tokens_per_day: 800_000, wakes_per_day: 12 } }, "proposed", { rationale: "Platform gets 800k tokens." }),
  change("routine", 2, { kind: "routine", handle: "platform", title: "Weekly platform review", prompt: "Review", every: "7d" }),
  change("role", 4, { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } }),
  change("trust", 5, { kind: "trust", handle: "platform", trust: "direct" }),
];

const cardsOf = (changes: readonly OrgProposalChange[], live: SubjectLive | null = LIVE) => proposalSubjects(changes, live);
const cardOf = (changes: readonly OrgProposalChange[], title: string, live: SubjectLive | null = LIVE): SubjectCard => cardsOf(changes, live).find((c) => c.title === title)!;

// What the card writes into the batch: null withdraws.
const sent: any[] = [];
const onAnswer: Props["onAnswer"] = (answer) => { sent.push(answer); };
const APPROVE = { verdict: "approve" as const };
// What reaches the frame around a card: a click there opens or closes it.
const reached: string[] = [];
const frame = (child: React.ReactNode) => h("div", { onClick: () => reached.push("click"), onKeyDown: () => reached.push("keydown"), onPointerDown: () => reached.push("pointerdown") }, child);

function mount(props: Props, wrap: (node: React.ReactNode) => React.ReactNode = (n) => n) {
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(wrap(frame(h(ProposalSubjectCard, props)))));
  return { root, update: (next: Props) => React.act(() => root.render(wrap(frame(h(ProposalSubjectCard, next))))), done: () => React.act(() => root.unmount()) };
}
const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const qa = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const fire = (el: HTMLElement, type: string) => React.act(() => { el.dispatchEvent(type === "keydown" ? new KeyboardEvent("keydown", { key: "Enter", bubbles: true }) : new MouseEvent(type, { bubbles: true })); });
const click = (el: HTMLElement) => fire(el, "click");
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) => React.act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init })); });
// Typing: the value through the native setter, then the input event React listens for.
const type = (el: HTMLTextAreaElement, text: string) => React.act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const fieldOf = () => q("[data-subject-reply-field] textarea") as HTMLTextAreaElement | null;
const field = (key: string) => q(`[data-field='${key}']`);
const struckIn = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(".line-through")).map((x) => x.textContent);
const band = () => q("[data-staged]") as HTMLElement | null;

test("a change to a project: the sentence with one bold name, the field from what it was, the reason; Approve stages a band and Undo takes it back", () => {
  const card = cardOf([FIRST, RAISE], "Private Network");
  const m = mount({ card, ordinal: 2, onAnswer });
  const root = q("[data-subject]");
  expect(root.getAttribute("data-subject")).toBe("project:p-network");
  expect(root.getAttribute("data-subject-kind")).toBe("project");
  expect(root.getAttribute("data-subject-status")).toBe("proposed");
  expect(root.getAttribute("data-change-ids")).toBe("r4");
  expect(root.className).toContain("not-prose");
  expect(q("[data-subject-ordinal]").textContent).toBe("2");
  expect(q("[data-subject-sentence]").textContent).toBe("Raise Private Network to a high priority.");
  expect(qa("[data-subject-sentence] b").map((b) => b.textContent)).toEqual(["Private Network"]);

  // What it was is struck and plain; what it becomes carries the priority's dot.
  const priority = field("priority");
  expect(priority.getAttribute("data-field-op")).toBe("change");
  expect(priority.getAttribute("data-field-before")).toBe("P2");
  expect(priority.getAttribute("data-field-after")).toBe("P1");
  expect(struckIn(priority)).toEqual(["P2"]);
  expect(priority.querySelectorAll("i").length).toBe(1);
  expect(priority.previousElementSibling!.textContent).toBe("Priority");
  expect(q("[data-subject-reasons]").textContent).toBe("Because r4.");
  // A short reason has no clamp word.
  expect(q("[data-subject-reasons] [data-field-more]")).toBeNull();

  // In a list the entry's Approve is an outline: the frame keeps its one filled button.
  const approve = q("[data-subject-approve]");
  expect(approve.textContent).toBe("Approve");
  expect(approve.style.background).toBe("");
  expect(approve.getAttribute("aria-pressed")).toBe("false");
  expect(q("[data-subject-reject]").textContent).toBe("Reject");
  expect(q("[data-subject-reply]").textContent).toBe("Reply");
  // Nothing is decided on a press: the answer goes to the batch, and nothing else changes on the card.
  click(approve);
  expect(sent.splice(0)).toEqual([APPROVE]);
  expect(q("[data-subject-state]")).toBeNull();
  expect(band()).toBeNull();
  // With the answer in hand the controls give way to the band, and the card still reads as undecided.
  m.update({ card, ordinal: 2, onAnswer, answer: APPROVE });
  expect(q("[data-subject]").getAttribute("data-subject-answer")).toBe("approve");
  expect(q("[data-subject-approve]")).toBeNull();
  expect(q("[data-subject-reject]")).toBeNull();
  expect(band()!.getAttribute("data-staged")).toBe("approve");
  expect(band()!.textContent).toBe("Approved. Applies when you send.Undo");
  expect(band()!.getAttribute("role")).toBe("status");
  expect(band()!.className).toContain("org-pop-in");
  expect(document.body.textContent).not.toContain("on your next message");
  expect(q("[data-subject-sentence]").className).toContain("--sol-text)");
  expect(field("priority")).not.toBeNull();
  expect(q("[data-subject-state]")).toBeNull();
  expect(q("[data-subject-you]")).toBeNull();
  // Undo withdraws, and the controls come back.
  click(q("[data-staged-undo]"));
  expect(sent.splice(0)).toEqual([null]);
  expect(q("[data-staged-undo]").getAttribute("aria-label")).toBe("Undo this answer");
  m.update({ card, ordinal: 2, onAnswer, answer: null });
  expect(band()).toBeNull();
  expect(q("[data-subject-approve]")).not.toBeNull();
  // A control's click, key and pointer stay inside the card.
  fire(q("[data-subject-approve]"), "keydown");
  fire(q("[data-subject-approve]"), "pointerdown");
  expect(reached).toEqual([]);
  // No word a person could read says Accept or Skip.
  expect(document.body.textContent).not.toMatch(/accept|skip/i);
  m.done();
});

test("Reject stages the band with the field inside it, asking why; the words write through as typed and show as the person's own", () => {
  const card = cardOf([FIRST, RAISE], "Private Network");
  const m = mount({ card, ordinal: 2, onAnswer });
  expect(fieldOf()).toBeNull();
  click(q("[data-subject-reject]"));
  expect(sent.splice(0)).toEqual([{ verdict: "reject" }]);
  m.update({ card, ordinal: 2, onAnswer, answer: { verdict: "reject" } });
  expect(band()!.getAttribute("data-staged")).toBe("reject");
  expect(band()!.textContent).toBe("Rejected. Sent when you send.Undo");
  const ta = fieldOf()!;
  expect(ta).not.toBeNull();
  expect(ta.placeholder).toBe("Why not? Say what you want instead.");
  expect(document.activeElement).toBe(ta);
  expect(q("[data-subject-reply-field] kbd")).not.toBeNull();
  // The field sits in the band's area, joined under its line.
  expect(q("[data-answer-area] [data-staged]")).not.toBeNull();
  expect(q("[data-answer-area] [data-subject-reply-field]")).not.toBeNull();
  // Every keystroke is the batch's: the draft never lives in the card alone.
  type(ta, "P1 is too high");
  expect(sent.splice(0)).toEqual([{ verdict: "reject", text: "P1 is too high" }]);
  // Keys in the field never reach the frame: a space does not fold the card.
  key(ta, " ");
  key(ta, "Enter", { shiftKey: true });
  expect(reached).toEqual([]);
  expect(fieldOf()).not.toBeNull();
  // Enter saves and closes; the words sit in the band as "You".
  m.update({ card, ordinal: 2, onAnswer, answer: { verdict: "reject", text: "P1 is too high, make it P2." } });
  key(fieldOf()!, "Enter");
  expect(fieldOf()).toBeNull();
  expect(sent).toEqual([]);
  const you = q("[data-staged] [data-subject-you]");
  expect(you.textContent).toBe("You: P1 is too high, make it P2.");
  expect(you.getAttribute("data-subject-you")).toBe("reject");
  // A press on the words reopens the field with them; Esc closes it and keeps them.
  click(you);
  expect(fieldOf()!.value).toBe("P1 is too high, make it P2.");
  key(fieldOf()!, "Escape");
  expect(fieldOf()).toBeNull();
  expect(q("[data-subject-you]").textContent).toBe("You: P1 is too high, make it P2.");
  expect(reached).toEqual([]);
  // Undo withdraws the answer, words and all.
  click(q("[data-staged-undo]"));
  expect(sent.splice(0)).toEqual([null]);
  m.done();
});

test("Reply opens the field with no verdict; the first keystroke mounts the band around the same textarea; Approve then carries the words", () => {
  const card = cardOf([FIRST, RAISE], "Private Network");
  const m = mount({ card, ordinal: 2, onAnswer });
  click(q("[data-subject-reply]"));
  expect(sent).toEqual([]);
  const ta = fieldOf()!;
  expect(ta.placeholder).toBe("Say something about this change");
  expect(q("[data-subject-reply]").getAttribute("aria-expanded")).toBe("true");
  expect(band()).toBeNull();
  type(ta, "Cameron owns this");
  expect(sent.splice(0)).toEqual([{ verdict: "note", text: "Cameron owns this" }]);
  // The note is an answer now: the band appears, and the textarea under the caret is the same node.
  m.update({ card, ordinal: 2, onAnswer, answer: { verdict: "note", text: "Cameron owns this" } });
  expect(band()!.getAttribute("data-staged")).toBe("note");
  expect(band()!.textContent).toBe("Replied. Sent when you send.Undo");
  expect(fieldOf()).toBe(ta);
  expect(document.activeElement).toBe(ta);
  // An empty note is withdrawn by the batch; the field stays open all the same.
  type(fieldOf()!, "");
  expect(sent.splice(0)).toEqual([{ verdict: "note", text: "" }]);
  m.update({ card, ordinal: 2, onAnswer, answer: null });
  expect(fieldOf()).not.toBeNull();
  expect(band()).toBeNull();
  // Blank words mid thought stay in the batch while the field is open; closing it withdraws them.
  type(fieldOf()!, "  ");
  expect(sent.splice(0)).toEqual([{ verdict: "note", text: "  " }]);
  m.update({ card, ordinal: 2, onAnswer, answer: { verdict: "note", text: "  " } });
  key(fieldOf()!, "Escape");
  expect(sent.splice(0)).toEqual([null]);
  expect(fieldOf()).toBeNull();
  m.update({ card, ordinal: 2, onAnswer, answer: null });
  expect(band()).toBeNull();
  click(q("[data-subject-reply]"));
  m.update({ card, ordinal: 2, onAnswer, answer: { verdict: "note", text: " " } });
  React.act(() => { fieldOf()!.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  expect(sent.splice(0)).toEqual([null]);
  expect(fieldOf()).toBeNull();
  m.update({ card, ordinal: 2, onAnswer, answer: null });
  // With a note in hand, Approve keeps the words under the approval.
  m.update({ card, ordinal: 2, onAnswer, answer: { verdict: "note", text: "Cameron owns this, not Samvit." } });
  click(q("[data-subject-you]"));
  expect(fieldOf()!.value).toBe("Cameron owns this, not Samvit.");
  key(fieldOf()!, "Escape");
  m.update({ card, ordinal: 2, onAnswer, answer: { verdict: "approve", text: "Cameron owns this, not Samvit." } });
  expect(band()!.textContent).toBe("Approved. Applies when you send.UndoYou: Cameron owns this, not Samvit.");
  expect(q("[data-subject-you]").getAttribute("data-subject-you")).toBe("approve");
  expect(reached).toEqual([]);
  m.done();
});

test("the band's words per verdict, a retry, and an approval that leaves the sessions where they are", () => {
  const root = createRoot(document.getElementById("root")!);
  const bands = [
    h(StagedBand, { key: "a", answer: { verdict: "approve" }, onUndo() {} }),
    h(StagedBand, { key: "b", answer: { verdict: "approve" }, retry: true, onUndo() {} }),
    h(StagedBand, { key: "c", answer: { verdict: "approve", leave_sessions: true }, onUndo() {} }),
    h(StagedBand, { key: "d", answer: { verdict: "reject" }, onUndo() {} }),
    h(StagedBand, { key: "e", answer: { verdict: "note", text: "x" }, onUndo() {} }),
  ];
  React.act(() => root.render(h("div", null, bands)));
  expect(qa("[data-staged]").map((b) => [b.getAttribute("data-staged"), b.textContent])).toEqual([
    ["approve", "Approved. Applies when you send.Undo"],
    ["approve", "Retry. Runs again when you send.Undo"],
    ["approve", "Approved, and the sessions stay where they are. Applies when you send.Undo"],
    ["reject", "Rejected. Sent when you send.Undo"],
    ["note", "Replied. Sent when you send.Undo"],
  ]);
  // The first word carries the verdict's ink; the rest is quiet.
  expect(qa("[data-staged] b").map((b) => b.textContent)).toEqual(["Approved.", "Retry.", "Approved,", "Rejected.", "Replied."]);
  expect(qa("[data-staged]")[3].querySelector("b")!.className).toContain("--ink-red");
  expect(qa("[data-staged] svg").length).toBe(4);
  React.act(() => root.unmount());
});

test("a retirement: the role as its one row, struck, with its face and nothing after it", () => {
  const m = mount({ card: cardOf([change("a", 1, { kind: "retire", handle: "growth" })], "Head of Growth"), ordinal: 1, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe("Retire Head of Growth. Its sessions go back to their owners.");
  expect(qa("[data-field]").map((f) => [f.previousElementSibling!.textContent, f.getAttribute("data-field-op"), f.getAttribute("data-field-before"), f.getAttribute("data-field-after")])).toEqual([["Role", "clear", "Head of Growth", null]]);
  expect(struckIn(field("role"))).toEqual(["Head of Growth"]);
  expect(field("role").querySelector("[data-subject-face='role']")).not.toBeNull();
  expect(document.body.textContent).not.toContain("→");
  m.done();
});

test("every text field clamps at two lines with show all and show less, except the purpose's Says", () => {
  const kid = change("g3", 3, { kind: "initiative", title: "Fundraise", description: "Raise the round that funds the next year.", why: "Runway.", done_when: "The money is in the bank.", owner: "me", parent: PURPOSE, projects: ["Growth"] });
  const purpose = mount({ card: cardOf([G1, kid], PURPOSE), ordinal: 1, onAnswer });
  expect(field("says").textContent).toBe("The business earns its fee when an introduction becomes a transaction.");
  expect(field("says").querySelector("[data-field-clamp]")).toBeNull();
  purpose.done();
  const child = mount({ card: cardOf([G1, kid], "Fundraise"), ordinal: 2, onAnswer });
  expect(["says", "why", "done_when"].map((k) => field(k).querySelector("[data-field-clamp]")?.getAttribute("data-field-clamp"))).toEqual(["closed", "closed", "closed"]);
  expect(field("says").querySelector("[data-field-clamp] > span")!.className).toContain("line-clamp-2");
  // Under two lines, no word.
  expect(field("says").querySelector("[data-field-more]")).toBeNull();
  expect(field("owner").querySelector("[data-field-clamp]")).toBeNull();
  child.done();
  // op-903's charter runs to 1449 characters: the word appears, and opens the whole text.
  const long = mount({ card: cardOf(ORG_LONG_CHARTER_FIXTURE_PROPOSAL.changes, "Partnerships lead", ORG_RECORDS_FIXTURE_LIVE), ordinal: 2, onAnswer });
  const charter = field("charter");
  expect(charter.previousElementSibling!.textContent).toBe("Charter");
  const more = () => charter.querySelector<HTMLElement>("[data-field-more]")!;
  expect(more().textContent).toBe("show all");
  expect(charter.querySelector("[data-field-clamp]")!.getAttribute("data-field-clamp")).toBe("closed");
  click(more());
  expect(more().textContent).toBe("show less");
  expect(charter.querySelector("[data-field-clamp]")!.getAttribute("data-field-clamp")).toBe("open");
  expect(charter.querySelector("[data-field-clamp] > span")!.className).not.toContain("line-clamp");
  expect(reached).toEqual([]);
  // No clamp word on the sentence.
  expect(q("[data-subject-sentence] [data-field-more]")).toBeNull();
  long.done();
});

test("a charter edit draws each edit as a passage diff under one Charter label; the untouched sentences stay out of the DOM", () => {
  const edit = cardOf(ORG_CHARTER_EDIT_FIXTURE_PROPOSAL.changes, "Escalations lead", ORG_RECORDS_FIXTURE_LIVE);
  const meta = cardOf(ORG_CHARTER_EDIT_FIXTURE_PROPOSAL.changes, "Matching Engine & Funnel", ORG_RECORDS_FIXTURE_LIVE);
  const m = mount({ card: edit, ordinal: 1, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe("Rewrite a passage of Escalations lead's charter, add a line to its charter and cut a passage from its charter.");
  // The fields draw three blocks; the revision block under them draws its own.
  const blocks = Array.from(q("[data-subject-group]").querySelectorAll<HTMLElement>("[data-passage-diff]"));
  expect(blocks.length).toBe(3);
  expect(blocks.map((b) => Array.from(b.querySelectorAll("[data-diff]")).map((p) => p.getAttribute("data-diff")))).toEqual([["removed", "added"], ["added"], ["removed"]]);
  expect(blocks.map((b) => b.getAttribute("data-passage-diff"))).toEqual(["2", "1", "1"]);
  // One label for the run of edits.
  expect(Array.from(q("[data-subject-group]").querySelectorAll("dt")).map((d) => d.textContent)).toEqual(["Charter", "", ""]);
  expect(blocks[0].querySelector("del")!.textContent).toBe(ESCALATIONS_CHARTER_SENTENCES[1]);
  expect(blocks[0].querySelector("ins")).not.toBeNull();
  expect(document.body.textContent).not.toContain(ESCALATIONS_CHARTER_SENTENCES[3]);
  // A removed passage is struck on a red wash; an added one has no underline.
  expect(blocks[0].querySelector("del")!.className).toContain("line-through");
  expect(blocks[1].querySelector("ins")!.className).toContain("no-underline");
  // The amended revision: what the author changed, field by field, never "was <all>, now <all>".
  const rev = q("[data-revision]");
  expect(rev.getAttribute("data-revision")).toBe("amended");
  expect(rev.textContent).toContain("Changed");
  expect(Number(rev.getAttribute("data-revision-fields"))).toBeGreaterThan(0);
  expect(document.body.textContent).not.toMatch(/\bwas .*, now /);
  m.done();
  // The project goal grows from two sentences to three: one block, the parts the translator gives.
  const g = mount({ card: meta, ordinal: 2, onAnswer });
  const goalField = field("goal");
  expect(goalField.getAttribute("data-field-op")).toBe("change");
  const expected = passageDiff(ORG_RECORDS_FIXTURE_LIVE.projects[0].goal!, (ORG_CHARTER_EDIT_FIXTURE_PROPOSAL.changes[1].change as { goal: string }).goal).map((p) => p.kind);
  expect(Array.from(goalField.querySelectorAll("[data-diff]")).map((p) => p.getAttribute("data-diff"))).toEqual(expected);
  expect(goalField.querySelectorAll("[data-diff='same'], [data-diff='gap']").length).toBe(1);
  g.done();
});

test("op-903's revision block: Changed, the note, and the charter as one passage diff", () => {
  const m = mount({ card: cardOf(ORG_LONG_CHARTER_FIXTURE_PROPOSAL.changes, "Partnerships lead", ORG_RECORDS_FIXTURE_LIVE), ordinal: 2, onAnswer });
  const rev = q("[data-revision]");
  expect(rev.getAttribute("data-revision")).toBe("amended");
  expect(rev.getAttribute("data-revision-fields")).toBe("1");
  expect(rev.querySelector("span")!.textContent).toBe("Changed");
  expect(rev.textContent).toContain("Wrote the weekly steps out after you asked what the role does on its own.");
  const moved = rev.querySelector<HTMLElement>("[data-field='charter']")!;
  expect(moved.getAttribute("data-field-op")).toBe("change");
  expect(moved.querySelector("[data-passage-diff]")).not.toBeNull();
  expect(moved.querySelectorAll("del").length).toBeGreaterThan(0);
  expect(moved.querySelectorAll("ins").length).toBeGreaterThan(0);
  expect(rev.textContent).not.toMatch(/\bwas .*, now /);
  m.done();
});

test("a field that held nothing reads its placeholder, quiet and never struck; a field that reads the same is not drawn", () => {
  const m = mount({ card: cardOf([FIRST, RAISE], "Infrastructure"), ordinal: 1, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe("Make Infrastructure the top priority.");
  expect(field("priority").getAttribute("data-field-before")).toBe("not set");
  expect(field("priority").getAttribute("data-field-after")).toBe("P0");
  expect(struckIn(field("priority"))).toEqual([]);
  m.done();
  const meta = mount({ card: cardOf([change("m", 1, { kind: "project_meta", project: "pr-3", owner: "@growth", goal: "Close two fees", non_goals: [] })], "People & Deals"), ordinal: 1, onAnswer });
  expect(qa("[data-field]").map((f) => f.getAttribute("data-field"))).toEqual(["goal"]);
  expect(document.body.textContent).not.toContain("no change");
  meta.done();
});

test("a new role with what rides along is one entry whose members are the card's; a limit never shows; alone, Approve is filled until pressed", () => {
  const card = cardOf(ROLE, "Head of Platform");
  const m = mount({ card, lead: true, onAnswer });
  expect(q("[data-subject]").getAttribute("data-change-ids")).toBe("role limit trust routine");
  expect(q("[data-subject-sentence]").textContent).toBe("Add the role Head of Platform, reporting to you.");
  // "you" carries the reader's own face (the initials are its text).
  expect(qa("[data-field]").map((f) => [f.previousElementSibling!.textContent, f.textContent])).toEqual([
    ["Reports to", "APyou"],
    ["Looks after", "Platform"],
    ["Runs", "Weekly platform review, every week"],
    ["Starts work", "on its own, inside its area"],
  ]);
  // A new record has nothing to compare: no arrow, nothing struck. The routine's cadence is a quiet tail.
  expect(qa("[data-field-before]")).toEqual([]);
  expect(document.body.textContent).not.toContain("→");
  expect(field("routine").querySelector(".text-\\[color\\:var\\(--ink-quiet\\)\\]")!.textContent).toBe(", every week");
  // What creates the subject is one group, with every reason under it but the limit's.
  expect(qa("[data-subject-group]").length).toBe(1);
  expect(q("[data-subject-reasons]").textContent).toBe("Because role.Because routine.Because trust.");
  expect(document.body.textContent).not.toMatch(/800|tokens|wakes|caps|limit/i);
  // No number column on a card that stands alone, and its Approve is the frame's filled button.
  expect(q("[data-subject-ordinal]")).toBeNull();
  expect(q("[data-subject-approve]").style.background).toBe("var(--sol-violet)");
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  m.done();
});

test("a failed entry: the note under the sentence, a red number, Retry in Approve's place; staged, the band says it runs again", () => {
  const failed = { ...RAISE, status: "failed" as const, applied_note: "The project was renamed while this waited." };
  const card = cardOf([FIRST, failed], "Private Network");
  const m = mount({ card, ordinal: 4, lead: true, onAnswer });
  expect(q("[data-subject]").getAttribute("data-subject-status")).toBe("failed");
  expect(q("[data-failed-note]").textContent).toBe("Failed: The project was renamed while this waited.");
  expect(q("[data-subject-ordinal]").className).toContain("--ink-red");
  // A failed apply wrote nothing, so the field still reads the live record.
  expect(field("priority").getAttribute("data-field-before")).toBe("P2");
  // Retry is never the filled button, even on a card that stands alone; it is an approve answer like any other.
  expect(q("[data-subject-approve]").textContent).toBe("Retry");
  expect(q("[data-subject-approve]").style.background).toBe("");
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  expect(q("[data-subject-reject]")).not.toBeNull();
  expect(q("[data-subject-reply]")).not.toBeNull();
  m.update({ card, ordinal: 4, lead: true, onAnswer, answer: APPROVE });
  expect(band()!.textContent).toBe("Retry. Runs again when you send.Undo");
  m.done();
});

test("after the send an entry keeps its fields and reason; the word says where it stands and the controls are gone", () => {
  const at = (status: OrgProposalChange["status"], extra: Partial<OrgProposalChange> = {}) => cardOf([FIRST, { ...RAISE, status, ...extra }], "Private Network");
  const m = mount({ card: at("proposed"), ordinal: 4, onAnswer, answer: APPROVE });
  expect(band()).not.toBeNull();
  // The beat between the send and its apply: the word in cyan, and the band is gone with the answer.
  m.update({ card: at("accepted"), ordinal: 4, onAnswer });
  expect(q("[data-subject-state]").getAttribute("data-subject-state")).toBe("accepted");
  expect(q("[data-subject-state]").textContent).toBe("Approved, applying");
  expect(q("[data-subject-state]").className).toContain("--ink-cyan");
  expect(q("[data-subject-approve]")).toBeNull();
  expect(q("[data-subject-reject]")).toBeNull();
  expect(q("[data-subject-reply]")).toBeNull();
  expect(band()).toBeNull();
  expect(q("[data-subject-reasons]")).not.toBeNull();
  // Applied: green, and the field reads the stamp, not the record that has since moved.
  const stamp = [{ kind: "project_meta" as const, subject: { type: "project" as const, id: "p-network", label: "Private Network" }, before: { priority: "p2" }, after: { priority: "p1" }, labels: {} }];
  m.update({ card: at("applied", { applied_diff: stamp }), ordinal: 4, onAnswer });
  expect(q("[data-subject-state]").getAttribute("data-subject-state")).toBe("applied");
  expect(q("[data-subject-state]").textContent).toBe("Applied");
  expect(q("[data-subject-state]").className).toContain("--ink-green");
  expect(field("priority").getAttribute("data-field-before")).toBe("P2");
  expect(q("[data-settled]")).toBeNull();
  // No way back on the entry: a verdict's undo is the org record's.
  expect(document.body.textContent).not.toMatch(/undo/i);
  // An approval that carried words keeps them under the entry.
  m.update({ card: at("applied", { applied_diff: stamp, reply: { verdict: "approve", text: "But revisit in a month.", at: 9 } }), ordinal: 4, onAnswer });
  expect(q("[data-subject-you]").textContent).toBe("You: But revisit in a month.");
  m.done();
  // Rejected in view: the entry keeps its diff and its height, so nothing jumps under the pointer; a fresh mount folds it.
  const r = mount({ card: at("proposed"), ordinal: 4, onAnswer, answer: { verdict: "reject", text: "Too high." } });
  expect(field("priority").getAttribute("data-field-before")).toBe("P2");
  r.update({ card: at("skipped", { reply: { verdict: "reject", text: "Too high.", at: 9 } }), ordinal: 4, onAnswer });
  expect(q("[data-subject-state]").textContent).toBe("Rejected");
  expect(field("priority").getAttribute("data-field-after")).toBe("P1");
  expect(q("[data-subject-you]").textContent).toBe("You: Too high.");
  r.done();
});

test("rejected and noted after the send: the stored words under the entry, and a noted card still answerable", () => {
  const rejected = mount({ card: cardOf([FIRST, { ...RAISE, status: "skipped", reply: { verdict: "reject", text: "P1 is too high, make it P2.", at: 9, by: "u1" } }], "Private Network"), ordinal: 4, onAnswer });
  expect(q("[data-subject-state]").textContent).toBe("Rejected");
  expect(q("[data-subject-state]").className).toContain("--ink-quiet");
  expect(q("[data-subject-sentence]").className).toContain("--ink-quiet");
  expect(qa("[data-field]")).toEqual([]);
  const you = q("[data-subject-you]");
  expect(you.textContent).toBe("You: P1 is too high, make it P2.");
  expect(you.tagName).toBe("P");
  expect(q("[data-subject-approve]")).toBeNull();
  expect(q("[data-subject-noted]")).toBeNull();
  rejected.done();

  const notedCard = cardOf([FIRST, { ...RAISE, reply: { verdict: "note", text: "Cameron owns this, not Samvit.", at: 9, by: "u1" } }], "Private Network");
  const noted = mount({ card: notedCard, ordinal: 4, onAnswer });
  expect(q("[data-subject]").getAttribute("data-subject-status")).toBe("proposed");
  expect(q("[data-subject-you]").textContent).toBe("You: Cameron owns this, not Samvit.");
  expect(q("[data-subject-noted]").textContent).toBe("Noted, waiting for a revision");
  expect(q("[data-subject-approve]").textContent).toBe("Approve");
  click(q("[data-subject-you]"));
  expect(fieldOf()).not.toBeNull();
  // Read only, the gutter says Noted.
  noted.update({ card: notedCard, ordinal: 4 });
  expect(q("[data-subject-verdicts]").textContent).toBe("Noted");
  // Amended since: the note retires and the card is plainly to decide.
  noted.update({ card: cardOf([FIRST, { ...RAISE, reply: { verdict: "note", text: "Old words.", at: 9 }, revision: { kind: "amended", note: "Moved.", at: 12 } }], "Private Network"), ordinal: 4 });
  expect(q("[data-subject-you]")).toBeNull();
  expect(q("[data-subject-noted]")).toBeNull();
  expect(q("[data-subject-verdicts]").textContent).toBe("To decide");
  noted.done();
});

test("mounted already decided an entry is settled: an approved one keeps its fields, a rejected one is its sentence", () => {
  const stamp = [{ kind: "project_meta" as const, subject: { type: "project" as const, id: "p-network", label: "Private Network" }, before: { priority: "p2" }, after: { priority: "p1" }, labels: {} }];
  const applied = mount({ card: cardOf([FIRST, { ...RAISE, status: "applied", applied_diff: stamp }], "Private Network"), ordinal: 4, onAnswer });
  expect(q("[data-settled]")).not.toBeNull();
  expect(field("priority").textContent).toContain("P2");
  expect(q("[data-subject-reasons]")).toBeNull();
  applied.done();
  const skipped = mount({ card: cardOf([FIRST, { ...RAISE, status: "skipped" }], "Private Network"), ordinal: 4, onAnswer });
  expect(q("[data-subject-state]").textContent).toBe("Rejected");
  expect(qa("[data-field]")).toEqual([]);
  expect(q("[data-subject-approve]")).toBeNull();
  skipped.done();
  // The state word on its own, per status.
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(h("div", null, h(StateWord, { key: 1, status: "accepted" }), h(StateWord, { key: 2, status: "applied" }), h(StateWord, { key: 3, status: "skipped" }), h(StateWord, { key: 4, status: "mixed", words: "12 applied, 2 failed" }), h(StateWord, { key: 5, status: "proposed" }))));
  expect(qa("[data-subject-state]").map((s) => [s.getAttribute("data-subject-state"), s.textContent])).toEqual([["accepted", "Approved, applying"], ["applied", "Applied"], ["skipped", "Rejected"], ["mixed", "12 applied, 2 failed"]]);
  React.act(() => root.unmount());
});

test("changes that ended differently: each group carries its own word or its own Retry, Reject and Reply, and its own words", () => {
  const card = cardOf([G1, { ...G9, status: "applied", reply: { verdict: "approve", text: "Good.", at: 3 } }, { ...G10, status: "failed", applied_note: "Agent Quality was archived while this waited." }], "Proud relationships");
  const m = mount({ card, ordinal: 9, onAnswer });
  expect(q("[data-subject-verdicts]").textContent).toBe("1 of 2 approved, 1 failed");
  expect(qa("[data-subject-group]").map((g) => g.getAttribute("data-subject-group"))).toEqual(["9", "10"]);
  expect(qa("[data-subject-group-state]").map((g) => [g.getAttribute("data-subject-group-state"), g.textContent])).toEqual([["applied", "Applied"], ["failed", "RetryRejectReply"]]);
  expect(qa("[data-subject-you]").map((y) => y.textContent)).toEqual(["You: Good."]);
  const [first, second] = qa("[data-subject-group]");
  expect(first.querySelector("[data-failed-note]")).toBeNull();
  expect(second.querySelector("[data-failed-note]")!.textContent).toBe("Failed: Agent Quality was archived while this waited.");
  expect(first.querySelector("[data-subject-reasons]")!.textContent).toBe("Because g9.");
  expect(second.querySelector("[data-subject-reasons]")!.textContent).toBe("Because g10.");
  // The answer is the card's: one answer per card, whichever group's control was pressed; staged, the band stands for all of it.
  click(q("[data-subject-group-state='failed'] [data-subject-approve]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  m.update({ card, ordinal: 9, onAnswer, answer: APPROVE });
  expect(qa("[data-staged]").length).toBe(1);
  expect(q("[data-subject-approve]")).toBeNull();
  m.done();
});

test("several changes to a goal that exists read change by change under one sentence and one answer", () => {
  const m = mount({ card: cardOf([G1, G9, G10], "Proud relationships"), ordinal: 9, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe("Move Proud relationships under the purpose, measure it by Trust breaks per day and have Agent Quality carry it.");
  expect(qa("[data-subject-group]").length).toBe(2);
  expect(field("parent").getAttribute("data-field-before")).toBe("at the top level");
  expect(field("parent").getAttribute("data-field-after")).toBe("the purpose");
  expect(field("projects").getAttribute("data-field-before")).toBe("no project");
  // A list that gains an entry: the kept names, then the new one behind a quiet plus.
  expect(field("projects").textContent).toBe("+ Agent Quality");
  expect(qa("[data-subject-approve]").length).toBe(1);
  expect(q("[data-subject]").getAttribute("data-change-ids")).toBe("g10 g9");
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  m.done();
});

test("a goal's projects read as one run of names, measures as written, the owner as a face; sources sit behind one control", () => {
  const purpose = mount({ card: cardOf([G1, G2], PURPOSE), ordinal: 1, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe(`Set ${PURPOSE} as the purpose.`);
  expect(field("projects").textContent).toBe("Infrastructure, Matching & Funnel, People & Deals, Private Network, Agent Quality");
  expect(field("owner").querySelector("[data-subject-face]")!.getAttribute("data-subject-face")).toBe("person");
  expect(field("owner").textContent).toBe("APAshot Petrosian");
  purpose.done();

  const child = mount({ card: cardOf([G1, G2], "Improve conversion"), ordinal: 2, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe("Add the goal Improve conversion under the purpose.");
  expect(field("metrics").textContent).toBe("Email to intro rate, target 0.20%Cold email reply rate, target 1% higher (Cameron)");
  expect(field("metrics").children[0].children.length).toBe(2);
  expect(field("projects").textContent).toBe("Matching & Funnel");
  const sources = q("[data-subject-sources]");
  expect(sources.textContent).toBe("1 source");
  click(sources.querySelector("button")!);
  expect(sources.textContent).toBe("Source:North star goals, admin home page");
  expect(reached).toEqual([]);
  child.done();
});

test("a linked source opens as a link; there is no Edit", () => {
  const linked = { ...RAISE, evidence: [{ label: "3 decisions waiting", href: "/decisions" }, { label: "The ranking doc", href: "https://example.com/doc" }] };
  const m = mount({ card: cardOf([FIRST, linked], "Private Network"), ordinal: 4, onAnswer });
  click(q("[data-subject-sources] button"));
  expect(qa("[data-subject-sources] a").map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target")])).toEqual([["3 decisions waiting", "/decisions", null], ["The ranking doc", "https://example.com/doc", "_blank"]]);
  expect(q("[data-subject-edit]")).toBeNull();
  expect(document.body.textContent).not.toMatch(/\bEdit\b/);
  expect(reached).toEqual([]);
  m.done();
});

test("what approving would take over: the card shows the phrase and the leave box while it waits, and the band carries it once staged", () => {
  const card = cardOf(ROLE, "Head of Platform");
  const takeover = { phrase: "12 sessions now report to @platform" };
  const m = mount({ card, lead: true, onAnswer, takeover });
  expect(q("[data-takeover-phrase]").textContent).toContain("12 sessions now report to @platform");
  click(q("[data-takeover-leave-input]"));
  expect(reached).toEqual([]);
  // The tick rides on the approval, and only on an approval.
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([{ verdict: "approve", leave_sessions: true }]);
  const ticked = { verdict: "approve" as const, leave_sessions: true };
  m.update({ card, lead: true, onAnswer, answer: ticked, takeover });
  expect(band()!.textContent).toContain("Approved, and the sessions stay where they are.");
  expect((q("[data-staged] [data-takeover-leave-input]") as HTMLInputElement).checked).toBe(true);
  // Unticking rewrites the pending approval without it; ticking again puts it back.
  click(q("[data-takeover-leave-input]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  m.update({ card, lead: true, onAnswer, answer: APPROVE, takeover });
  expect(band()!.textContent).toContain("Approved. Applies when you send.Undo");
  expect((q("[data-staged] [data-takeover-leave-input]") as HTMLInputElement).checked).toBe(false);
  click(q("[data-takeover-leave-input]"));
  expect(sent.splice(0)).toEqual([ticked]);
  // Read only, or decided, the box is gone.
  m.update({ card, lead: true, takeover });
  expect(q("[data-takeover-phrase]")).toBeNull();
  m.done();
});

test("hover and focus light the lead change on the map, and leave puts the light out", () => {
  const lit: (string | null)[] = [];
  const m = mount({ card: cardOf([FIRST, RAISE], "Private Network"), ordinal: 2, onAnswer }, (node) => h(OrgHoverContext.Provider, { value: (id: string | null) => lit.push(id) }, node));
  const root = q("[data-subject]");
  React.act(() => { root.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })); });
  expect(lit.splice(0)).toEqual(["r4"]);
  React.act(() => { root.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
  expect(lit.splice(0)).toEqual([null]);
  m.done();
});

test("the narrow form puts the controls under the entry at the right and the band under it at full width; focused, the entry says so", () => {
  const card = cardOf([FIRST, RAISE], "Private Network");
  const m = mount({ card, ordinal: 2, onAnswer, layout: "narrow", focused: true });
  expect(q("[data-subject]").getAttribute("data-layout")).toBe("narrow");
  expect(q("[data-subject]").hasAttribute("data-focused")).toBe(true);
  expect(q("[data-subject]").className).not.toContain("container-type");
  expect(q("[data-subject-verdicts]").className).toContain("order-last");
  expect(q("[data-subject-verdicts]").className).toContain("col-start-2");
  m.update({ card, ordinal: 2, onAnswer, layout: "narrow", answer: APPROVE });
  expect(q("[data-answer-area]").className).toContain("col-start-2");
  expect(q("[data-subject-verdicts]")).toBeNull();
  m.update({ card, ordinal: 2, onAnswer, layout: "wide" });
  expect(q("[data-subject-verdicts]").className).toContain("col-start-3");
  m.update({ card, ordinal: 2, onAnswer });
  expect(q("[data-subject]").getAttribute("data-layout")).toBe("auto");
  // Nobody to answer: the state in words, no buttons, no band.
  m.update({ card, ordinal: 2, answer: APPROVE });
  expect(q("[data-subject-approve]")).toBeNull();
  expect(band()).toBeNull();
  expect(q("[data-subject-verdicts]").textContent).toBe("To decide");
  m.done();
});

test("a limit alone is one plain sentence with its answers and nothing else", () => {
  const card = cardsOf([change("limit", 1, { kind: "budget", handle: "growth", caps: { wakes_per_day: 12, tokens_per_day: 800_000 } }, "proposed", { rationale: "Growth wakes 30 times a day." })])[0];
  const m = mount({ card, lead: true, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe("Head of Growth keeps a safety net on its daily work.");
  expect(qa("[data-field]")).toEqual([]);
  expect(document.body.textContent).not.toMatch(/wakes|tokens|caps|limit|\d/i);
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  m.done();
});

test("the closing row shell: words at the left, the controls at the right, a line above, or what happened; nothing reaches the frame", () => {
  const root = createRoot(document.getElementById("root")!);
  const pressed: string[] = [];
  React.act(() => root.render(frame(h(LedgerClosingRow, { left: h("button", { "data-map": true, onClick: () => pressed.push("map") }, "Map"), right: h("button", { "data-rest": true, onClick: () => pressed.push("rest") }, "Approve the rest"), above: h("p", { "data-above": true }, "Leave them") }))));
  expect(q("[data-ledger-close]")).not.toBeNull();
  expect(q("[data-above]").textContent).toBe("Leave them");
  click(q("[data-rest]"));
  click(q("[data-map]"));
  expect(pressed).toEqual(["rest", "map"]);
  expect(reached).toEqual([]);
  React.act(() => root.render(frame(h(LedgerClosingRow, { outcome: "7 approved, 2 rejected" }))));
  expect(q("[data-rest]")).toBeNull();
  expect(q("[data-above]")).toBeNull();
  expect(q("[data-proposal-outcome]").textContent).toBe("7 approved, 2 rejected");
  React.act(() => root.unmount());
});

test("no entry draws a dashed line, a hatch, an upper case label, a long dash, or a word the person was told is gone", () => {
  const cards = [...cardsOf([G1, G2, { ...G9, status: "applied" }, { ...G10, status: "failed", applied_note: "x" }]), ...cardsOf(ROLE), ...cardsOf([FIRST, RAISE])];
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(h("div", null, cards.map((card, i) => h(ProposalSubjectCard, { key: card.key, card, ordinal: i + 1, onAnswer, answer: i % 2 ? { verdict: "reject", text: "No." } : APPROVE })))));
  const html = document.getElementById("root")!.innerHTML;
  expect(html).not.toMatch(/dashed|dotted|repeating-linear-gradient|uppercase|tracking-\[/);
  expect(html).not.toContain(String.fromCharCode(8212));
  expect(document.body.textContent).not.toMatch(/accept|skip|on your next message|no change|Accept with edits/i);
  React.act(() => root.unmount());
});
