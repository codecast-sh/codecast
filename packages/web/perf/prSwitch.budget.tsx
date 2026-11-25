// Opening a conversation from a pull request's page must draw none of its
// transcript inside the click, as a click between two conversations does
// (ct-101487: every move between the PR page and a conversation froze the page
// 0.45 to 1.2 s inside the root click handler).
//
//   bun perf/prSwitch.budget.tsx      (from packages/web; exits 1 on a miss)
//
// The real tab shell (TabContent: the tab's pane, the stage, the route pane)
// under the nesting context DashboardLayout gives it, over a cache of 2,000
// sessions. The click is the one the rail makes: a button beside the shell
// calling useOpenSession. On the PR page that leaves for the inbox carrying
// the session (tabNavigate rewrites the tab's path); on the inbox it switches
// in place. Both conversations hold a full window of 200 messages and were
// opened once before anything is measured.
//
// What a click costs the person is what runs before the browser can paint: the
// handler and the microtasks after it, where React flushes the sync-lane work
// the click scheduled. A switch between conversations leaves the old one
// painted and mounts the next at transition priority (useBoundedDeferredValue
// in InboxConversation), so none of the next transcript is drawn inside the
// click. `syncRows` counts the destination's rows on screen when the click's
// task ends, from the PR page and between conversations.
//
// It stands alone, rather than as a workload of perf/harness.tsx, so the check
// runs unchanged on a tree from before the fix. Plain bun, never `bun test`:
// the test preload stands in for modules this mounts for real.
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { deepStrictEqual } from "node:assert/strict";

// --- DOM: jsdom with a fixed geometry, so virtualized lists window ---------

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/inbox", pretendToBeVisual: true });
const w = dom.window as any;
const ROW = 50;
const VIEWPORT = 800;
const offsets = new WeakMap<Element, number>();
const isViewport = (el: Element) => el.hasAttribute("data-sv-feed") || el.hasAttribute("data-perf-viewport");
const heightOf = (el: Element) => ((el as HTMLElement).style?.height === "0px" ? 0 : isViewport(el) ? VIEWPORT : ROW);
const scrollHeightOf = (el: Element) => el.hasAttribute("data-sv-feed") ? Math.max(VIEWPORT, Number.parseFloat(el.querySelector<HTMLElement>('div[style*="position: relative"][style*="height"]')?.style.height || "0")) : heightOf(el);
const geometry = (value: (el: HTMLElement) => number) => ({ get(this: HTMLElement) { return value(this); }, configurable: true });
Object.defineProperties(w.HTMLElement.prototype, {
  offsetHeight: geometry(heightOf), offsetWidth: geometry(() => 700),
  clientHeight: geometry(heightOf), clientWidth: geometry(() => 700),
  scrollHeight: geometry(scrollHeightOf), scrollWidth: geometry(() => 700),
  offsetTop: geometry(() => 0),
  offsetParent: { get: () => w.document.body, configurable: true },
  scrollTop: {
    get(this: Element) { return offsets.get(this) ?? 0; },
    set(this: HTMLElement, v: number) {
      const next = Math.max(0, Math.min(v, Math.max(0, scrollHeightOf(this) - heightOf(this))));
      if (next === (offsets.get(this) ?? 0)) return;
      offsets.set(this, next);
      queueMicrotask(() => { if (this.isConnected) this.dispatchEvent(new w.Event("scroll")); });
    },
    configurable: true,
  },
});
w.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const h = heightOf(this);
  return { x: 0, y: 0, top: 0, left: 0, right: 700, bottom: h, width: 700, height: h, toJSON() {} };
};
w.HTMLElement.prototype.scrollTo = function (this: HTMLElement, x: any, y?: number) { this.scrollTop = typeof x === "object" ? x.top ?? this.scrollTop : y ?? 0; };
w.HTMLElement.prototype.scrollIntoView = () => {};
w.HTMLCanvasElement.prototype.getContext = () => ({ font: "", measureText: (t: string) => ({ width: t.length * 7 }) });
class CSSStyleSheet { cssRules: unknown[] = []; replaceSync(_text: string) {} replace(_text: string) { return Promise.resolve(this); } insertRule() { return 0; } deleteRule() {} }
for (const proto of [w.ShadowRoot.prototype, w.Document.prototype]) {
  if (!("adoptedStyleSheets" in proto)) Object.defineProperty(proto, "adoptedStyleSheets", { get() { return this.__adopted ?? []; }, set(v) { this.__adopted = v; }, configurable: true });
}
class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
class SizeObserver {
  targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) {}
  observe(el: Element) {
    this.targets.add(el);
    queueMicrotask(() => {
      if (this.targets.has(el) && el.isConnected) this.callback([{ target: el, contentRect: { height: heightOf(el), width: 700 }, contentBoxSize: [{ blockSize: heightOf(el), inlineSize: 700 }], borderBoxSize: [{ blockSize: heightOf(el), inlineSize: 700 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    });
  }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}
w.ResizeObserver = SizeObserver;
w.IntersectionObserver = NoopObserver;
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
for (const [key, value] of Object.entries({
  window: w, document: w.document, navigator: w.navigator, localStorage: w.localStorage, sessionStorage: w.sessionStorage,
  location: w.location, history: w.history, indexedDB, IDBKeyRange,
  HTMLElement: w.HTMLElement, HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLInputElement: w.HTMLInputElement, HTMLAnchorElement: w.HTMLAnchorElement,
  Element: w.Element, Node: w.Node, Text: w.Text, Document: w.Document, DocumentFragment: w.DocumentFragment, ShadowRoot: w.ShadowRoot, SVGElement: w.SVGElement,
  Event: w.Event, CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, WheelEvent: w.WheelEvent, FocusEvent: w.FocusEvent,
  MutationObserver: w.MutationObserver, CSSStyleSheet, DOMRect: w.DOMRect, DOMParser: w.DOMParser, customElements: w.customElements, getComputedStyle: w.getComputedStyle.bind(w),
  ResizeObserver: SizeObserver, IntersectionObserver: NoopObserver, matchMedia: w.matchMedia,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0),
  cancelAnimationFrame: (id: any) => clearTimeout(id),
  requestIdleCallback: (cb: any) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0),
  cancelIdleCallback: (id: any) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
(URL as any).createObjectURL ??= () => "blob:perf";
(URL as any).revokeObjectURL ??= () => {};
const realError = console.error;
console.error = (...args: unknown[]) => { if (String(args[0]).includes("not wrapped in act")) return; realError(...args); };
if (process.env.REACT_COMPILER === "1") await import("../test-helpers/reactCompiler").catch(() => {});

// --- App modules (after the DOM exists: react-dom decides at load) ----------

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProviderWithAuth } = await import("convex/react");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../store/inboxStore");

// A Convex client that answers nothing: everything here comes from the cache.
const convex = {
  clearAuth() {}, setAuth() {},
  watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined }),
  query: () => new Promise(() => {}),
  mutation: () => Promise.resolve(null),
  action: () => Promise.resolve(null),
  connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false, hasEverConnected: true, connectionCount: 1 }),
  subscribeToConnectionState: () => () => {},
  prewarmQuery() {},
} as any;
const useAuth = () => ({ isLoading: false, isAuthenticated: true, fetchAccessToken: async () => "perf" });

// --- Synthetic cache ---------------------------------------------------------

const ME = "user_perf";
const now = Date.UTC(2026, 10, 7, 12);
const convId = (i: number) => `jx7${String(i).padStart(29, "0")}`;
function seedStore(n: number) {
  (useInboxStore.getState() as any)._setDispatch?.(async () => undefined);
  useInboxStore.setState({ sessions: {}, conversations: {}, pendingMessages: {}, drafts: {}, currentUser: { _id: ME, name: "Perf" }, clientStateInitialized: true } as any);
  const rows = Array.from({ length: n }, (_, i) => ({
    _id: convId(i), session_id: `s-${i}`, title: `Session ${i}`, user_id: ME, agent_type: "claude_code",
    status: "completed", is_idle: true, agent_status: "idle", message_count: 200, updated_at: now - i * 60_000,
    started_at: now - i * 120_000, last_heartbeat: now, project_path: `/src/p${i % 40}`, git_branch: "main",
  }));
  useInboxStore.getState().syncTable("sessions", rows as any);
}
function messages(conv: string, n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: `${conv.slice(0, 20)}m${String(i).padStart(11, "0")}`, conversation_id: conv, role: i % 2 === 0 ? "user" : "assistant",
    timestamp: now - (n - i) * 30_000,
    content: i % 2 === 0
      ? `Prompt ${i}: look at the sync layer and tell me why the inbox jumps when a session finishes.`
      : `## Answer ${i}\n\nThe jump comes from **two writes** in one frame:\n\n- the placement clock\n- the liveness hold\n\n\`\`\`ts\nexport function settle(rows: Row[]) {\n  return rows.filter((r) => r.idle).map((r) => r.id);\n}\n\`\`\`\n\nLast line of answer ${i} in ${conv.slice(-6)}.`,
  }));
}

// --- Mounting ------------------------------------------------------------------

let commits = 0;
const host: HTMLElement = w.document.createElement("div");
w.document.body.appendChild(host);
const root = createRoot(host);
const tick = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function settle(quietMs = 150, maxMs = 10_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const before = commits;
    await tick(quietMs);
    if (commits === before) return;
  }
}
async function until(check: () => boolean, what: string, maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; on screen: ${host.textContent?.slice(0, 400)}`);
    await tick(10);
  }
}

// --- The workload ----------------------------------------------------------------

const PR_PATH = "/pr/codecast-sh/codecast/186";
const { TabContent } = await import("../components/TabContent");
const { useOpenSession } = await import("../hooks/useOpenSession");
const { AUTH_JWT_STORAGE_KEY } = await import("../lib/localAuth");
await import("../components/DashboardLayout");
const Nest = (globalThis as any).__DashboardNestCtx as React.Context<boolean>;
// The pages sit behind AuthGuard, which draws for a device holding a token.
w.localStorage.setItem(AUTH_JWT_STORAGE_KEY, "perf");
seedStore(2000);
const [a, b] = [convId(1), convId(2)];
for (const id of [a, b]) useInboxStore.getState().setMessages(id, messages(id, 200), { hasMoreAbove: true, initialized: true });
const tab = { id: "tab-perf", path: PR_PATH, title: "Pull request" } as any;
useInboxStore.setState({ tabs: [tab], activeTabId: tab.id } as any);
w.history.replaceState(null, "", PR_PATH);

function Opener() {
  const open = useOpenSession();
  return <>{[a, b].map((id) => <button key={id} data-perf-open={id} onClick={() => open(id)} />)}</>;
}
const rowsOf = (id: string) => host.textContent!.split(`in ${id.slice(-6)}.`).length - 1;
const painted = (id: string) => host.textContent!.includes(`Last line of answer 199 in ${id.slice(-6)}`);
// The click and what runs before the browser could paint: the handler, then
// the microtasks React flushes sync work in. No macrotask runs, so transition
// work the click scheduled has not started.
const clickMs: string[] = [];
async function click(id: string) {
  const t0 = performance.now();
  host.querySelector(`[data-perf-open="${id}"]`)!.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  clickMs.push((performance.now() - t0).toFixed(0));
  return rowsOf(id);
}
const land = async (id: string) => { await until(() => painted(id), `conversation ${id} to paint`); await settle(); };
// Back to the pull request: what the tab does on Back.
async function toPr() {
  await act(async () => { useInboxStore.getState().updateTab(tab.id, { path: PR_PATH }); w.history.pushState({ tabNav: true, tabId: tab.id }, "", PR_PATH); });
  await until(() => !painted(a) && !painted(b), "the pull request page to show");
  await settle();
}

await act(async () => {
  root.render(
    <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
      <MemoryRouter initialEntries={[PR_PATH]}>
        <React.Profiler id="perf" onRender={() => { commits++; }}>
          <Nest.Provider value={true}><Opener /><TabContent /></Nest.Provider>
        </React.Profiler>
      </MemoryRouter>
    </ConvexProviderWithAuth>,
  );
});
await settle();
// Both conversations opened once, then back on the PR page.
await click(a); await land(a);
await click(b); await land(b);
await toPr();

let failed = false;
for (let round = 0; round < 2; round++) {
  clickMs.length = 0;
  const syncRows = await click(a);
  await land(a);
  const syncRowsBetweenConversations = await click(b);
  await land(b);
  console.log(`      click task ms (from the PR page, between conversations): ${clickMs.join(", ")}`);
  try {
    // The destination's rows on screen when the click's task ends. Arriving
    // from the PR page must cost the click no more than a switch does.
    deepStrictEqual({ syncRows, syncRowsBetweenConversations }, { syncRows: 0, syncRowsBetweenConversations: 0 });
  } catch (err) {
    failed = true;
    console.log(`FAIL  round ${round + 1}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await toPr();
}
console.log(failed
  ? "FAIL  opening a conversation from a pull request's page draws its transcript inside the click"
  : "pass  opening a conversation from a pull request's page draws none of its transcript inside the click, as a click between conversations does");
root.unmount();
process.exit(failed ? 1 : 0);
