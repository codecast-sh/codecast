// A sheet's Ask box and its Now block (cohesive build spec D6, D8), mounted
// over the org fixture: Ask sends into the seat's own thread through the
// store and shows the answer that lands after it; Message opens a person's
// DM with the line as its draft; a proposal that touches the object is one
// violet line that sends the reader to its card, with nothing to approve.
// Run: bun test components/org/company/sheets.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "HTMLSelectElement", "SVGElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "InputEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
const { act } = React;

// The thread's feeder, mounted after a send: it reports which thread it keeps in the store.
const fed: string[] = [];
mock.module("../../SessionPrewarm", () => ({ SessionPrewarm: ({ sessionId }: { sessionId: string }) => { fed.push(sessionId); return null; } }));
const chats: string[] = [];
const dm = { ...(await import("../../../hooks/useOpenDm")) };
mock.module("../../../hooks/useOpenDm", () => ({ ...dm, useOpenChatPath: () => (path: string) => chats.push(path) }));
const realAsks = { ...(await import("../useNeedsYou")) };
mock.module("../useNeedsYou", () => ({ ...realAsks, useOrgAsks: () => [] }));
mock.module("../../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { AskBox } = await import("./AskBox");
const { NowBlock } = await import("./NowBlock");
const { SheetHostContext } = await import("./sheetHost");
const { ORG_FIXTURE_WITH_HEAD } = await import("../orgFixture");
const { ORG_STAFFING_FIXTURE_PROPOSAL } = await import("../orgStaffingFixture");

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const GROWTH = ORG_FIXTURE_WITH_HEAD.roles.find((r) => r.handle === "growth")!;
const SEAT = { conversationId: "fixture-growth-conv", name: GROWTH.name, role: GROWTH, caption: "@growth" };

async function mountNode(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  return { el, render: (n: React.ReactNode) => act(async () => { root.render(n); }), unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}

/** Types into a React-controlled input the way a person does. */
async function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor((dom.window as any).HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, text); input.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true })); });
}

test("Ask sends the line into the seat's own thread and shows the answer that lands after it, read from the store", async () => {
  const sent: [string, string][] = [];
  const CONV = "fixture-growth-conv";
  const before = { _id: "m-old", role: "assistant", content: "An older word.", timestamp: 1 };
  useInboxStore.setState({ messages: {}, sendMessage: (conv: string, text: string) => { sent.push([conv, text]); } } as any);
  const screen = await mountNode(h(AskBox, { seat: SEAT }));
  expect(fed).toEqual([]);
  // Before any send nothing shows under the box: what the seat last said is the sheet's own Where it stands and Now.
  expect(q("[data-sheet-ask-reply]", screen.el)).toBeNull();
  const input = q("[data-sheet-ask-input]", screen.el) as HTMLInputElement;
  expect(input.getAttribute("placeholder")).toBe("Ask Head of Growth…");
  await type(input, "How is the review going?");
  await act(async () => { (input.form as HTMLFormElement).dispatchEvent(new (dom.window as any).Event("submit", { bubbles: true, cancelable: true })); });
  expect(sent).toEqual([["fixture-growth-conv", "How is the review going?"]]);
  expect(input.value).toBe("");
  // Sent, waiting: the thread's feeder is mounted, and an older word is not shown as the answer.
  expect(fed.at(-1)).toBe(CONV);
  await act(async () => { useInboxStore.setState({ messages: { [CONV]: [before] } } as any); });
  expect(q("[data-sheet-ask-reply]", screen.el)!.getAttribute("data-sheet-ask-reply")).toBe("waiting");
  // The answer lands in the store's copy of the thread.
  const t = Date.now() + 1;
  await act(async () => { useInboxStore.setState({ messages: { [CONV]: [before, { _id: "m-q", role: "user", content: "How is the review going?", timestamp: t }, { _id: "m-a", role: "assistant", content: "Halfway. The digest goes out at five.", timestamp: t + 1 }] } } as any); });
  expect(q("[data-sheet-ask-reply]", screen.el)!.getAttribute("data-sheet-ask-reply")).toBe("said");
  expect(q("[data-sheet-ask-reply]", screen.el)!.textContent).toContain("Halfway. The digest goes out at five.");
  await screen.unmount();
});

test("Message on a person opens their DM with the line waiting as its draft", async () => {
  const drafts: Record<string, any> = {};
  useInboxStore.setState({ openDmChannel: () => "chan-sam", setDraft: (k: string, f: any) => { drafts[k] = f; }, getDraft: (k: string) => drafts[k] } as any);
  const screen = await mountNode(h(AskBox, { person: { userId: "fixture-user-sam", name: "Samvit Jain" } }));
  const input = q("[data-sheet-ask-input]", screen.el) as HTMLInputElement;
  expect(input.getAttribute("placeholder")).toBe("Message Samvit Jain…");
  await type(input, "Can we talk lists?");
  await act(async () => { (input.form as HTMLFormElement).dispatchEvent(new (dom.window as any).Event("submit", { bubbles: true, cancelable: true })); });
  expect(drafts["chat:chan-sam"]).toMatchObject({ draft_message: "Can we talk lists?" });
  expect(chats).toEqual(["/chat/chan-sam"]);
  await screen.unmount();
});

test("Now: a role a proposal touches shows one violet line that sends the reader to its card, and no way to approve it here", async () => {
  const proposal = { ...ORG_STAFFING_FIXTURE_PROPOSAL, team_id: "fixture-team" };
  useInboxStore.setState({
    orgTree: ORG_FIXTURE_WITH_HEAD,
    orgProposals: { [proposal._id]: { ...proposal, changes: undefined } },
    orgProposalChanges: Object.fromEntries(proposal.changes.map((c) => [c._id, c])),
  } as any);
  const opened: string[] = [];
  const host = { under: null, underTitle: null, back() {}, close() {}, open() {}, talk() {}, talkable: true, leftConversationId: null, openProposal: (s: string, seq?: number) => opened.push(`${s}#${seq}`), focusTitle: false, titleSettled() {}, covers: false };
  const rows = { goals: [], projects: [], tree: ORG_FIXTURE_WITH_HEAD, members: [] };
  const screen = await mountNode(h(SheetHostContext.Provider, { value: host }, h(NowBlock, { subject: { keys: ["role:growth"], refs: ["or-1"], role: GROWTH }, sessions: GROWTH.sessions, rows })));
  const now = q("[data-sheet-now]", screen.el)!;
  expect(now).not.toBeNull();
  // The role's live sessions, in words.
  expect(q("[data-now-sessions]", now)!.textContent).toMatch(/at work/);
  const line = q("[data-now-proposal]", now)!;
  expect(line.textContent).toContain("Head of People proposes to have this role run Weekly growth review every week");
  expect(line.textContent).toContain("See it");
  expect(now.textContent).not.toMatch(/Approve|Reject/);
  await act(async () => { line.click(); });
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^op-7#\d+$/);
  // An object nothing touches and nothing moves on draws no Now at all.
  await screen.render(h(SheetHostContext.Provider, { value: host }, h(NowBlock, { subject: { keys: ["role:nobody"], refs: [] }, sessions: [], rows })));
  expect(q("[data-sheet-now]", screen.el)).toBeNull();
  await screen.unmount();
});

test("a person's sheet offers Copy link to its @handle address without printing the handle in the head", async () => {
  const { SheetFrame } = await import("./SheetFrame");
  const screen = await mountNode(h(SheetFrame, { kind: "person", idRef: null, linkRef: "samvit", glyph: null, title: "Samvit Jain", crumbs: [] }));
  expect(q("[data-sheet-id]", screen.el)).toBeNull();
  await act(async () => { q("[data-sheet-menu]", screen.el)!.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(q("[data-sheet-copy-link]")?.textContent).toBe("Copy link");
  await act(async () => { document.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await screen.unmount();
});
