// Mounts the ledger entry (docs/architecture/org-staffing.md S39) in jsdom on
// cards built by the real model from synthetic rows: the sentence with its one
// bold name, each field with what was there before, the reasons, the answers
// (Approve, Reject, Reply and the field) and what they write into the batch
// through onAnswer, and every state an entry can be in before and after the
// send. The card takes callbacks and reads no store, so nothing but the link
// is mocked.
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
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));

const { createRoot } = await import("react-dom/client");
const { ORG_FIXTURE } = await import("./orgFixture");
const { proposalSubjects } = await import("./proposalSubjects");
const { ProposalSubjectCard, LedgerClosingRow, fieldValueText } = await import("./ProposalSubjectCard");
type OrgProposalChange = import("./orgStaffingTypes").OrgProposalChange;
type SubjectLive = import("./proposalSubjects").SubjectLive;
type SubjectCard = import("./proposalSubjects").SubjectCard;
type Props = import("./ProposalSubjectCard").ProposalSubjectCardProps;

const change = (id: string, seq: number, c: any, status: OrgProposalChange["status"] = "proposed", extra: Partial<OrgProposalChange> = {}): OrgProposalChange =>
  ({ _id: id, proposal_id: "p1", seq, change: c, rationale: `Because ${id}.`, evidence: [], status, ...extra });

const PROJECTS: SubjectLive["projects"] = [
  { _id: "p-infra", short_id: "pr-1", title: "Infrastructure", status: "active" },
  { _id: "p-funnel", short_id: "pr-2", title: "Matching & Funnel", status: "active" },
  { _id: "p-deals", short_id: "pr-3", title: "People & Deals", status: "active" },
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

const cardsOf = (changes: OrgProposalChange[], live: SubjectLive | null = LIVE) => proposalSubjects(changes, live);
const cardOf = (changes: OrgProposalChange[], title: string): SubjectCard => cardsOf(changes).find((c) => c.title === title)!;

// What the card writes into the batch: null withdraws.
const sent: any[] = [];
const onAnswer: Props["onAnswer"] = (answer) => { sent.push(answer); };
const APPROVE = { verdict: "approve" as const };
// What reaches the frame around a card: a click there opens or closes it.
const reached: string[] = [];
const frame = (child: React.ReactNode) => h("div", { onClick: () => reached.push("click"), onKeyDown: () => reached.push("keydown"), onPointerDown: () => reached.push("pointerdown") }, child);

function mount(props: Props) {
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(frame(h(ProposalSubjectCard, props))));
  return { root, update: (next: Props) => React.act(() => root.render(frame(h(ProposalSubjectCard, next)))), done: () => React.act(() => root.unmount()) };
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

test("a change to a project: the sentence with one bold name, the field from what it was, the reason, and what Approve writes", () => {
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

  // In a list the entry's Approve is an outline: the frame keeps its one filled button for the closing row.
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
  expect(q("[data-subject-pending]")).toBeNull();
  // With the answer in hand the card shows it pressed, says where it goes, and still reads as undecided.
  m.update({ card, ordinal: 2, onAnswer, answer: APPROVE });
  expect(q("[data-subject]").getAttribute("data-subject-answer")).toBe("approve");
  expect(q("[data-subject-approve]").getAttribute("aria-pressed")).toBe("true");
  expect(q("[data-subject-approve] svg")).not.toBeNull();
  expect(q("[data-subject-pending]").textContent).toBe("on your next message");
  expect(q("[data-subject-sentence]").className).toContain("--sol-text)");
  expect(field("priority")).not.toBeNull();
  expect(q("[data-subject-state]")).toBeNull();
  expect(q("[data-subject-you]")).toBeNull();
  // Pressed again, Approve withdraws.
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([null]);
  // A control's click, key and pointer stay inside the card.
  fire(q("[data-subject-approve]"), "keydown");
  fire(q("[data-subject-approve]"), "pointerdown");
  expect(reached).toEqual([]);
  click(q("[data-subject-sentence]"));
  expect(reached.splice(0)).toEqual(["click"]);
  // No word a person could read says Accept or Skip.
  expect(document.body.textContent).not.toMatch(/accept|skip/i);
  m.done();
});

test("Reject presses and opens the field asking why; the words write through as they are typed and show as the person's own", () => {
  const card = cardOf([FIRST, RAISE], "Private Network");
  const picked: string[] = [];
  const m = mount({ card, ordinal: 2, onAnswer, onPick: () => picked.push("pick") });
  expect(fieldOf()).toBeNull();
  click(q("[data-subject-reject]"));
  expect(sent.splice(0)).toEqual([{ verdict: "reject" }]);
  m.update({ card, ordinal: 2, onAnswer, onPick: () => picked.push("pick"), answer: { verdict: "reject" } });
  expect(q("[data-subject-reject]").getAttribute("aria-pressed")).toBe("true");
  expect(q("[data-subject-reject]").className).toContain("--ink-red");
  const ta = fieldOf()!;
  expect(ta).not.toBeNull();
  expect(ta.placeholder).toBe("Why not? Say what you want instead.");
  expect(document.activeElement).toBe(ta);
  expect(q("[data-subject-reply-field] kbd")).not.toBeNull();
  // Every keystroke is the batch's: the draft never lives in the card alone.
  type(ta, "P1 is too high");
  expect(sent.splice(0)).toEqual([{ verdict: "reject", text: "P1 is too high" }]);
  // Keys in the field never reach the frame: a space does not fold the card, Enter does not pick it.
  key(ta, " ");
  key(ta, "Enter", { shiftKey: true });
  expect(reached).toEqual([]);
  expect(picked).toEqual([]);
  expect(q("[data-subject-sentence]").getAttribute("aria-expanded")).toBe("false");
  expect(fieldOf()).not.toBeNull();
  // Enter saves and closes; the words sit under the entry as "You".
  m.update({ card, ordinal: 2, onAnswer, onPick: () => picked.push("pick"), answer: { verdict: "reject", text: "P1 is too high, make it P2." } });
  key(fieldOf()!, "Enter");
  expect(fieldOf()).toBeNull();
  expect(sent).toEqual([]);
  const you = q("[data-subject-you]");
  expect(you.textContent).toBe("You: P1 is too high, make it P2.");
  expect(you.getAttribute("data-subject-you")).toBe("reject");
  expect(q("[data-subject-pending]").textContent).toBe("on your next message");
  // A press on the words reopens the field with them; Esc closes it and keeps them.
  click(you);
  expect(fieldOf()!.value).toBe("P1 is too high, make it P2.");
  key(fieldOf()!, "Escape");
  expect(fieldOf()).toBeNull();
  expect(q("[data-subject-you]").textContent).toBe("You: P1 is too high, make it P2.");
  expect(reached).toEqual([]);
  expect(picked).toEqual([]);
  // Reject pressed again withdraws the answer, words and all.
  click(q("[data-subject-reject]"));
  expect(sent.splice(0)).toEqual([null]);
  m.done();
});

test("Reply opens the field with no verdict: words alone are a note, and Approve then carries them", () => {
  const card = cardOf([FIRST, RAISE], "Private Network");
  const m = mount({ card, ordinal: 2, onAnswer });
  click(q("[data-subject-reply]"));
  expect(sent).toEqual([]);
  const ta = fieldOf()!;
  expect(ta.placeholder).toBe("Say something about this change");
  expect(q("[data-subject-reply]").getAttribute("aria-expanded")).toBe("true");
  type(ta, "Cameron owns this");
  expect(sent.splice(0)).toEqual([{ verdict: "note", text: "Cameron owns this" }]);
  // An empty note is withdrawn by the batch; the field stays open all the same.
  m.update({ card, ordinal: 2, onAnswer, answer: { verdict: "note", text: "Cameron owns this" } });
  type(fieldOf()!, "");
  expect(sent.splice(0)).toEqual([{ verdict: "note", text: "" }]);
  m.update({ card, ordinal: 2, onAnswer, answer: null });
  expect(fieldOf()).not.toBeNull();
  // With a note in hand, Approve keeps the words under the approval.
  m.update({ card, ordinal: 2, onAnswer, answer: { verdict: "note", text: "Cameron owns this, not Samvit." } });
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([{ verdict: "approve", text: "Cameron owns this, not Samvit." }]);
  // Reply pressed again closes the field.
  click(q("[data-subject-reply]"));
  expect(fieldOf()).toBeNull();
  expect(q("[data-subject-you]").textContent).toBe("You: Cameron owns this, not Samvit.");
  expect(reached).toEqual([]);
  m.done();
});

test("a field that held nothing reads its placeholder, quiet and never struck", () => {
  const m = mount({ card: cardOf([FIRST, RAISE], "Infrastructure"), ordinal: 1, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe("Make Infrastructure the top priority.");
  expect(field("priority").getAttribute("data-field-before")).toBe("not set");
  expect(field("priority").getAttribute("data-field-after")).toBe("P0");
  expect(struckIn(field("priority"))).toEqual([]);
  m.done();
});

test("a new role with what rides along is one entry whose members are the card's; a limit never shows; alone, Approve is filled until pressed", () => {
  const card = cardOf(ROLE, "Head of Platform");
  const m = mount({ card, lead: true, onAnswer });
  expect(q("[data-subject]").getAttribute("data-change-ids")).toBe("role limit trust routine");
  expect(q("[data-subject-sentence]").textContent).toBe("Add the role Head of Platform, reporting to you.");
  expect(qa("[data-field]").map((f) => [f.previousElementSibling!.textContent, f.textContent])).toEqual([
    ["Answers to", "@platform"],
    ["Looks after", "Platform"],
    ["Runs", "Weekly platform review, every week"],
    ["Starts work", "on its own, inside its area"],
  ]);
  // A new record has nothing to compare: no arrow, nothing struck.
  expect(qa("[data-field-before]")).toEqual([]);
  expect(document.body.textContent).not.toContain("→");
  // What creates the subject is one group, with every reason under it but the limit's.
  expect(qa("[data-subject-group]").length).toBe(1);
  expect(q("[data-subject-reasons]").textContent).toBe("Because role.Because routine.Because trust.");
  expect(document.body.textContent).not.toMatch(/800|tokens|wakes|caps|limit/i);
  // No number column on a card that stands alone, and its Approve is the frame's filled button.
  expect(q("[data-subject-ordinal]")).toBeNull();
  expect(q("[data-subject-approve]").style.background).toBe("var(--sol-violet)");
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  // Pressed, it is the outline with the soft fill, like any other.
  m.update({ card, lead: true, onAnswer, answer: APPROVE });
  expect(q("[data-subject-approve]").style.background).toBe("");
  expect(q("[data-subject-approve]").getAttribute("aria-pressed")).toBe("true");
  m.done();
});

test("a failed entry: the note under the sentence, a red number, Retry in Approve's place, Reject and Reply still there", () => {
  const failed = { ...RAISE, status: "failed" as const, applied_note: "The project was renamed while this waited." };
  const m = mount({ card: cardOf([FIRST, failed], "Private Network"), ordinal: 4, lead: true, onAnswer });
  expect(q("[data-subject]").getAttribute("data-subject-status")).toBe("failed");
  expect(q("[data-failed-note]").textContent).toBe("Failed: The project was renamed while this waited.");
  expect(q("[data-subject-ordinal]").className).toContain("--ink-red");
  // A failed apply wrote nothing, so the field still reads the live record.
  expect(field("priority").getAttribute("data-field-before")).toBe("P2");
  // Retry is never the filled button, even on a card that stands alone; it is an approve answer like any other.
  expect(q("[data-subject-approve]").textContent).toBe("Retry");
  expect(q("[data-subject-approve]").style.background).toBe("");
  click(q("[data-subject-approve]"));
  click(q("[data-subject-reject]"));
  expect(sent.splice(0)).toEqual([APPROVE, { verdict: "reject" }]);
  expect(q("[data-subject-reply]")).not.toBeNull();
  m.done();
});

test("after the send an entry keeps its fields and reason; the word says where it stands and the controls are gone", () => {
  const at = (status: OrgProposalChange["status"], extra: Partial<OrgProposalChange> = {}) => cardOf([FIRST, { ...RAISE, status, ...extra }], "Private Network");
  const m = mount({ card: at("proposed"), ordinal: 4, onAnswer, answer: APPROVE });
  expect(q("[data-subject-pending]")).not.toBeNull();
  // The beat between the send and its apply: Approved in cyan, and the pending line is gone with the answer.
  m.update({ card: at("accepted"), ordinal: 4, onAnswer });
  expect(q("[data-subject-state]").getAttribute("data-subject-state")).toBe("accepted");
  expect(q("[data-subject-state]").textContent).toBe("Approved");
  expect(q("[data-subject-state]").className).toContain("--ink-cyan");
  expect(q("[data-subject-approve]")).toBeNull();
  expect(q("[data-subject-reject]")).toBeNull();
  expect(q("[data-subject-reply]")).toBeNull();
  expect(q("[data-subject-pending]")).toBeNull();
  expect(q("[data-subject-reasons]")).not.toBeNull();
  // Applied: the same word in green, and the field reads the stamp, not the record that has since moved.
  const stamp = [{ kind: "project_meta" as const, subject: { type: "project" as const, id: "p-network", label: "Private Network" }, before: { priority: "p2" }, after: { priority: "p1" }, labels: {} }];
  m.update({ card: at("applied", { applied_diff: stamp }), ordinal: 4, onAnswer });
  expect(q("[data-subject-state]").getAttribute("data-subject-state")).toBe("applied");
  expect(q("[data-subject-state]").textContent).toBe("Approved");
  expect(q("[data-subject-state]").className).toContain("--ink-green");
  expect(field("priority").getAttribute("data-field-before")).toBe("P2");
  expect(q("[data-subject-reasons]")).not.toBeNull();
  expect(q("[data-settled]")).toBeNull();
  // No way back on the entry: a verdict's undo is the org record's.
  expect(document.body.textContent).not.toMatch(/undo/i);
  // An approval that carried words keeps them under the entry.
  m.update({ card: at("applied", { applied_diff: stamp, reply: { verdict: "approve", text: "But revisit in a month.", at: 9 } }), ordinal: 4, onAnswer });
  expect(q("[data-subject-you]").textContent).toBe("You: But revisit in a month.");
  m.done();
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
  // Still answerable: the controls stay, and the sentence is in full ink.
  expect(q("[data-subject-approve]").textContent).toBe("Approve");
  expect(q("[data-subject-sentence]").className).toContain("--sol-text)");
  click(q("[data-subject-you]"));
  expect(fieldOf()).not.toBeNull();
  expect(fieldOf()!.value).toBe("");
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
  // Applied before the stamp existed: what was set, alone.
  const bare = mount({ card: cardOf([FIRST, { ...RAISE, status: "applied" }], "Private Network"), ordinal: 4, onAnswer });
  expect(field("priority").getAttribute("data-field-before")).toBeNull();
  expect(field("priority").textContent).toBe("P1");
  bare.done();
  const skipped = mount({ card: cardOf([FIRST, { ...RAISE, status: "skipped" }], "Private Network"), ordinal: 4, onAnswer });
  expect(q("[data-subject-state]").textContent).toBe("Rejected");
  expect(q("[data-subject-sentence]").textContent).toBe("Make Private Network a high priority.");
  expect(qa("[data-field]")).toEqual([]);
  expect(q("[data-subject-reasons]")).toBeNull();
  expect(q("[data-subject-approve]")).toBeNull();
  skipped.done();
});

test("changes that ended differently: each group carries its own word or its own Retry, Reject and Reply, and its own words", () => {
  const card = cardOf([G1, { ...G9, status: "applied", reply: { verdict: "approve", text: "Good.", at: 3 } }, { ...G10, status: "failed", applied_note: "Agent Quality was archived while this waited." }], "Proud relationships");
  const m = mount({ card, ordinal: 9, onAnswer });
  expect(q("[data-subject-verdicts]").textContent).toBe("1 of 2 failed");
  expect(qa("[data-subject-group]").map((g) => g.getAttribute("data-subject-group"))).toEqual(["9", "10"]);
  expect(qa("[data-subject-group-state]").map((g) => [g.getAttribute("data-subject-group-state"), g.textContent])).toEqual([["applied", "Approved"], ["failed", "RetryRejectReply"]]);
  expect(qa("[data-subject-you]").map((y) => y.textContent)).toEqual(["You: Good."]);
  // The note sits with the change that failed, and each change keeps its own reason.
  const [first, second] = qa("[data-subject-group]");
  expect(first.querySelector("[data-failed-note]")).toBeNull();
  expect(second.querySelector("[data-failed-note]")!.textContent).toBe("Failed: Agent Quality was archived while this waited.");
  expect(first.querySelector("[data-subject-reasons]")!.textContent).toBe("Because g9.");
  expect(second.querySelector("[data-subject-reasons]")!.textContent).toBe("Because g10.");
  // The answer is the card's: one answer per card, whichever group's control was pressed.
  click(q("[data-subject-group-state='failed'] [data-subject-approve]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  m.done();
});

test("several changes to a goal that exists read change by change under one sentence and one answer", () => {
  const m = mount({ card: cardOf([G1, G9, G10], "Proud relationships"), ordinal: 9, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe("Move Proud relationships under the purpose, measure it by Trust breaks per day and have Agent Quality carry it.");
  expect(qa("[data-subject-group]").length).toBe(2);
  expect(field("parent").getAttribute("data-field-before")).toBe("at the top level");
  expect(field("parent").getAttribute("data-field-after")).toBe("under the purpose");
  expect(field("projects").getAttribute("data-field-before")).toBe("no project");
  expect(qa("[data-subject-approve]").length).toBe(1);
  expect(q("[data-subject]").getAttribute("data-change-ids")).toBe("g10 g9");
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  m.done();
});

test("a goal with goals below it says how many projects carry it and opens to the list; measures read as written", () => {
  const purpose = mount({ card: cardOf([G1, G2], PURPOSE), ordinal: 1, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe(`Set ${PURPOSE} as the purpose.`);
  const carried = field("projects");
  expect(carried.textContent).toBe("5 projects, through the goals below show");
  click(carried.querySelector("[data-field-show]")!);
  expect(carried.textContent).toBe("Infrastructure, Matching & Funnel, People & Deals, Private Network, Agent Quality hide");
  expect(reached).toEqual([]);
  // The owner is a face and a name.
  expect(field("owner").querySelector("[data-face='person']")).not.toBeNull();
  purpose.done();

  const child = mount({ card: cardOf([G1, G2], "Improve conversion"), ordinal: 2, onAnswer });
  expect(q("[data-subject-sentence]").textContent).toBe("Add the goal Improve conversion under the purpose.");
  expect(field("metrics").textContent).toBe("Email to intro rate, target 0.20%Cold email reply rate, target 1% higher (Cameron)");
  expect(field("metrics").children[0].children.length).toBe(2);
  expect(field("projects").textContent).toBe("Matching & Funnel");
  // Sources sit behind one control.
  const sources = q("[data-subject-sources]");
  expect(sources.textContent).toBe("1 source");
  click(sources.querySelector("button")!);
  expect(sources.textContent).toBe("Source:North star goals, admin home page");
  expect(reached).toEqual([]);
  child.done();
});

test("a linked source opens as a link, and Edit sits on the same quiet line", () => {
  const linked = { ...RAISE, evidence: [{ label: "3 decisions waiting", href: "/decisions" }, { label: "The ranking doc", href: "https://example.com/doc" }] };
  const asked: string[] = [];
  const m = mount({ card: cardOf([FIRST, linked], "Private Network"), ordinal: 4, onAnswer, onEdit: () => asked.push("edit"), editor: h("form", { "data-editor": true }) });
  click(q("[data-subject-sources] button"));
  expect(qa("[data-subject-sources] a").map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target")])).toEqual([["3 decisions waiting", "/decisions", null], ["The ranking doc", "https://example.com/doc", "_blank"]]);
  click(q("[data-subject-edit]"));
  expect(asked).toEqual(["edit"]);
  expect(q("[data-ask-about]")).toBeNull();
  expect(q("[data-editor]")).not.toBeNull();
  expect(reached).toEqual([]);
  m.done();
});

test("what approving would take over: the card shows the phrase and the leave box while it waits, and its press stays inside", () => {
  const card = cardOf(ROLE, "Head of Platform");
  const m = mount({ card, lead: true, onAnswer, takeover: { phrase: "12 sessions now report to @platform" } });
  expect(q("[data-takeover-phrase]").textContent).toContain("12 sessions now report to @platform");
  click(q("[data-takeover-leave-input]"));
  expect(reached).toEqual([]);
  click(q("[data-subject-approve]"));
  expect(sent.splice(0)).toEqual([APPROVE]);
  // Read only, or decided, the box is gone.
  m.update({ card, lead: true, takeover: { phrase: "12 sessions now report to @platform" } });
  expect(q("[data-takeover-phrase]")).toBeNull();
  m.done();
});

test("the one line form: a face, the sentence, small answers; a press on the line picks it, an answer does not, Reply opens the card", () => {
  const picked: string[] = [];
  const m = mount({ card: cardOf([FIRST, RAISE], "Private Network"), variant: "row", ordinal: 2, onAnswer, onPick: () => picked.push("pick") });
  const root = q("[data-subject]");
  expect(root.getAttribute("data-subject-variant")).toBe("row");
  expect(root.getAttribute("role")).toBe("button");
  expect(q("[data-subject-sentence]").textContent).toBe("Raise Private Network to a high priority.");
  expect(q("[data-subject-sentence] [data-face='record']")).not.toBeNull();
  expect(qa("[data-field]")).toEqual([]);
  click(q("[data-subject-approve]"));
  expect(picked).toEqual([]);
  expect(sent.splice(0)).toEqual([APPROVE]);
  // No room for a field on one line: Reply opens the card instead.
  click(q("[data-subject-reply]"));
  expect(picked).toEqual(["pick"]);
  expect(fieldOf()).toBeNull();
  click(q("[data-subject-sentence]"));
  fire(root, "keydown");
  expect(picked).toEqual(["pick", "pick", "pick"]);
  m.update({ card: cardOf([FIRST, { ...RAISE, status: "applied" }], "Private Network"), variant: "row", ordinal: 2, onAnswer });
  expect(q("[data-subject-state]").textContent).toBe("Approved");
  expect(q("[data-subject-approve]")).toBeNull();
  reached.splice(0);
  m.done();
});

test("standing alone: the place line above the sentence; read only with no verdict; the layout it was told, or its own width", () => {
  const card = cardOf([FIRST, RAISE], "Infrastructure");
  const m = mount({ card, lead: true, place: h("span", null, "First of two in the ranking"), layout: "narrow" });
  expect(q("[data-subject-place]").textContent).toBe("First of two in the ranking");
  expect(q("[data-subject]").getAttribute("data-layout")).toBe("narrow");
  expect(q("[data-subject]").className).not.toContain("container-type");
  // Nobody to answer: the state in words, no buttons.
  expect(q("[data-subject-approve]")).toBeNull();
  expect(q("[data-subject-verdicts]").textContent).toBe("To decide");
  m.update({ card, lead: true, onAnswer, layout: "wide" });
  expect(q("[data-subject]").getAttribute("data-layout")).toBe("wide");
  m.update({ card, lead: true, onAnswer });
  expect(q("[data-subject]").getAttribute("data-layout")).toBe("auto");
  expect(q("[data-subject]").className).toContain("container-type");
  // A host that titles the subject itself asks for the other sentence.
  m.update({ card, onAnswer, sentence: "this" });
  expect(q("[data-subject-sentence]").textContent).toBe("Make this project the top priority.");
  expect(qa("[data-subject-sentence] b")).toEqual([]);
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
  React.act(() => root.render(frame(h(LedgerClosingRow, { left: h("button", { "data-chart": true, onClick: () => pressed.push("chart") }, "Chart"), right: h("button", { "data-send": true, onClick: () => pressed.push("send") }, "Send 2 answers"), above: h("p", { "data-above": true }, "You: do the plans next") }))));
  expect(q("[data-ledger-close]")).not.toBeNull();
  expect(q("[data-above]").textContent).toBe("You: do the plans next");
  click(q("[data-send]"));
  click(q("[data-chart]"));
  expect(pressed).toEqual(["send", "chart"]);
  expect(reached).toEqual([]);
  React.act(() => root.render(frame(h(LedgerClosingRow, { outcome: "7 approved, 2 rejected" }))));
  expect(q("[data-send]")).toBeNull();
  expect(q("[data-above]")).toBeNull();
  expect(q("[data-proposal-outcome]").textContent).toBe("7 approved, 2 rejected");
  React.act(() => root.unmount());
});

test("no entry draws a dashed line, a hatch, or an upper case label", () => {
  const cards = [...cardsOf([G1, G2, { ...G9, status: "applied" }, { ...G10, status: "failed", applied_note: "x" }]), ...cardsOf(ROLE), ...cardsOf([FIRST, RAISE])];
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(h("div", null, cards.map((card, i) => h(ProposalSubjectCard, { key: card.key, card, ordinal: i + 1, onAnswer, answer: i % 2 ? { verdict: "reject", text: "No." } : APPROVE })))));
  const html = document.getElementById("root")!.innerHTML;
  expect(html).not.toMatch(/dashed|dotted|repeating-linear-gradient|uppercase|tracking-\[/);
  expect(html).not.toContain(String.fromCharCode(8212));
  expect(document.body.textContent).not.toMatch(/accept|skip/i);
  // A value's words are the ones its attribute carries.
  expect(fieldValueText({ kind: "measures", measures: [{ name: "Replies", target: "1% higher (Cameron)" }] })).toBe("Replies, target 1% higher (Cameron)");
  React.act(() => root.unmount());
});
