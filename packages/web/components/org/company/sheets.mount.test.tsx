// A sheet's Now block (cohesive build spec D8) and its frame, mounted over the
// org fixture: a proposal that touches the object is one violet line, with
// nothing to approve.
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

const realAsks = { ...(await import("../useNeedsYou")) };
mock.module("../useNeedsYou", () => ({ ...realAsks, useOrgAsks: () => [] }));
mock.module("../../../hooks/useOpenLinkedSession", () => ({ useOpenLinkedSession: () => () => {} }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { NowBlock } = await import("./NowBlock");
const { ORG_FIXTURE_WITH_HEAD } = await import("../orgFixture");
const { ORG_STAFFING_FIXTURE_PROPOSAL } = await import("../orgStaffingFixture");

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const GROWTH = ORG_FIXTURE_WITH_HEAD.roles.find((r) => r.handle === "growth")!;

async function mountNode(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  return { el, render: (n: React.ReactNode) => act(async () => { root.render(n); }), unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}

test("Now: a role a proposal touches shows one violet line, and no way to approve it here", async () => {
  const proposal = { ...ORG_STAFFING_FIXTURE_PROPOSAL, team_id: "fixture-team" };
  useInboxStore.setState({
    orgTree: ORG_FIXTURE_WITH_HEAD,
    orgProposals: { [proposal._id]: { ...proposal, changes: undefined } },
    orgProposalChanges: Object.fromEntries(proposal.changes.map((c) => [c._id, c])),
  } as any);
  const rows = { goals: [], projects: [], tree: ORG_FIXTURE_WITH_HEAD, members: [] };
  const screen = await mountNode(h(NowBlock, { subject: { keys: ["role:growth"], refs: ["or-1"], role: GROWTH }, sessions: GROWTH.sessions, rows }));
  const now = q("[data-sheet-now]", screen.el)!;
  expect(now).not.toBeNull();
  // The role's live sessions, in words.
  expect(q("[data-now-sessions]", now)!.textContent).toMatch(/at work/);
  const line = q("[data-now-proposal]", now)!;
  expect(line.textContent).toContain("Head of People proposes to have this role run Weekly growth review every week");
  expect(line.textContent).toContain("See it");
  expect(now.textContent).not.toMatch(/Approve|Reject/);
  expect(line.getAttribute("data-now-proposal")).toMatch(/^op-7#\d+$/);
  // An object nothing touches and nothing moves on draws no Now at all.
  await screen.render(h(NowBlock, { subject: { keys: ["role:nobody"], refs: [] }, sessions: [], rows }));
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
