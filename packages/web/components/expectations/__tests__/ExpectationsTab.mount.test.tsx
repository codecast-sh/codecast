// Mounts a project's Expectations tab and the /expectations overview in jsdom
// from store rows alone (the-line-model.md LM5): the header says what an
// expectation is and where the document stands; each line shows how often
// findings broke it, opening to the findings and their causes; the filters
// narrow to broken, never cited and contested lines; a line is changed or its
// open question settled in place; the history names each version's how; a
// project with none explains them and offers both ways to start; the
// overview orders documents by what waits and what breaks.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/projects/p1?tab=expectations", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");

// Same mocks as the panel's and the Line tab's mount tests: bun shares
// mock.module across the files of one run, so they must agree.
mock.module("../../../hooks/useSyncCollection", () => ({
  useSyncCollection: () => ({ ready: true }),
  useFeederError: () => {},
  entityIdArgs: () => "skip",
  applyCollectionFeed: () => {},
  keyRowsBy: (rows: any[]) => rows ?? [],
}));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {} }),
  usePathname: () => "/projects/p1",
  useSearchParams: () => new URLSearchParams("tab=line"),
}));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: null }) }));
mock.module("../../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));

const { useInboxStore } = await import("../../../store/inboxStore");
const { ExpectationsTab } = await import("../ExpectationsTab");
const { ExpectationsOverview } = await import("../ExpectationsOverview");

// The real writes, put back after this file: bun runs the files of one run in
// one store, and a later file captures the actions it finds at import.
const realActions = { editExpectations: useInboxStore.getState().editExpectations, resolveExpectationProposal: useInboxStore.getState().resolveExpectationProposal };
afterAll(() => { useInboxStore.setState(realActions as any); closeDomWindow(dom); restoreGlobals(); });

const PID = "p".repeat(32);
const ME = "u".repeat(32);
const TEAM = "t".repeat(32);
const CALL = { kind: "call", ref: "cl-96:718", quote: "a call card's facts should hold true", when: "2026-09-30" };
const line = (n: number, text: string, part: string, over: Record<string, unknown> = {}) => ({ id: `ex-callers-call-${n}`, text, part, status: "active", citations: [CALL], added_in: 1, changed_in: 1, ...over });
const finding = (n: number, days: number) => ({ short_id: `sg-${n}`, title: `Card said the wrong broker (${n})`, kind: "prompt_miss", source: "judge", created_at: Date.now() - days * 86_400_000, cause: { id: "c1", short_id: "ct-512", title: "Card facts", status: "open" } });
const row = (over: Record<string, unknown> = {}) => ({
  _id: PID,
  project: { id: PID, title: "Callers" },
  current_version: 2,
  doc: {
    project: { id: PID, title: "Callers" }, version: 2, prefix: "callers-call", next_n: 5, how: "person", summary: "Seed", applied_at: Date.UTC(2026, 9, 3), applied_by: "Ashot",
    items: [
      line(1, "A call card's facts are true.", "Calls"),
      line(2, "Callbacks happen only when the contact asked for one.", "Calls", { note: "Does a voicemail count as asking?" }),
      line(3, "An intro goes out within a day.", "Intros"),
    ],
  },
  versions: [
    { version: 2, summary: "Ashot added: an intro goes out within a day", how: "person", applied_at: Date.UTC(2026, 9, 3), applied_by: "Ashot", active: 3, added: 1, changed: 0, retired: 0, proposal: "xp-3", proposed_by: "Ashot" },
    { version: 1, summary: "From the Sep 30 call", how: "auto", applied_at: Date.UTC(2026, 9, 1), applied_by: "Ashot", active: 2, added: 2, changed: 0, retired: 0, proposal: "xp-1", proposed_by: "Ashot", from_session: true },
  ],
  proposals: [
    { short_id: "xp-7", status: "open", summary: "From the Oct 4 call", changes: 1, base_version: 2, created_at: Date.now() - 3_600_000, proposed_by: "Ashot", from_session: true,
      ops: [{ op: "add", part: "Calls", text: "The card names the broker.", citations: [{ kind: "call", ref: "cl-99:12", quote: "it should name the broker on the card", when: "2026-10-04" }] }] },
    { short_id: "xp-2", status: "dropped", summary: "Too broad", changes: 1, base_version: 1, created_at: Date.UTC(2026, 9, 2), resolved_at: Date.UTC(2026, 9, 2) },
  ],
  cursor: null,
  you_answer: true,
  person: "Ashot",
  usage: { since: 0, lines: { "ex-callers-call-1": { d7: 2, d30: 3, last_at: Date.now(), findings: [finding(1, 1), finding(2, 3), finding(3, 12)] } } },
  sources: { "call:cl-96:718": { who: "Ashot" }, "call:cl-99:12": { who: "Cam" } },
  routine: null,
  ...over,
});

let calls: unknown[][] = [];
beforeEach(() => {
  calls = [];
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Ashot" }, teamMembers: [{ _id: ME, name: "Ashot" }], chatChannels: {}, pullRequests: {}, commits: {},
    projects: { [PID]: { _id: PID, short_id: "pj-4", title: "Callers", workspace: `team:${TEAM}` } },
    projectExpectations: { [PID]: row() }, sessionDecisions: {}, pending: {},
    editExpectations: (...a: unknown[]) => { calls.push(["edit", ...a]); },
    resolveExpectationProposal: (...a: unknown[]) => { calls.push(["resolve", ...a]); },
  } as any);
});

async function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, done: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }); };
function setValue(el: Element | null, value: string) {
  expect(el).toBeTruthy();
  const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  const key = Object.keys(el as object).find((k) => k.startsWith("__reactProps"));
  (el as any)[key!]?.onChange?.({ target: el, currentTarget: el, nativeEvent: new dom.window.Event("input") });
}
const submit = async (form: Element | null) => { await act(async () => { (form as HTMLFormElement).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); }); };
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

test("the header says what an expectation is and where the document stands; proposals lead", async () => {
  const { host, done } = await mount(<ExpectationsTab projectId={PID} />);
  expect(text(host.querySelector("[data-expectations-about]"))).toContain("Plain sentences about how the product should behave");
  expect(text(host.querySelector("[data-expectations-stat='Lines']"))).toBe("Lines3in 2 areas");
  expect(text(host.querySelector("[data-expectations-stat='Broken in 30 days']"))).toBe("Broken in 30 days12 breaks this week");
  expect(text(host.querySelector("[data-expectations-stat='Never cited']"))).toContain("2");
  expect(text(host.querySelector("[data-expectations-stat='Version']"))).toContain("1 waiting");
  // The waiting proposal comes before the document, with who proposed it and its source's speaker.
  const order = [...host.querySelectorAll("[data-expectation-proposals], [data-expectations-lines]")].map((el) => (el as HTMLElement).hasAttribute("data-expectation-proposals") ? "proposals" : "lines");
  expect(order).toEqual(["proposals", "lines"]);
  const p = host.querySelector("[data-expectation-proposal='xp-7']")!;
  expect(text(p)).toContain("Ashot's session");
  expect(text(p.querySelector("[data-citation-who]"))).toBe("Cam");
  await click(p.querySelector("[data-expectation-apply='xp-7']"));
  expect(calls).toEqual([["resolve", PID, "xp-7", "apply"]]);
  // No CLI command anywhere on the page.
  expect(host.textContent).not.toContain("cast ");
  await done();
}, 30_000);

test("each source is a quote with who said it, where and when", async () => {
  const { host, done } = await mount(<ExpectationsTab projectId={PID} />);
  const first = host.querySelector("[data-expectation='ex-callers-call-1'] [data-citation-line]")!;
  expect(text(first.querySelector("[data-citation-quote]"))).toBe("a call card's facts should hold true");
  expect(text(first.querySelector("[data-citation-who]"))).toBe("Ashot");
  expect(text(first.querySelector("[data-citation-when]"))).toBe("Sep 30");
  await done();
}, 30_000);

test("usage: a broken line opens to its findings and causes; a quiet one says it never fired", async () => {
  const { host, done } = await mount(<ExpectationsTab projectId={PID} />);
  const broken = host.querySelector("[data-expectation='ex-callers-call-1']")!;
  const usage = broken.querySelector("[data-expectation-usage]") as HTMLElement;
  expect(usage.dataset.expectationUsage).toBe("week");
  expect(text(usage)).toBe("3breaks in 30d(2 this week)");
  expect(text(host.querySelector("[data-expectation='ex-callers-call-3'] [data-expectation-usage]"))).toBe("never cited");
  await click(usage);
  const findings = broken.querySelectorAll("[data-expectation-finding]");
  expect(findings.length).toBe(3);
  expect(text(findings[0])).toContain("Card said the wrong broker (1)");
  expect(findings[0].querySelector("[data-expectation-cause]")).toBeTruthy();
  await done();
}, 30_000);

test("filters narrow to broken, never cited and contested lines", async () => {
  const { host, done } = await mount(<ExpectationsTab projectId={PID} />);
  const ids = () => [...host.querySelectorAll("[data-expectations-lines] [data-expectation]")].map((el) => (el as HTMLElement).dataset.expectation);
  expect(text(host.querySelector("[data-expectations-filter='quiet']"))).toBe("Never cited2");
  await click(host.querySelector("[data-expectations-filter='broken']"));
  expect(ids()).toEqual(["ex-callers-call-1"]);
  await click(host.querySelector("[data-expectations-filter='questions']"));
  expect(ids()).toEqual(["ex-callers-call-2"]);
  await click(host.querySelector("[data-expectations-filter='quiet']"));
  expect(ids()).toEqual(["ex-callers-call-2", "ex-callers-call-3"]);
  await done();
}, 30_000);

test("a line is changed in place, and a contested line's question is settled with how", async () => {
  const { host, done } = await mount(<ExpectationsTab projectId={PID} />);
  await click(host.querySelector("[data-expectation-edit='ex-callers-call-1']"));
  const form = host.querySelector("[data-expectation-edit-form]")!;
  expect(text(form.querySelector("[data-expectation-edit-submit]"))).toBe("Save");
  await act(async () => { setValue(form.querySelector("[data-expectation-edit-text]"), "A call card's facts are true for every caller."); });
  await submit(form);
  expect(calls[0]).toEqual(["edit", PID, { op: "edit", id: "ex-callers-call-1", text: "A call card's facts are true for every caller." }]);

  await click(host.querySelector("[data-expectation-settle='ex-callers-call-2']"));
  const settle = host.querySelector("[data-expectation-settle-form]")!;
  await act(async () => { setValue(settle.querySelector("[data-expectation-settle-why]"), "A voicemail asking for a call counts, ruled on the Oct 6 call"); });
  await submit(settle);
  expect(calls[1]).toEqual(["edit", PID, { op: "edit", id: "ex-callers-call-2", note: "", why: "A voicemail asking for a call counts, ruled on the Oct 6 call" }]);
  await done();
}, 30_000);

test("adding a line with a source names what kind of source it is", async () => {
  const { host, done } = await mount(<ExpectationsTab projectId={PID} />);
  await click(host.querySelector("[data-expectations-add]"));
  const form = host.querySelector("[data-expectation-add-form]")!;
  await act(async () => { setValue(form.querySelector("[data-expectation-text]"), "Every callback names who asked for it."); });
  await act(async () => { setValue(form.querySelector("[data-expectation-source]"), "ct-512"); });
  expect((form.querySelector("[data-expectation-source-detail]") as HTMLElement).dataset.expectationSourceDetail).toBe("task");
  await act(async () => { setValue(form.querySelector("[data-expectation-source-quote]"), "say who asked"); });
  await submit(form);
  expect(calls[0]).toEqual(["edit", PID, { op: "add", text: "Every callback names who asked for it.", part: "Calls", source: { kind: "task", ref: "ct-512", quote: "say who asked" } }]);
  await done();
}, 30_000);

test("history: each version with how it landed, and a dropped proposal", async () => {
  const { host, done } = await mount(<ExpectationsTab projectId={PID} />);
  const entries = [...host.querySelectorAll("[data-expectations-history-entry]")].map((el) => (el as HTMLElement).dataset.expectationsHistoryEntry);
  expect(entries).toEqual(["v2", "closed", "v1"]);
  expect(text(host.querySelector("[data-expectations-history-entry='v1'] [data-expectations-history-how]"))).toBe("Applied on its own: every line it added quotes words a person said, from xp-1 proposed by Ashot's session");
  expect(text(host.querySelector("[data-expectations-history-entry='v2']"))).toContain("1 added");
  await done();
}, 30_000);

test("a project with no expectations explains them and offers both ways to start", async () => {
  useInboxStore.setState({ projectExpectations: { [PID]: row({ doc: null, current_version: 0, versions: [], proposals: [], usage: { since: 0, lines: {} } }) } } as any);
  const { host, done } = await mount(<ExpectationsTab projectId={PID} />);
  const first = host.querySelector("[data-expectations-first-run]")!;
  expect(text(first)).toContain("Write down how Callers should behave");
  expect(text(first)).toContain("An expectation is one plain sentence");
  expect(text(first.querySelector("[data-expectations-draft]"))).toBe("Draft from recent context");
  await click(first.querySelector("[data-expectations-write-first]"));
  expect(host.querySelector("[data-expectations-first-run]")).toBeNull();
  expect(host.querySelector("[data-expectation-add-form]")).toBeTruthy();
  expect(host.textContent).not.toContain("cast ");
  await done();
}, 30_000);

test("the overview: what waits and what breaks first, projects without a document after", async () => {
  const r = (id: string, title: string, over: Record<string, unknown>) => ({ _id: id, workspace: `team:${TEAM}`, project: { id, short_id: `pj-${id}`, title }, version: 2, applied_at: Date.UTC(2026, 9, 3), active: 4, retired: 0, parts: 2, open_proposals: 0, breaks7: 0, breaks30: 0, broken: 0, most_broken: [], ...over });
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Ashot", team_id: TEAM, active_team_id: TEAM },
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: { ...((useInboxStore.getState() as any).clientState?.ui ?? {}), active_team_id: TEAM } },
    expectationsOverview: {
      a: r("a", "Agent Quality", { breaks30: 7, breaks7: 2, broken: 1, most_broken: [{ id: "ex-agent-quality-3", text: "A reply names the broker.", part: "Replies", d7: 2, d30: 7 }] }),
      b: r("b", "Billing", {}),
      c: r("c", "Callers", { open_proposals: 2 }),
      d: r("d", "Docs site", { version: 0, active: 0, parts: 0, applied_at: null }),
    },
  } as any);
  const { host, done } = await mount(<ExpectationsOverview />);
  const docs = [...host.querySelectorAll("[data-expectations-document]")].map((el) => (el as HTMLElement).dataset.expectationsDocument);
  expect(docs).toEqual(["pj-c", "pj-a", "pj-b"]);
  expect(text(host.querySelector("[data-expectations-document='pj-a']"))).toContain("A reply names the broker.");
  expect(host.querySelector("[data-expectations-document='pj-a'] a[href='/projects/pj-a?tab=expectations#ex-agent-quality-3']")).toBeTruthy();
  expect(text(host.querySelector("[data-expectations-waiting]"))).toBe("2 waiting");
  expect(host.querySelector("[data-expectations-start='pj-d']")?.getAttribute("href")).toBe("/projects/pj-d?tab=expectations");
  await done();
}, 30_000);
