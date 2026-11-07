// The perf benches' one harness: real web components mounted in jsdom over a
// synthetic cache, each workload exposed as setup / run / reset with the
// counts a run must hold exactly. Two callers load it:
//   - strobe (perf/*.bench.ts) in a fresh Bun process per block, timing
//     `run` as cpu.work and comparing the counts between base and head. In a
//     git ref's worktree strobe places this file at the same path, so its
//     imports reach that ref's code; that is why it stays one file and imports
//     only app code.
//   - bun test (perf/budgets.test.ts), which asserts each count's exact value.
// It runs under plain `bun` as well as `bun test`, so it cannot use
// mock.module or the test preload: everything it needs is a real module.
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

export type Workload = "switch" | "inbox" | "diff";
export type Counts = Record<string, number>;
export type Report = { counts: Counts; detail: Record<string, string[]> };

// --- DOM ------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/inbox", pretendToBeVisual: true });
const w = dom.window as any;

// jsdom lays nothing out. Give elements a fixed geometry (rows 50px, a feed
// 500px) so virtualized lists window themselves as in a browser, and count
// every read that would force a browser to lay out the page.
const ROW = 50;
const VIEWPORT = 800;
let layoutReads: string[] = [];
const readSite = (name: string) => `${name} ${new Error().stack!.split("\n").find((l) => l.includes("/packages/web/") && !l.includes("/perf/"))?.trim().replace(/^at /, "") ?? "?"}`;
const offsets = new WeakMap<Element, number>();
const heightOf = (el: Element) => ((el as HTMLElement).style?.height === "0px" ? 0 : el.hasAttribute("data-sv-feed") ? VIEWPORT : ROW);
const geometry = (name: string, value: (el: HTMLElement) => number) => ({ get(this: HTMLElement) { layoutReads.push(readSite(name)); return value(this); }, configurable: true });
Object.defineProperties(w.HTMLElement.prototype, {
  offsetHeight: geometry("offsetHeight", heightOf),
  offsetWidth: geometry("offsetWidth", () => 700),
  clientHeight: geometry("clientHeight", heightOf),
  clientWidth: geometry("clientWidth", () => 700),
  scrollHeight: geometry("scrollHeight", heightOf),
  scrollWidth: geometry("scrollWidth", () => 700),
  offsetTop: geometry("offsetTop", () => 0),
  offsetParent: { get: () => w.document.body, configurable: true },
  scrollTop: {
    get(this: Element) { return offsets.get(this) ?? 0; },
    set(this: Element, v: number) { offsets.set(this, Math.max(0, v)); },
    configurable: true,
  },
});
w.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  layoutReads.push(readSite("getBoundingClientRect"));
  const h = heightOf(this);
  return { x: 0, y: 0, top: 0, left: 0, right: 700, bottom: h, width: 700, height: h, toJSON() {} };
};
w.HTMLElement.prototype.scrollTo = function (this: HTMLElement, x: any, y?: number) { this.scrollTop = typeof x === "object" ? x.top ?? this.scrollTop : y ?? 0; };
w.HTMLElement.prototype.scrollIntoView = () => {};
w.HTMLCanvasElement.prototype.getContext = () => ({ font: "", measureText: (t: string) => ({ width: t.length * 7 }) });
const realComputedStyle = w.getComputedStyle.bind(w);
const getComputedStyle = (el: Element, pseudo?: string) => { layoutReads.push(readSite("getComputedStyle")); return realComputedStyle(el, pseudo); };
w.getComputedStyle = getComputedStyle;
class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
w.ResizeObserver = NoopObserver;
w.IntersectionObserver = NoopObserver;
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

for (const [key, value] of Object.entries({
  window: w, document: w.document, navigator: w.navigator, localStorage: w.localStorage, sessionStorage: w.sessionStorage,
  location: w.location, history: w.history, indexedDB, IDBKeyRange,
  HTMLElement: w.HTMLElement, HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLInputElement: w.HTMLInputElement, HTMLAnchorElement: w.HTMLAnchorElement,
  Element: w.Element, Node: w.Node, Text: w.Text, DocumentFragment: w.DocumentFragment, ShadowRoot: w.ShadowRoot, SVGElement: w.SVGElement,
  Event: w.Event, CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, WheelEvent: w.WheelEvent, FocusEvent: w.FocusEvent,
  MutationObserver: w.MutationObserver, DOMRect: w.DOMRect, DOMParser: w.DOMParser, customElements: w.customElements, getComputedStyle,
  ResizeObserver: NoopObserver, IntersectionObserver: NoopObserver, matchMedia: w.matchMedia,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0),
  cancelAnimationFrame: (id: any) => clearTimeout(id),
  requestIdleCallback: (cb: any) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0),
  cancelIdleCallback: (id: any) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
(URL as any).createObjectURL ??= () => "blob:perf";
(URL as any).revokeObjectURL ??= () => {};
// React's act() warns per update when this is missing; the noise is not the work.
const realError = console.error;
console.error = (...args: unknown[]) => { if (String(args[0]).includes("not wrapped in act")) return; realError(...args); };

// --- App modules (loaded after the DOM exists: react-dom decides at load) ----

const React = await import("react");
const { act, Profiler } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProviderWithAuth } = await import("convex/react");
const { getFunctionName } = await import("convex/server");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../store/inboxStore");

// --- A Convex client that answers nothing and counts everything asked -------

let convexAsked: { subscribe: string[]; query: string[]; mutation: string[]; action: string[] } = { subscribe: [], query: [], mutation: [], action: [] };
const nameOf = (q: any) => { try { return getFunctionName(q); } catch { return String(q); } };
const convex = {
  clearAuth() {}, setAuth() {},
  watchQuery(q: any) {
    convexAsked.subscribe.push(nameOf(q));
    return { onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined };
  },
  query: (q: any) => { convexAsked.query.push(nameOf(q)); return new Promise(() => {}); },
  mutation: (q: any) => { convexAsked.mutation.push(nameOf(q)); return Promise.resolve(null); },
  action: (q: any) => { convexAsked.action.push(nameOf(q)); return Promise.resolve(null); },
  connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false, hasEverConnected: true, connectionCount: 1 }),
  subscribeToConnectionState: () => () => {},
  prewarmQuery() {},
} as any;
const useAuth = () => ({ isLoading: false, isAuthenticated: true, fetchAccessToken: async () => "perf" });

// --- Synthetic cache --------------------------------------------------------

const ME = "user_perf";
const now = Date.UTC(2026, 10, 7, 12);
export const convId = (i: number) => `jx7${String(i).padStart(29, "0")}`;

function sessionRows(n: number): Record<string, any> {
  const out: Record<string, any> = {};
  for (let i = 0; i < n; i++) {
    const id = convId(i);
    out[id] = {
      _id: id, session_id: `s-${i}`, title: `Session ${i}: ${["fix the sync race", "ship the inbox", "profile typing", "review the diff"][i % 4]}`,
      user_id: i % 7 ? ME : "user_teammate", agent_type: i % 13 ? "claude_code" : "codex",
      status: i % 9 ? "completed" : "active", is_idle: i % 9 !== 0, agent_status: i % 9 ? "idle" : "working",
      message_count: 200 + (i % 50), updated_at: now - i * 60_000, started_at: now - i * 120_000, last_heartbeat: now,
      project_path: `/src/p${i % 40}`, git_branch: "main",
    };
  }
  return out;
}

// One exchange: a prompt, then an answer of markdown with a list and a code
// fence, the shape most transcript rows have.
function messages(conv: string, n: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const user = i % 2 === 0;
    out.push({
      _id: `${conv.slice(0, 20)}m${String(i).padStart(11, "0")}`, conversation_id: conv, role: user ? "user" : "assistant",
      timestamp: now - (n - i) * 30_000,
      content: user
        ? `Prompt ${i}: look at the sync layer and tell me why the inbox jumps when a session finishes.`
        : `## Answer ${i}\n\nThe jump comes from **two writes** in one frame:\n\n- the placement clock\n- the liveness hold\n\n\`\`\`ts\nexport function settle(rows: Row[]) {\n  return rows.filter((r) => r.idle).map((r) => r.id);\n}\n\`\`\`\n\nLast line of answer ${i} in ${conv.slice(-6)}.`,
    });
  }
  return out;
}

function seedStore(sessions: number) {
  const st = useInboxStore.getState() as any;
  st._setDispatch?.(async () => undefined);
  useInboxStore.setState({
    sessions: sessionRows(sessions), conversations: {}, pendingMessages: {}, drafts: {},
    currentUser: { _id: ME, name: "Perf" }, clientStateInitialized: true,
  } as any);
}

// --- Mounting and measuring ------------------------------------------------

let commits = 0;
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let render: (node: React.ReactNode) => Promise<void>;

function mount() {
  host = w.document.createElement("div");
  w.document.body.appendChild(host);
  root = createRoot(host);
  render = async (node) => {
    await act(async () => {
      root.render(
        <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
          <MemoryRouter>
            <Profiler id="perf" onRender={() => { commits++; }}>{node}</Profiler>
          </MemoryRouter>
        </ConvexProviderWithAuth>,
      );
    });
  };
}

const tick = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

// Wait until nothing commits for a while: lazy pieces resolving, effects
// settling. A run measures what its action caused, not the tail of the last.
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
    if (Date.now() > deadline) throw new Error(`perf harness: timed out waiting for ${what}; on screen: ${host?.textContent?.slice(0, 400)}`);
    await tick(10);
  }
}

// Everything one action caused: React commits, store writes, Convex asks, DOM
// mutations and forced layouts.
async function measure(action: () => Promise<void>): Promise<Report> {
  commits = 0;
  layoutReads = [];
  convexAsked = { subscribe: [], query: [], mutation: [], action: [] };
  let storeWrites = 0;
  const unsub = useInboxStore.subscribe(() => { storeWrites++; });
  let mutations = 0;
  const mo = new w.MutationObserver((records: MutationRecord[]) => { mutations += records.length; });
  mo.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  await action();
  mutations += mo.takeRecords().length;
  mo.disconnect();
  unsub();
  const reads = layoutReads;
  return {
    counts: {
      commits, storeWrites, domMutations: mutations, layoutReads: reads.length,
      convexSubscribes: convexAsked.subscribe.length, convexQueries: convexAsked.query.length,
      convexMutations: convexAsked.mutation.length, convexActions: convexAsked.action.length,
    },
    detail: { layoutReads: [...new Set(reads)], ...convexAsked },
  };
}

// --- Workloads ---------------------------------------------------------------

type Bench = { run: () => Promise<Report>; reset: () => Promise<void> };
let bench: Bench | null = null;

// Warm conversation switch: two conversations, each with a full window of 200
// messages already in the store and visited once, over a cache of 2,000
// sessions. A run switches from one to the other until the destination's last
// answer is on screen.
async function setupSwitch(): Promise<Bench> {
  const { InboxConversation } = await import("../app/inbox/QueuePageClient");
  seedStore(2000);
  const [a, b] = [convId(1), convId(2)];
  for (const id of [a, b]) useInboxStore.getState().setMessages(id, messages(id, 200), { hasMoreAbove: true, initialized: true });
  mount();
  let current = a;
  const show = async (id: string) => {
    current = id;
    await render(<InboxConversation sessionId={id} isIdle autoFocusInput={false} />);
    await until(() => host.textContent!.includes(`Last line of answer 199 in ${id.slice(-6)}`), `conversation ${id} to paint`);
  };
  await show(a);
  await settle();
  await show(b);
  await settle();
  await show(a);
  await settle();
  return {
    run: () => measure(async () => { await show(current === a ? b : a); await settle(); }),
    reset: async () => { await settle(); },
  };
}

const setups: Record<Workload, () => Promise<Bench>> = {
  switch: setupSwitch,
  inbox: () => { throw new Error("todo"); },
  diff: () => { throw new Error("todo"); },
};

/** Builds the workload's world once per process; later calls are no-ops. */
export async function setup(workload: Workload): Promise<void> {
  bench ??= await setups[workload]();
}

/** One measured action; strobe times this call. */
export async function run(): Promise<Report> {
  if (!bench) throw new Error("perf harness: call setup(workload) first");
  return bench.run();
}

/** Puts the world back for the next run, untimed. */
export async function reset(): Promise<void> {
  await bench?.reset();
}
