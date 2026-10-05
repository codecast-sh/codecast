// Mounts the proposal card (docs/architecture/org-staffing.md S24, S39) in
// jsdom against stubbed store rows: a proposed proposal (a new role under the
// founder and a move onto it, drawn as two ledger entries with their own
// Accept and Skip, and a closing row with Chart, Ask, Accept all and Skip
// all), an applied one (what happened, in words), and a failed one (Retry,
// the note). The verdicts reach the page's own store actions with the seen
// stamp; Ask puts the proposal in the thread's composer.
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

const AUTHOR = { kind: "role" as const, id: "role-cos", name: "Head of People", handle: "head-of-people", short_id: "or-9", avatar: "fox" };
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
    // The limit rides on the role this proposal creates.
    "c5-limit": change("c5-limit", "p5", 2, { ...LIMIT, handle: "platform" }, "proposed", { rationale: "Platform gets 800k tokens." }),
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

const sentences = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-subject-sentence]")).map((s) => s.textContent);
const subjects = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-subject]"));

test("a proposed proposal draws one entry per subject, each with its verdict, and a closing row for all of it", () => {
  const root = mount(h(ReviewComposerContext.Provider, { value: composer }, card("op-1")));
  const c = q("[data-card='op-1']");
  expect(c.querySelector(".entity-card")).not.toBeNull();
  expect(c.textContent).toContain("Bring platform under one lead");
  // The meta line counts the cards a person sees.
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("2 to decide");
  expect(c.querySelector("[data-proposal-author='role']")!.textContent).toContain("Head of People");
  // The letter's lead opens the card.
  expect(c.querySelector("[data-proposal-letter]")!.textContent).toBe("Why bring platform under one lead.");

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
  // The old tree and its dashed tags are gone.
  expect(c.querySelector("[data-tree-row], [data-ghost-tag], [data-proposal-rationale]")).toBeNull();

  // One entry's Accept: one decide for its change, with the seen stamp.
  click(c.querySelector("[data-subject='role:growth'] [data-subject-accept]")!);
  expect(calls.splice(0)).toEqual([["decide", "c1-move", "accept", undefined, { revised_at: 0, seqs: [1, 2] }]]);
  click(c.querySelector("[data-subject='role:platform'] [data-subject-skip]")!);
  expect(calls.splice(0)).toEqual([["decide", "c1-role", "skip", undefined, { revised_at: 0, seqs: [1, 2] }]]);

  // The closing row. Accept all: the page's acceptAll with the seen stamp (every waiting seq).
  expect(c.querySelector("[data-accept]")!.textContent).toBe("Accept all 2");
  expect(c.querySelector("[data-skip]")!.textContent).toBe("Skip all");
  click(c.querySelector("[data-accept]")!);
  expect(calls.splice(0)).toEqual([["accept", "p1", { seen: { revised_at: 0, seqs: [1, 2] } }]]);
  // Skip all: one decide per waiting change, the same stamp.
  click(c.querySelector("[data-skip]")!);
  expect(calls.splice(0)).toEqual([
    ["decide", "c1-role", "skip", undefined, { revised_at: 0, seqs: [1, 2] }],
    ["decide", "c1-move", "skip", undefined, { revised_at: 0, seqs: [1, 2] }],
  ]);
  // Chart and Ask are words at the left; Ask puts the proposal in the thread's composer as the next message.
  expect(c.querySelector("[data-open-chart='op-1']")!.textContent).toBe("Chart");
  click(c.querySelector("[data-ledger-close] [data-ask-about]")!);
  expect(populated).toEqual(['About op-1 ("Bring platform under one lead"):\n\n']);
  // A verdict click never toggles the card open.
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe("false");

  // Open, the card is the same ledger under the whole letter.
  click(c.querySelector(".entity-card")!);
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe("true");
  const open = c.querySelector<HTMLElement>(".entity-card-expand")!;
  expect(sentences(open)).toEqual(["Add the role Head of Platform, reporting to you.", "Have Head of Growth report to Head of Platform."]);
  expect(open.querySelector("[data-accept]")!.textContent).toBe("Accept all 2");
  React.act(() => root.unmount());
});

test("an applied proposal says what happened and offers only Chart and Ask", () => {
  const root = mount(card("op-2"));
  const c = q("[data-card='op-2']");
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("2 accepted");
  expect(c.querySelector("[data-accept]")).toBeNull();
  expect(c.querySelector("[data-skip]")).toBeNull();
  expect(c.querySelector("[data-subject-accept]")).toBeNull();
  expect(c.querySelector("[data-proposal-outcome]")!.textContent).toBe("2 accepted");
  expect(subjects(c).map((s) => s.getAttribute("data-subject-status"))).toEqual(["applied", "applied"]);
  expect(Array.from(c.querySelectorAll("[data-subject-state]")).map((s) => s.textContent)).toEqual(["Accepted", "Accepted"]);
  // Without a composer in reach, Ask is the link to the proposal on the org page.
  expect(c.querySelector("[data-ask-about]")!.getAttribute("href")).toBe("/org?proposal=op-2");
  React.act(() => root.unmount());
});

test("a failed change keeps the card decidable: Retry, Skip and the note", () => {
  const root = mount(card("op-3"));
  const c = q("[data-card='op-3']");
  // Nothing else waits, so the line is the outcome, with the failure named.
  expect(c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("1 accepted, 1 failed");
  const failed = c.querySelector<HTMLElement>("[data-subject='role:platform']")!;
  expect(failed.getAttribute("data-subject-status")).toBe("failed");
  expect(failed.querySelector("[data-failed-note]")!.textContent).toBe("Failed: A role already answers to @platform");
  expect(failed.querySelector("[data-subject-accept]")!.textContent).toBe("Retry");
  expect(failed.querySelector("[data-subject-skip]")).not.toBeNull();
  // The closing row offers the same on what still waits.
  expect(c.querySelector("[data-accept]")!.textContent).toContain("Retry");
  expect(c.querySelector("[data-skip]")).not.toBeNull();
  click(c.querySelector("[data-accept]")!);
  expect(calls.splice(0)).toEqual([["accept", "p3", { seen: { revised_at: 0, seqs: [1] } }]]);
  click(failed.querySelector("[data-subject-accept]")!);
  expect(calls.splice(0)).toEqual([["decide", "c3-role", "accept", undefined, { revised_at: 0, seqs: [1] }]]);
  React.act(() => root.unmount());
});

test("a limit never reaches the person: no row beside drawn changes, plain words when alone (S23.2)", () => {
  const root = mount(h("div", null, card("op-4"), card("op-5")));
  // Alone: one plain sentence naming the role, no unit, and the verdicts still apply.
  const alone = q("[data-card='op-4']");
  expect(sentences(alone)).toEqual(["Head of Growth keeps a safety net on its daily work."]);
  expect(alone.querySelector("[data-field]")).toBeNull();
  expect(alone.textContent).not.toMatch(/wakes|tokens|caps|limit/i);
  expect(alone.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("1 to decide");
  // One card is the whole decision: its own Accept is the frame's filled button, and the closing row adds none.
  expect(alone.querySelector<HTMLElement>("[data-subject-accept]")!.style.background).toBe("var(--sol-violet)");
  expect(alone.querySelector("[data-accept]")).toBeNull();
  click(alone.querySelector("[data-subject-accept]")!);
  expect(calls.splice(0)).toEqual([["decide", "c4-limit", "accept", undefined, { revised_at: 0, seqs: [1] }]]);
  // Beside a drawn change: nothing of it, no row, no words, and it is decided with the role it rides on.
  const beside = q("[data-card='op-5']");
  expect(subjects(beside).map((s) => [s.getAttribute("data-subject"), s.getAttribute("data-change-ids")])).toEqual([["role:platform", "c5-role c5-limit"]]);
  expect(beside.textContent).not.toMatch(/wakes|tokens|caps|limit|safety net/i);
  expect(beside.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta")).toBe("1 to decide");
  click(beside.querySelector("[data-subject-accept]")!);
  expect(calls.splice(0)).toEqual([
    ["decide", "c5-role", "accept", undefined, { revised_at: 0, seqs: [1, 2] }],
    ["decide", "c5-limit", "accept", undefined, { revised_at: 0, seqs: [1, 2] }],
  ]);
  // Expanded, the rationale of the quiet change stays out too.
  click(beside.querySelector(".entity-card")!);
  expect(beside.textContent).not.toMatch(/800k tokens/);
  expect(beside.textContent).toContain("Because c5-role.");
  React.act(() => root.unmount());
});

test("an op id the store has never seen is a loading card, then not available once served", () => {
  const root = mount(card("op-404"));
  const c = q("[data-card='op-404']");
  // The feeder reports served and the store holds nothing: not available.
  expect(c.textContent).toContain("Not available to you");
  React.act(() => root.unmount());
});

// ---------------------------------------------------------------- one change (`op-N#seq`)

// A proposal whose author withdrew one of its two changes on the person's word.
useInboxStore.setState((s: any) => ({
  orgProposals: { ...s.orgProposals, p6: proposal("p6", "op-6", "Platform, without the move") },
  orgProposalChanges: {
    ...s.orgProposalChanges,
    "c6-role": change("c6-role", "p6", 1, ROLE),
    "c6-move": change("c6-move", "p6", 2, MOVE, "removed", { revision: { kind: "removed", note: "You said growth stays where it is.", at: 5 } }),
  },
}));

test("op-N#seq draws the one card that holds the change: its place in the proposal, the entry, a filled Accept", () => {
  const root = mount(h(EntityObjectCard, { refId: "op-1#2", count: 3 }));
  const frame = q("[data-change-ref]");
  expect(frame.getAttribute("data-change-ref")).toBe("op-1#2");
  // The card is the content: a bordered frame with no strip, no meta line, nothing to expand, no number and no closing row.
  expect(frame.classList.contains("entity-card")).toBe(true);
  expect(frame.classList.contains("not-prose")).toBe(true);
  expect(frame.getAttribute("aria-expanded")).toBeNull();
  expect(frame.querySelector("[data-proposal-meta], [data-ledger-close], [data-subject-ordinal], .entity-card-expand, [data-proposal-letter]")).toBeNull();
  // Three change references on adjacent lines are three full width cards, never tiles.
  expect(frame.getAttribute("style")).toContain("grid-column: 1 / -1");
  expect(frame.querySelector("[data-subject-variant]")!.getAttribute("data-subject-variant")).toBe("full");

  // First line: where it sits, and the proposal's title opening the org page with this change in focus.
  expect(frame.querySelector("[data-subject-place]")!.textContent).toBe("Second of two in Bring platform under one lead");
  expect(frame.querySelector("[data-subject-proposal]")!.getAttribute("href")).toBe("/org?proposal=op-1&focus=2");
  // Then the one entry, with what was there before.
  expect(subjects(frame).map((s) => [s.getAttribute("data-subject"), s.getAttribute("data-subject-status"), s.getAttribute("data-change-ids")])).toEqual([["role:growth", "proposed", "c1-move"]]);
  expect(sentences(frame)).toEqual(["Have Head of Growth report to Head of Platform."]);
  expect(frame.querySelector("[data-field='reports_to']")!.getAttribute("data-field-before")).toBe("Ashot Petrosian");
  expect(frame.querySelector("[data-subject-reasons]")!.textContent).toBe("Because c1-move.");

  // Its Accept is the frame's one filled button; the verdict carries what the reader saw of the WHOLE proposal.
  const accept = frame.querySelector<HTMLElement>("[data-subject-accept]")!;
  expect(accept.textContent).toBe("Accept");
  expect(accept.style.background).toBe("var(--sol-violet)");
  click(accept);
  expect(calls.splice(0)).toEqual([["decide", "c1-move", "accept", undefined, { revised_at: 0, seqs: [1, 2] }]]);
  click(frame.querySelector("[data-subject-skip]")!);
  expect(calls.splice(0)).toEqual([["decide", "c1-move", "skip", undefined, { revised_at: 0, seqs: [1, 2] }]]);
  React.act(() => root.unmount());
});

test("a change ref names its subject's card: Accept sends one decide per change in it, each with the seen stamp", () => {
  // op-5#2 is the limit that rides on the role op-5 creates: the card is the role's, and the limit is decided with it.
  const root = mount(card("op-5#2"));
  const c = q("[data-card='op-5#2']");
  expect(c.querySelector("[data-change-ref]")!.getAttribute("data-change-ref")).toBe("op-5#2");
  expect(subjects(c).map((s) => [s.getAttribute("data-subject"), s.getAttribute("data-change-ids")])).toEqual([["role:platform", "c5-role c5-limit"]]);
  expect(sentences(c)).toEqual(["Add the role Head of Platform, reporting to you."]);
  expect(c.textContent).not.toMatch(/wakes|tokens|caps|limit|safety net/i);
  // A proposal of one card has no place to count.
  expect(c.querySelector("[data-subject-place]")!.textContent).toBe("The only change in Platform lead, within bounds");
  expect(c.querySelector("[data-subject-proposal]")!.getAttribute("href")).toBe("/org?proposal=op-5&focus=2");
  click(c.querySelector("[data-subject-accept]")!);
  expect(calls.splice(0)).toEqual([
    ["decide", "c5-role", "accept", undefined, { revised_at: 0, seqs: [1, 2] }],
    ["decide", "c5-limit", "accept", undefined, { revised_at: 0, seqs: [1, 2] }],
  ]);
  React.act(() => root.unmount());
});

test("a decided change's card says what happened and offers no verdict", () => {
  const root = mount(card("op-2#2"));
  const c = q("[data-card='op-2#2']");
  expect(subjects(c).map((s) => [s.getAttribute("data-subject"), s.getAttribute("data-subject-status")])).toEqual([["role:growth", "applied"]]);
  expect(c.querySelector("[data-subject-state]")!.textContent).toBe("Accepted");
  expect(c.querySelector("[data-subject-accept], [data-subject-skip]")).toBeNull();
  expect(c.querySelector("[data-subject-place]")!.textContent).toBe("Second of two in Growth reports to platform");
  React.act(() => root.unmount());
});

test("a number the proposal does not have, a withdrawn change and a proposal out of reach each draw a quiet note", () => {
  const root = mount(h("div", null, card("op-1#9"), card("op-6#2"), card("op-404#1")));
  // No such change: one line, with the proposal still one press away.
  const gone = q("[data-card='op-1#9']");
  expect(gone.querySelector("[data-change-ref]")!.getAttribute("data-change-ref")).toBe("op-1#9");
  expect(gone.querySelector("[data-subject-missing]")!.getAttribute("data-subject-missing")).toBe("gone");
  expect(gone.textContent).toBe("This change is no longer part of Bring platform under one lead.");
  expect(gone.querySelector("[data-subject-proposal]")!.getAttribute("href")).toBe("/org?proposal=op-1&focus=9");
  // Withdrawn by its author: the sentence it was, struck, and the author's note.
  const withdrawn = q("[data-card='op-6#2']");
  expect(withdrawn.querySelector("[data-subject-missing]")!.getAttribute("data-subject-missing")).toBe("withdrawn");
  expect(withdrawn.querySelector("[data-subject-missing] p")!.textContent).toBe("Have Head of Growth report to Head of Platform.");
  expect(withdrawn.textContent).toContain("Withdrawn by its author: You said growth stays where it is. It was part of Platform, without the move.");
  // The feeder answered and the store holds no such proposal.
  const away = q("[data-card='op-404#1']");
  expect(away.querySelector("[data-change-ref]")!.textContent).toBe("Not available to you.");
  // None of the three can be decided, and none wears the whole proposal's chrome.
  expect(document.querySelector("[data-subject-accept], [data-subject-skip], [data-accept], [data-proposal-meta]")).toBeNull();
  React.act(() => root.unmount());
});

test("in a message, op-N#seq alone on its line is that change's card and inside a sentence it is a pill", async () => {
  const { default: ReactMarkdown } = await import("react-markdown");
  const { MemoryRouter } = await import("react-router");
  const { ASSISTANT_MD_REMARK, MESSAGE_MD_COMPONENTS } = await import("../messageMarkdown");
  const body = "Start with the one everything else waits on.\n\nop-1#2\n\nThen op-1#1 can follow.";
  const root = mount(h(MemoryRouter, null, h(ReactMarkdown, { remarkPlugins: ASSISTANT_MD_REMARK as any, components: MESSAGE_MD_COMPONENTS as any }, body)));
  // Alone on its line: one card row holding the change's card.
  const rows = qa(".entity-card-row");
  expect(rows.length).toBe(1);
  expect(rows[0].querySelector("[data-change-ref]")!.getAttribute("data-change-ref")).toBe("op-1#2");
  expect(sentences(rows[0])).toEqual(["Have Head of Growth report to Head of Platform."]);
  // In a sentence: the proposal's name and the change's number, opening the page with it in focus.
  const pills = qa("a.entity-ref");
  expect(pills.map((p) => [p.textContent, p.getAttribute("href")])).toEqual([["Bring platform under one lead #1", "/org?proposal=op-1&focus=1"]]);
  expect(pills[0].closest("p")!.textContent).toBe("Then Bring platform under one lead #1 can follow.");
  expect(pills[0].closest(".entity-card-row")).toBeNull();
  React.act(() => root.unmount());
});
