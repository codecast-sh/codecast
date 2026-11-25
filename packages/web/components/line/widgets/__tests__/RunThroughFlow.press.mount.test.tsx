import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
// The store's cache and the auth storage open IndexedDB at import; give them one so the run stays quiet.
import "fake-indexeddb/auto";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

// The session header's Ship (RunThroughFlow, ct-101498). A person presses Ship
// in the panel; the session has not echoed the press back yet (its daemon is
// slow, offline, or the message is still on its way). The chip must say the
// change is on its way at once, and the panel must not offer the same Ship
// again as if nothing happened: a person who sees "Ship" after pressing Ship
// presses it again, and again, and never learns why nothing went out.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const domClasses = Object.fromEntries(
  Object.getOwnPropertyNames(dom.window)
    .filter((k) => /^(HTML\w*Element|SVG\w*Element|\w*Event|Element|Node|NodeFilter|MutationObserver|DocumentFragment|Text|Range|Selection)$/.test(k))
    .map((k) => [k, (dom.window as any)[k]]),
);
const restoreGlobals = replaceGlobals({
  ...domClasses,
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  matchMedia: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
(dom.window as any).ResizeObserver = (globalThis as any).ResizeObserver;
(dom.window as any).matchMedia = (globalThis as any).matchMedia;

// No server: queries are loading, mutations exist. Keep every other export real.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useAction: () => async () => null, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../../hooks/useQueryNoThrow");
mock.module("../../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
// Flows are on; the session has never run a flow; the pool is the shipped one (Change, labelled Ship).
const features = await import("../../../../lib/teamFeatures");
mock.module("../../../../lib/teamFeatures", () => ({ ...features, useWorkspaceFeature: () => true }));
const syncWorkflows = await import("../../../../hooks/useSyncWorkflows");
mock.module("../../../../hooks/useSyncWorkflows", () => ({ ...syncWorkflows, useSessionFlowRuns: () => [], usePoolFlowRows: () => [], useTeamDefaultFlowSlug: () => null }));
const repoFlows = await import("../../../../hooks/useRepoFlows");
mock.module("../../../../hooks/useRepoFlows", () => ({ ...repoFlows, useRepoFlows: () => [] }));
const deployReach = await import("../../../../hooks/useDeployReach");
mock.module("../../../../hooks/useDeployReach", () => ({ ...deployReach, useDeployReach: () => undefined }));
const pressApproval = await import("../../../../hooks/usePressApproval");
mock.module("../../../../hooks/usePressApproval", () => ({ ...pressApproval, usePressApproval: () => ({ files: null, record: async () => true }) }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../../store/inboxStore");
const { RunThroughFlow } = await import("../RunThroughFlow");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const CONV = "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let sent: string[] = [];
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  sent = [];
  useInboxStore.setState({
    currentUser: { _id: "u1", name: "Ashot" },
    sessions: { [CONV]: { _id: CONV, title: "Fix the header", status: "running", updated_at: Date.now() } },
    messages: { [CONV]: [] },
  } as any);
  // The press goes out, and the server never echoes it into the thread within this test: the state a person is in
  // between pressing and the session picking the message up, which on a stalled session lasts forever.
  useInboxStore.setState({ sendMessage: ((_id: string, content: string) => { sent.push(content); }) as any } as any);
});

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
});

const click = async (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
const chip = () => container!.querySelector("[data-run-through]") as HTMLButtonElement;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(() => root!.render(<RunThroughFlow conversationId={CONV} sessionTitle="Fix the header" />));
}

test("pressing Ship sends one message and the chip says it is starting, before the session echoes it", async () => {
  await mount();
  expect(chip().getAttribute("aria-label")).toBe("Ship");
  await click(chip());
  const go = document.querySelector("[data-run-through-go]");
  expect(go).not.toBeNull();
  await click(go!);
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain("cast flow run change");
  // The miss: the chip still reads "Ship", so the press looks like it did nothing.
  expect(chip().getAttribute("aria-label")).toBe("Starting");
});

test("opening Ship again after a press does not offer the same Ship as if nothing was sent", async () => {
  await mount();
  await click(chip());
  await click(document.querySelector("[data-run-through-go]")!);
  await click(chip());
  // The miss: the panel is the untouched picker again, its Ship button one press from a duplicate send.
  expect(document.querySelector("[data-run-through-go]")).toBeNull();
  expect(document.querySelector("[data-ship-starting]")).not.toBeNull();
});

test("guard: once the press is in the thread, the chip says Starting and the panel shows it", async () => {
  useInboxStore.setState({ messages: { [CONV]: [{ _id: "m1", role: "user", timestamp: Date.now(), content: "Run your change through the Ship flow: `cast flow run change --title \"x\"`." }] } } as any);
  await mount();
  expect(chip().getAttribute("aria-label")).toBe("Starting");
  await click(chip());
  expect(document.querySelector("[data-ship-starting]")).not.toBeNull();
});
