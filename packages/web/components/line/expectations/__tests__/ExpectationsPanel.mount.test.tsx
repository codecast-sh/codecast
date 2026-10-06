// Mounts a project's expectations panel in jsdom (line-map.md LX3, LX5;
// the-line-model.md LM5) from a store row alone: the active lines carry their
// sources, retired lines fold, an open proposal shows each change with its
// quotes and answers with Apply or Drop, and a person adds or retires a line
// in their own words. The last test runs the real store action, so the click
// paints the new line before any server answers.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/projects/p1?tab=line", pretendToBeVisual: true });
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

// Same mocks as the Line tab's mount tests: bun shares mock.module across the
// files of one run, so they must agree.
mock.module("../../../../hooks/useSyncCollection", () => ({
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
mock.module("../../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: null }) }));
// A pill opens its session through the router; the panel is mounted without one.
mock.module("../../../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { ExpectationsPanel } = await import("../ExpectationsPanel");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const PID = "p".repeat(32);
const ME = "u".repeat(32);
const CALL = { kind: "call", ref: "cl-96:718", quote: "a call card's facts should hold true", when: "2026-09-30" };
const line = (n: number, text: string, part: string, over: Record<string, unknown> = {}) => ({ id: `ex-callers-call-${n}`, text, part, status: "active", citations: [CALL], added_in: 1, changed_in: 1, ...over });
const row = (over: Record<string, unknown> = {}) => ({
  _id: PID,
  project: { id: PID, title: "Callers & Call Management" },
  current_version: 3,
  doc: {
    project: { id: PID, title: "Callers" }, version: 3, prefix: "callers-call", next_n: 5, how: "person", summary: "Seed", applied_at: Date.UTC(2026, 9, 3), applied_by: "Ashot",
    items: [
      line(1, "A call card's facts are true.", "Calls", { citations: [CALL, { kind: "task", ref: "ct-52376", quote: "facts first", when: "2026-10-01" }] }),
      line(2, "Callbacks happen only when the contact asked for one.", "Calls", { citations: [{ kind: "person", ref: ME, quote: "Callbacks happen only when the contact asked for one.", when: "2026-10-06" }] }),
      line(3, "An intro goes out within a day.", "Intros"),
      line(4, "Old rule.", "Calls", { status: "retired", retired_reason: "We moved past it", changed_in: 3 }),
    ],
  },
  versions: [],
  proposals: [
    { short_id: "xp-7", status: "open", summary: "From the Oct 4 call", changes: 2, base_version: 3, created_at: Date.now() - 2 * 3_600_000,
      ops: [
        { op: "add", part: "Calls", text: "The card names the broker.", citations: [{ kind: "call", ref: "cl-99", quote: "it should name the broker on the card", when: "2026-10-04" }] },
        { op: "retire", id: "ex-callers-call-3", reason: "intros moved to the desk", citations: [{ kind: "chat", ref: "#team/m1", quote: "intros are the desk's now", when: "2026-10-04" }] },
      ] },
    { short_id: "xp-6", status: "applied", summary: "Old", changes: 1, base_version: 2, created_at: 1 },
  ],
  cursor: null,
  you_answer: false,
  ...over,
});

let calls: unknown[][] = [];
const realActions = { editExpectations: useInboxStore.getState().editExpectations, resolveExpectationProposal: useInboxStore.getState().resolveExpectationProposal };
const stubActions = () => useInboxStore.setState({
  editExpectations: (...a: unknown[]) => { calls.push(["edit", ...a]); },
  resolveExpectationProposal: (...a: unknown[]) => { calls.push(["resolve", ...a]); },
} as any);

beforeEach(() => {
  calls = [];
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Cam" }, teamMembers: [{ _id: ME, name: "Cam" }], chatChannels: {}, pullRequests: {}, commits: {},
    projectExpectations: { [PID]: row() }, sessionDecisions: {}, pending: {},
    ...realActions,
  } as any);
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(ExpectationsPanel, { projectId: PID })); });
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
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

test("active lines by part with their sources; retired lines fold under their count", async () => {
  const { host, done } = await mount();
  expect([...host.querySelectorAll<HTMLElement>("[data-expectations-part]")].map((p) => p.dataset.expectationsPart)).toEqual(["Calls", "Intros"]);
  const first = host.querySelector("[data-expectation='ex-callers-call-1']");
  expect(text(first)).toContain("A call card's facts are true.ex-callers-call-1");
  // The first source in full (its words and day), the rest a click away.
  expect(text(first?.querySelector("[data-citation-quote]") ?? null)).toBe("a call card's facts should hold true");
  expect(text(first)).toContain("Sep 30");
  expect(text(first?.querySelector("[data-expectation-more-sources]") ?? null)).toBe("1 more source");
  await click(first!.querySelector("[data-expectation-more-sources]"));
  expect(first!.querySelectorAll("[data-citation-line]").length).toBe(2);
  // A person's own line names them and does not repeat its words as the quote.
  const own = host.querySelector("[data-expectation='ex-callers-call-2']")!;
  expect(text(own.querySelector("[data-citation='person']"))).toBe("Cam");
  expect(own.querySelector("[data-citation-quote]")).toBeNull();
  // Retired: folded, then readable with the reason.
  expect(host.querySelector("[data-expectation='ex-callers-call-4']")).toBeNull();
  const fold = host.querySelector("[data-expectations-retired] button");
  expect(text(fold)).toBe("1 retired line, no longer graded against");
  await click(fold);
  expect(text(host.querySelector("[data-expectation='ex-callers-call-4']"))).toContain("Retired in version 3: We moved past it");
  expect(text(host.querySelector("[data-expectations-version]"))).toContain("version 3");
  expect(text(host.querySelector("[data-expectations-version]"))).toContain("1 proposed");
  await done();
}, 30_000);

test("an open proposal shows each change against the words it changes, and Apply / Drop answer it", async () => {
  stubActions();
  const { host, done } = await mount();
  const p = host.querySelector("[data-expectation-proposal='xp-7']")!;
  expect(host.querySelector("[data-expectation-proposal='xp-6']")).toBeNull();
  const changes = [...p.querySelectorAll("[data-expectation-change]")];
  expect(changes.map((c) => (c as HTMLElement).dataset.expectationChange)).toEqual(["add", "retire"]);
  expect(text(changes[0])).toContain("AddCalls: The card names the broker.");
  expect(text(changes[0])).toContain("it should name the broker on the card");
  // A retirement shows the line it retires, by its words, and why.
  expect(text(changes[1])).toContain("An intro goes out within a day.");
  expect(text(changes[1])).toContain("Because intros moved to the desk");
  expect(text(changes[1])).toContain("intros are the desk's now");
  expect(text(p)).toContain("Applied, it becomes version 4.");
  await click(p.querySelector("[data-expectation-apply='xp-7']"));
  await click(p.querySelector("[data-expectation-drop='xp-7']"));
  expect(calls).toEqual([["resolve", PID, "xp-7", "apply"], ["resolve", PID, "xp-7", "drop"]]);
  await done();
}, 30_000);

test("a person adds a line in their words, told first whether it applies now; retiring asks why", async () => {
  stubActions();
  const { host, done } = await mount();
  await click(host.querySelector("[data-expectation-add]"));
  const form = host.querySelector("[data-expectation-add-form]")!;
  await act(async () => { setValue(form.querySelector("[data-expectation-text]"), "Be nice."); });
  expect((form.querySelector("[data-expectation-add-hint]") as HTMLElement).dataset.expectationAddHint).toBe("waits");
  expect(text(form.querySelector("[data-expectation-add-submit]"))).toBe("Propose");
  await act(async () => { setValue(form.querySelector("[data-expectation-text]"), "Every callback names who asked for it."); });
  expect((form.querySelector("[data-expectation-add-hint]") as HTMLElement).dataset.expectationAddHint).toBe("applies");
  expect((form.querySelector("[data-expectation-part]") as HTMLInputElement).value).toBe("Calls");
  await submit(form);
  expect(calls).toEqual([["edit", PID, { op: "add", text: "Every callback names who asked for it.", part: "Calls" }]]);
  expect(host.querySelector("[data-expectation-add-form]")).toBeNull();

  await click(host.querySelector("[data-expectation-retire='ex-callers-call-3']"));
  const retire = host.querySelector("[data-expectation-retire-form]")!;
  expect(text(retire.querySelector("button[type='submit']"))).toBe("Propose retiring");
  await act(async () => { setValue(retire.querySelector("[data-expectation-reason]"), "Intros are the desk's now"); });
  await submit(retire);
  expect(calls[1]).toEqual(["edit", PID, { op: "retire", id: "ex-callers-call-3", reason: "Intros are the desk's now" }]);
  await done();
}, 30_000);

test("the real action paints the added line at once, before any server answers", async () => {
  const sent: unknown[][] = [];
  const owner = {};
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: unknown[]) => { sent.push([action, args]); return null; }, { owner });
  try {
    const { host, done } = await mount();
    await click(host.querySelector("[data-expectation-add]"));
    const form = host.querySelector("[data-expectation-add-form]")!;
    await act(async () => { setValue(form.querySelector("[data-expectation-text]"), "Every callback names who asked for it."); });
    await submit(form);
    const added = host.querySelector("[data-expectation='ex-callers-call-5']");
    expect(text(added)).toContain("Every callback names who asked for it.");
    expect(text(added?.querySelector("[data-citation='person']") ?? null)).toBe("Cam");
    expect(text(host.querySelector("[data-expectations-version]"))).toContain("version 4");
    expect(sent[0]?.[0]).toBe("editExpectations");
    await done();
  } finally {
    (useInboxStore.getState() as any)._clearDispatch(owner);
  }
}, 30_000);
