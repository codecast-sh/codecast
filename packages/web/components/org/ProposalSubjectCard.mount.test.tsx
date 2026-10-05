// Mounts the ledger entry (docs/architecture/org-staffing.md S39) in jsdom on
// cards built by the real model from synthetic rows: the sentence with its one
// bold name, each field with what was there before, the reasons, the verdicts
// and what they send, and every state an entry can be in. The card takes
// callbacks and reads no store, so nothing but the link is mocked.
// Run: bun test --timeout 240000 components/org/ProposalSubjectCard.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
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

const sent: any[] = [];
const onDecide: Props["onDecide"] = (ids, verdict, opts) => { sent.push(opts ? [ids, verdict, opts] : [ids, verdict]); };
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
const field = (key: string) => q(`[data-field='${key}']`);
const struckIn = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(".line-through")).map((x) => x.textContent);

test("a change to a project: the sentence with one bold name, the field from what it was, the reason, and what the verdicts send", () => {
  const card = cardOf([FIRST, RAISE], "Private Network");
  const m = mount({ card, ordinal: 2, onDecide });
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

  // In a list the entry's Accept is an outline: the frame keeps its one filled button for the closing row.
  const accept = q("[data-subject-accept]");
  expect(accept.textContent).toBe("Accept");
  expect(accept.style.background).toBe("");
  click(accept);
  click(q("[data-subject-skip]"));
  expect(sent.splice(0)).toEqual([[["r4"], "accept"], [["r4"], "skip"]]);
  // A control's click, key and pointer stay inside the card.
  fire(accept, "keydown");
  fire(accept, "pointerdown");
  expect(reached).toEqual([]);
  click(q("[data-subject-sentence]"));
  expect(reached.splice(0)).toEqual(["click"]);
  m.done();
});

test("a field that held nothing reads its placeholder, quiet and never struck", () => {
  const m = mount({ card: cardOf([FIRST, RAISE], "Infrastructure"), ordinal: 1, onDecide });
  expect(q("[data-subject-sentence]").textContent).toBe("Make Infrastructure the top priority.");
  expect(field("priority").getAttribute("data-field-before")).toBe("not set");
  expect(field("priority").getAttribute("data-field-after")).toBe("P0");
  expect(struckIn(field("priority"))).toEqual([]);
  m.done();
});

test("a new role with what rides along is one entry; its Accept sends every member in apply order, and a limit never shows", () => {
  const card = cardOf(ROLE, "Head of Platform");
  const m = mount({ card, lead: true, onDecide });
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
  // No number column on a card that stands alone, and its Accept is the frame's filled button.
  expect(q("[data-subject-ordinal]")).toBeNull();
  expect(q("[data-subject-accept]").style.background).toBe("var(--sol-violet)");
  click(q("[data-subject-accept]"));
  expect(sent.splice(0)).toEqual([[["role", "limit", "trust", "routine"], "accept"]]);
  m.done();
});

test("a failed entry: the note under the sentence, a red number, Retry and Skip on what failed", () => {
  const failed = { ...RAISE, status: "failed" as const, applied_note: "The project was renamed while this waited." };
  const m = mount({ card: cardOf([FIRST, failed], "Private Network"), ordinal: 4, lead: true, onDecide });
  expect(q("[data-subject]").getAttribute("data-subject-status")).toBe("failed");
  expect(q("[data-failed-note]").textContent).toBe("Failed: The project was renamed while this waited.");
  expect(q("[data-subject-ordinal]").className).toContain("--ink-red");
  // A failed apply wrote nothing, so the field still reads the live record.
  expect(field("priority").getAttribute("data-field-before")).toBe("P2");
  // Retry is never the filled button, even on a card that stands alone.
  expect(q("[data-subject-accept]").textContent).toBe("Retry");
  expect(q("[data-subject-accept]").style.background).toBe("");
  click(q("[data-subject-accept]"));
  click(q("[data-subject-skip]"));
  expect(sent.splice(0)).toEqual([[["r4"], "accept"], [["r4"], "skip"]]);
  m.done();
});

test("decided in this view an entry keeps its fields and reason; the word says where it stands and the buttons are gone", () => {
  const at = (status: OrgProposalChange["status"], extra: Partial<OrgProposalChange> = {}) => cardOf([FIRST, { ...RAISE, status, ...extra }], "Private Network");
  const m = mount({ card: at("proposed"), ordinal: 4, onDecide });
  // The beat between the verdict and its apply.
  m.update({ card: at("accepted"), ordinal: 4, onDecide });
  expect(q("[data-subject-state]").getAttribute("data-subject-state")).toBe("accepted");
  expect(q("[data-subject-state]").textContent).toBe("Accepted");
  expect(q("[data-subject-state]").className).toContain("--ink-cyan");
  expect(q("[data-subject-accept]")).toBeNull();
  expect(q("[data-subject-skip]")).toBeNull();
  expect(q("[data-subject-reasons]")).not.toBeNull();
  // Applied: the same word in green, and the field reads the stamp, not the record that has since moved.
  const stamp = [{ kind: "project_meta" as const, subject: { type: "project" as const, id: "p-network", label: "Private Network" }, before: { priority: "p2" }, after: { priority: "p1" }, labels: {} }];
  m.update({ card: at("applied", { applied_diff: stamp }), ordinal: 4, onDecide });
  expect(q("[data-subject-state]").getAttribute("data-subject-state")).toBe("applied");
  expect(q("[data-subject-state]").textContent).toBe("Accepted");
  expect(q("[data-subject-state]").className).toContain("--ink-green");
  expect(field("priority").getAttribute("data-field-before")).toBe("P2");
  expect(q("[data-subject-reasons]")).not.toBeNull();
  expect(q("[data-settled]")).toBeNull();
  // No way back on the entry: a verdict's undo is the org record's.
  expect(document.body.textContent).not.toMatch(/undo/i);
  m.done();
});

test("mounted already decided an entry is settled: an accepted one keeps its fields, a skipped one is its sentence", () => {
  const stamp = [{ kind: "project_meta" as const, subject: { type: "project" as const, id: "p-network", label: "Private Network" }, before: { priority: "p2" }, after: { priority: "p1" }, labels: {} }];
  const applied = mount({ card: cardOf([FIRST, { ...RAISE, status: "applied", applied_diff: stamp }], "Private Network"), ordinal: 4, onDecide });
  expect(q("[data-settled]")).not.toBeNull();
  expect(field("priority").textContent).toContain("P2");
  expect(q("[data-subject-reasons]")).toBeNull();
  applied.done();
  // Applied before the stamp existed: what was set, alone.
  const bare = mount({ card: cardOf([FIRST, { ...RAISE, status: "applied" }], "Private Network"), ordinal: 4, onDecide });
  expect(field("priority").getAttribute("data-field-before")).toBeNull();
  expect(field("priority").textContent).toBe("P1");
  bare.done();
  const skipped = mount({ card: cardOf([FIRST, { ...RAISE, status: "skipped" }], "Private Network"), ordinal: 4, onDecide });
  expect(q("[data-subject-state]").textContent).toBe("Skipped");
  expect(q("[data-subject-sentence]").textContent).toBe("Make Private Network a high priority.");
  expect(qa("[data-field]")).toEqual([]);
  expect(q("[data-subject-reasons]")).toBeNull();
  expect(q("[data-subject-accept]")).toBeNull();
  skipped.done();
});

test("changes that ended differently: each group carries its own word or its own Retry and Skip", () => {
  const card = cardOf([G1, { ...G9, status: "applied" }, { ...G10, status: "failed", applied_note: "Agent Quality was archived while this waited." }], "Proud relationships");
  const m = mount({ card, ordinal: 9, onDecide });
  expect(q("[data-subject-verdicts]").textContent).toBe("1 of 2 failed");
  expect(qa("[data-subject-group]").map((g) => g.getAttribute("data-subject-group"))).toEqual(["9", "10"]);
  expect(qa("[data-subject-group-state]").map((g) => [g.getAttribute("data-subject-group-state"), g.textContent])).toEqual([["applied", "Accepted"], ["failed", "RetrySkip"]]);
  // The note sits with the change that failed, and each change keeps its own reason.
  const [first, second] = qa("[data-subject-group]");
  expect(first.querySelector("[data-failed-note]")).toBeNull();
  expect(second.querySelector("[data-failed-note]")!.textContent).toBe("Failed: Agent Quality was archived while this waited.");
  expect(first.querySelector("[data-subject-reasons]")!.textContent).toBe("Because g9.");
  expect(second.querySelector("[data-subject-reasons]")!.textContent).toBe("Because g10.");
  click(q("[data-subject-group-state='failed'] [data-subject-accept]"));
  expect(sent.splice(0)).toEqual([[["g10"], "accept"]]);
  m.done();
});

test("several changes to a goal that exists read change by change under one sentence and one verdict", () => {
  const m = mount({ card: cardOf([G1, G9, G10], "Proud relationships"), ordinal: 9, onDecide });
  expect(q("[data-subject-sentence]").textContent).toBe("Move Proud relationships under the purpose, measure it by Trust breaks per day and have Agent Quality carry it.");
  expect(qa("[data-subject-group]").length).toBe(2);
  expect(field("parent").getAttribute("data-field-before")).toBe("at the top level");
  expect(field("parent").getAttribute("data-field-after")).toBe("under the purpose");
  expect(field("projects").getAttribute("data-field-before")).toBe("no project");
  expect(qa("[data-subject-accept]").length).toBe(1);
  click(q("[data-subject-accept]"));
  expect(sent.splice(0)).toEqual([[["g10", "g9"], "accept"]]);
  m.done();
});

test("a goal with goals below it says how many projects carry it and opens to the list; measures read as written", () => {
  const purpose = mount({ card: cardOf([G1, G2], PURPOSE), ordinal: 1, onDecide });
  expect(q("[data-subject-sentence]").textContent).toBe(`Set ${PURPOSE} as the purpose.`);
  const carried = field("projects");
  expect(carried.textContent).toBe("5 projects, through the goals below show");
  click(carried.querySelector("[data-field-show]")!);
  expect(carried.textContent).toBe("Infrastructure, Matching & Funnel, People & Deals, Private Network, Agent Quality hide");
  expect(reached).toEqual([]);
  // The owner is a face and a name.
  expect(field("owner").querySelector("[data-face='person']")).not.toBeNull();
  purpose.done();

  const child = mount({ card: cardOf([G1, G2], "Improve conversion"), ordinal: 2, onDecide });
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

test("a linked source opens as a link, and Edit and Ask sit on the same quiet line", () => {
  const linked = { ...RAISE, evidence: [{ label: "3 decisions waiting", href: "/decisions" }, { label: "The ranking doc", href: "https://example.com/doc" }] };
  const asked: string[] = [];
  const m = mount({ card: cardOf([FIRST, linked], "Private Network"), ordinal: 4, onDecide, onAsk: () => asked.push("ask"), onEdit: () => asked.push("edit"), editor: h("form", { "data-editor": true }) });
  click(q("[data-subject-sources] button"));
  expect(qa("[data-subject-sources] a").map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target")])).toEqual([["3 decisions waiting", "/decisions", null], ["The ranking doc", "https://example.com/doc", "_blank"]]);
  click(q("[data-subject-edit]"));
  click(q("[data-ask-about]"));
  expect(asked).toEqual(["edit", "ask"]);
  expect(q("[data-editor]")).not.toBeNull();
  expect(reached).toEqual([]);
  m.done();
});

test("what accepting would take over: the card owns the choice and sends it with Accept, never with Skip", () => {
  const card = cardOf(ROLE, "Head of Platform");
  const m = mount({ card, lead: true, onDecide, takeover: { phrase: "12 sessions now report to @platform" } });
  expect(q("[data-takeover-phrase]").textContent).toContain("12 sessions now report to @platform");
  click(q("[data-subject-accept]"));
  click(q("[data-takeover-leave-input]"));
  click(q("[data-subject-accept]"));
  click(q("[data-subject-skip]"));
  const ids = ["role", "limit", "trust", "routine"];
  expect(sent.splice(0)).toEqual([[ids, "accept"], [ids, "accept", { leave_sessions: true }], [ids, "skip"]]);
  m.done();
});

test("the one line form: a face, the sentence, small verdicts; a press on the line picks it, a verdict does not", () => {
  const picked: string[] = [];
  const m = mount({ card: cardOf([FIRST, RAISE], "Private Network"), variant: "row", ordinal: 2, onDecide, onPick: () => picked.push("pick") });
  const root = q("[data-subject]");
  expect(root.getAttribute("data-subject-variant")).toBe("row");
  expect(root.getAttribute("role")).toBe("button");
  expect(q("[data-subject-sentence]").textContent).toBe("Raise Private Network to a high priority.");
  expect(q("[data-subject-sentence] [data-face='record']")).not.toBeNull();
  expect(qa("[data-field]")).toEqual([]);
  click(q("[data-subject-accept]"));
  expect(picked).toEqual([]);
  expect(sent.splice(0)).toEqual([[["r4"], "accept"]]);
  click(q("[data-subject-sentence]"));
  fire(root, "keydown");
  expect(picked).toEqual(["pick", "pick"]);
  m.update({ card: cardOf([FIRST, { ...RAISE, status: "applied" }], "Private Network"), variant: "row", ordinal: 2, onDecide });
  expect(q("[data-subject-state]").textContent).toBe("Accepted");
  expect(q("[data-subject-accept]")).toBeNull();
  reached.splice(0);
  m.done();
});

test("standing alone: the place line above the sentence; read only with no verdict; the layout it was told, or its own width", () => {
  const card = cardOf([FIRST, RAISE], "Infrastructure");
  const m = mount({ card, lead: true, place: h("span", null, "First of two in the ranking"), layout: "narrow" });
  expect(q("[data-subject-place]").textContent).toBe("First of two in the ranking");
  expect(q("[data-subject]").getAttribute("data-layout")).toBe("narrow");
  expect(q("[data-subject]").className).not.toContain("container-type");
  // Nobody to decide: the state in words, no buttons.
  expect(q("[data-subject-accept]")).toBeNull();
  expect(q("[data-subject-verdicts]").textContent).toBe("To decide");
  m.update({ card, lead: true, onDecide, layout: "wide" });
  expect(q("[data-subject]").getAttribute("data-layout")).toBe("wide");
  m.update({ card, lead: true, onDecide });
  expect(q("[data-subject]").getAttribute("data-layout")).toBe("auto");
  expect(q("[data-subject]").className).toContain("container-type");
  // A host that titles the subject itself asks for the other sentence.
  m.update({ card, onDecide, sentence: "this" });
  expect(q("[data-subject-sentence]").textContent).toBe("Make this project the top priority.");
  expect(qa("[data-subject-sentence] b")).toEqual([]);
  m.done();
});

test("a limit alone is one plain sentence with a verdict and nothing else", () => {
  const card = cardsOf([change("limit", 1, { kind: "budget", handle: "growth", caps: { wakes_per_day: 12, tokens_per_day: 800_000 } }, "proposed", { rationale: "Growth wakes 30 times a day." })])[0];
  const m = mount({ card, lead: true, onDecide });
  expect(q("[data-subject-sentence]").textContent).toBe("Head of Growth keeps a safety net on its daily work.");
  expect(qa("[data-field]")).toEqual([]);
  expect(document.body.textContent).not.toMatch(/wakes|tokens|caps|limit|\d/i);
  click(q("[data-subject-accept]"));
  expect(sent.splice(0)).toEqual([[["limit"], "accept"]]);
  m.done();
});

test("the closing row: words at the left, one filled button and a word at the right, or what happened", () => {
  const root = createRoot(document.getElementById("root")!);
  const pressed: string[] = [];
  React.act(() => root.render(frame(h(LedgerClosingRow, { left: h("button", { "data-chart": true }, "Chart"), accept: { label: "Accept all 9", onClick: () => pressed.push("accept") }, skip: { label: "Skip all", onClick: () => pressed.push("skip") } }))));
  expect(q("[data-accept]").textContent).toBe("Accept all 9");
  expect(q("[data-accept]").style.background).toBe("var(--sol-violet)");
  click(q("[data-accept]"));
  click(q("[data-skip]"));
  click(q("[data-chart]"));
  expect(pressed).toEqual(["accept", "skip"]);
  expect(reached).toEqual([]);
  React.act(() => root.render(frame(h(LedgerClosingRow, { outcome: "7 accepted, 2 skipped" }))));
  expect(q("[data-accept]")).toBeNull();
  expect(q("[data-proposal-outcome]").textContent).toBe("7 accepted, 2 skipped");
  React.act(() => root.unmount());
});

test("no entry draws a dashed line, a hatch, or an upper case label", () => {
  const cards = [...cardsOf([G1, G2, { ...G9, status: "applied" }, { ...G10, status: "failed", applied_note: "x" }]), ...cardsOf(ROLE), ...cardsOf([FIRST, RAISE])];
  const root = createRoot(document.getElementById("root")!);
  React.act(() => root.render(h("div", null, cards.map((card, i) => h(ProposalSubjectCard, { key: card.key, card, ordinal: i + 1, onDecide })))));
  const html = document.getElementById("root")!.innerHTML;
  expect(html).not.toMatch(/dashed|dotted|repeating-linear-gradient|uppercase|tracking-\[/);
  expect(html).not.toContain(String.fromCharCode(8212));
  // A value's words are the ones its attribute carries.
  expect(fieldValueText({ kind: "measures", measures: [{ name: "Replies", target: "1% higher (Cameron)" }] })).toBe("Replies, target 1% higher (Cameron)");
  React.act(() => root.unmount());
});
