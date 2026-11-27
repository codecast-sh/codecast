import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";

// A compose link (a milestone's Start, or any ?compose= link) opens a
// composer holding the link's text. That text is the link's, not the
// person's: closing the composer untouched, or discarding it, leaves no draft
// and no stub, however many times React mounts and unmounts the composer on
// the way in (StrictMode does it once on every open in a dev browser); a
// composer the person typed into keeps exactly one draft.

mock.module("sonner", () => ({
  toast: Object.assign(() => 1, { error: () => 1, info: () => 1, success: () => 1, warning: () => 1, dismiss: () => {}, loading: () => 1, custom: () => 1, promise: (p: any) => p }),
  Toaster: () => null,
}));
mock.module("next/navigation", () => ({
  useRouter: () => {
    const navigate = useNavigate();
    return React.useMemo(() => ({ replace: (url: string) => navigate(url, { replace: true }), push: (url: string) => navigate(url), prefetch: () => {}, back: () => {} }), [navigate]);
  },
  useSearchParams: () => new URLSearchParams(useLocation().search),
  usePathname: () => useLocation().pathname,
}));
const realConvex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...realConvex, useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }) }));

const { ConvexProvider } = await import("convex/react");
const { useInboxStore } = await import("../../store/inboxStore");
const { useComposeLink } = await import("../../hooks/useComposeLink");
const { closeDomWindow } = await import("../../test-helpers/domGlobals");
const { offlineConvexClient } = await import("../../test-helpers/offlineConvex");
const { loadComposeView } = await import("../../lib/composeViewLoader");
const { ComposeHost } = await import("../ComposeHost");
await loadComposeView();

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const BRIEF = "pri-57, milestone: Deploy drops the eval job\nPlan: pl-1075";
const LINKS = {
  start: `/inbox?compose=${encodeURIComponent(BRIEF)}&priority=pri-57&step=s2&plan=pl-1075`,
  plain: `/inbox?compose=${encodeURIComponent("About in-22 Infrastructure: ")}`,
};

const flush = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

function fakeConvex() {
  const client = offlineConvexClient("https://happy-otter-123.convex.cloud");
  (client as any).sync?.webSocketManager?.terminate?.();
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"));
  (el as any)[propsKey!]?.onChange?.({ target: el, currentTarget: el, nativeEvent: new w.Event("input") });
}

function LinkProbe() {
  useComposeLink(true);
  return null;
}

let root: Root;
let container: HTMLElement;
let mounts = 0;

beforeEach(() => {
  useInboxStore.setState({
    currentUser: { _id: "user_link_test", name: "Tester" } as any,
    drafts: {}, sessions: {}, conversations: {}, composes: [], clientState: { ...useInboxStore.getState().clientState, drafts: {} },
    clientStateInitialized: true,
    machineRosterLive: true,
    machineRoster: [{ device_id: "d1", local_project_roots: ["/Users/me/code/app"] }] as any,
    recentProjects: [{ path: "/Users/me/code/app", count: 3, lastActive: 1 }],
  } as any);
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
});

/** Open the link on the inbox under StrictMode: the composer mounts, unmounts and mounts again. */
async function openLink(url: string): Promise<HTMLTextAreaElement> {
  container = w.document.createElement("div");
  w.document.body.appendChild(container);
  root = createRoot(container);
  await act(() => root.render(
    <StrictMode>
      <ConvexProvider client={fakeConvex()}>
        <MemoryRouter key={++mounts} initialEntries={[url]}>
          <Routes><Route path="/inbox" element={<><LinkProbe /><ComposeHost /></>} /></Routes>
        </MemoryRouter>
      </ConvexProvider>
    </StrictMode>,
  ));
  await flush(80);
  expect((useInboxStore.getState() as any).composes).toHaveLength(1);
  return container.querySelector("textarea") as HTMLTextAreaElement;
}

async function leave() {
  await act(() => root.unmount());
  container.remove();
  // Every debounce and delayed recheck the composer can leave behind.
  await flush(1_000);
}

const escape = () => act(() => { w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

/** What the composer left in the store: drafts with text, and every session row (a stub, kept or not). */
function leftovers() {
  const s = useInboxStore.getState() as any;
  const texts = (o: Record<string, any> | undefined) => Object.entries(o ?? {}).filter(([, d]) => typeof d?.draft_message === "string" && d.draft_message.trim()).map(([id, d]) => [id, d.draft_message]);
  return { drafts: texts(s.drafts), clientDrafts: texts(s.clientState?.drafts), sessions: Object.values(s.sessions as Record<string, any>).map((r) => ({ id: r._id, kept: !!r._hasDraft })) };
}

for (const [kind, url] of Object.entries(LINKS)) {
  test(`${kind} link: closing the composer untouched leaves no draft and no stub`, async () => {
    const textarea = await openLink(url);
    expect(textarea.value.length).toBeGreaterThan(0);
    await escape();
    await flush(50);
    // Nothing was typed, so the close asks nothing.
    expect(!!container.ownerDocument.querySelector("[role=alertdialog]")).toBe(false);
    expect((useInboxStore.getState() as any).composes).toEqual([]);
    await leave();
    expect(leftovers()).toEqual({ drafts: [], clientDrafts: [], sessions: [] });
  }, 60_000);

  test(`${kind} link: a reload over the untouched composer writes no synced draft`, async () => {
    const textarea = await openLink(url);
    const stubId = (useInboxStore.getState() as any).composes[0].stubId as string;
    // The page goes away with the composer open: every pending draft write flushes (lib/pendingDraftWrites), nothing unmounts.
    await act(() => { w.dispatchEvent(new w.Event("pagehide")); });
    await flush(500);
    expect(textarea.value.length).toBeGreaterThan(0);
    expect((useInboxStore.getState() as any).clientState?.drafts?.[stubId] ?? null).toBeNull();
    // Once the person edits, the draft is theirs and syncs.
    await act(() => { typeInto(textarea, `${textarea.value}\nAnd the docs.`); });
    await act(() => { w.dispatchEvent(new w.Event("pagehide")); });
    await flush(50);
    expect((useInboxStore.getState() as any).clientState?.drafts?.[stubId]?.draft_message).toContain("And the docs.");
    await leave();
  }, 60_000);

  test(`${kind} link: editing and then discarding leaves no draft and no stub`, async () => {
    const textarea = await openLink(url);
    await act(() => { typeInto(textarea, `${textarea.value}\nAnd the docs.`); });
    await flush(10);
    await escape();
    await flush(20);
    const discard = [...container.ownerDocument.querySelectorAll("[role=alertdialog] button")].find((b) => b.textContent?.includes("Discard")) as HTMLButtonElement;
    expect(discard).toBeTruthy();
    await act(() => { discard.click(); });
    await flush(50);
    await leave();
    expect(leftovers()).toEqual({ drafts: [], clientDrafts: [], sessions: [] });
  }, 60_000);

  test(`${kind} link: editing and then closing keeps exactly the one draft typed`, async () => {
    const textarea = await openLink(url);
    const typed = `${textarea.value}\nAnd the docs.`;
    await act(() => { typeInto(textarea, typed); });
    await flush(10);
    // The host closes it without the confirm (another composer took the modal, the page went away).
    await act(() => { useInboxStore.getState().closeCompose(); });
    await flush(50);
    await leave();
    const left = leftovers();
    expect(left.sessions).toHaveLength(1);
    expect(left.sessions[0].kept).toBe(true);
    expect(left.drafts).toEqual([[left.sessions[0].id, typed.trim()]]);
  }, 60_000);
}
