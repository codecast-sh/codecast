// The perf benches' one harness: real web components mounted in jsdom over a
// synthetic cache, each workload exposed as setup / run / reset with the
// counts a run must hold exactly. Two callers load it, both under plain bun:
//   - strobe (perf/web.bench.ts) in a fresh Bun process per block, timing
//     `run` as cpu.work and comparing the counts between base and head. In a
//     git ref's worktree strobe places this file at the same path, so its
//     imports reach that ref's code; that is why it stays one file and imports
//     only app code.
//   - perf/budgets.ts, which asserts each count's exact value.
// Never under `bun test`: the test preload stands in for the diff viewer, and
// mock.module is a no-op outside it, so everything here is a real module.
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

export type Workload = "switch" | "inbox-load" | "inbox-heartbeat" | "diff";
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
// A virtualized feed is as tall as its spacer says.
const scrollHeightOf = (el: Element) => el.hasAttribute("data-sv-feed") ? Math.max(VIEWPORT, Number.parseFloat(el.querySelector<HTMLElement>('div[style*="position: relative"][style*="height"]')?.style.height || "0")) : heightOf(el);
const geometry = (name: string, value: (el: HTMLElement) => number) => ({ get(this: HTMLElement) { layoutReads.push(readSite(name)); return value(this); }, configurable: true });
Object.defineProperties(w.HTMLElement.prototype, {
  offsetHeight: geometry("offsetHeight", heightOf),
  offsetWidth: geometry("offsetWidth", () => 700),
  clientHeight: geometry("clientHeight", heightOf),
  clientWidth: geometry("clientWidth", () => 700),
  scrollHeight: geometry("scrollHeight", scrollHeightOf),
  scrollWidth: geometry("scrollWidth", () => 700),
  offsetTop: geometry("offsetTop", () => 0),
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
// Constructable stylesheets (the diff viewer styles its shadow root with
// them); jsdom has neither the class nor adoptedStyleSheets.
class CSSStyleSheet { cssRules: unknown[] = []; replaceSync(_text: string) {} replace(_text: string) { return Promise.resolve(this); } insertRule() { return 0; } deleteRule() {} }
for (const proto of [w.ShadowRoot.prototype, w.Document.prototype]) {
  if (!("adoptedStyleSheets" in proto)) Object.defineProperty(proto, "adoptedStyleSheets", { get() { return this.__adopted ?? []; }, set(v) { this.__adopted = v; }, configurable: true });
}
class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
// Reports each observed element's fixed size once, as a browser does on observe.
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
  Element: w.Element, Node: w.Node, Text: w.Text, DocumentFragment: w.DocumentFragment, ShadowRoot: w.ShadowRoot, SVGElement: w.SVGElement,
  Event: w.Event, CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, WheelEvent: w.WheelEvent, FocusEvent: w.FocusEvent,
  MutationObserver: w.MutationObserver, CSSStyleSheet, DOMRect: w.DOMRect, DOMParser: w.DOMParser, customElements: w.customElements, getComputedStyle,
  ResizeObserver: SizeObserver, IntersectionObserver: NoopObserver, matchMedia: w.matchMedia,
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

// Which components rendered in each commit, through the hook React DevTools
// attaches by (read by react-dom when it loads): a fiber that did work in a
// commit carries the PerformedWork flag (1).
let rendered = new Map<string, number>();
const fiberName = (f: any) => { const t = f.elementType ?? f.type; return typeof t === "string" ? null : t?.displayName || t?.name || t?.type?.displayName || t?.type?.name || null; };
(globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
  onCommitFiberRoot(_id: number, fiberRoot: any) {
    const stack = [fiberRoot.current];
    while (stack.length) {
      const f = stack.pop();
      if (f.alternate && f.flags & 1) { const name = fiberName(f); if (name) rendered.set(name, (rendered.get(name) ?? 0) + 1); }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
  },
};

// --- App modules (loaded after the DOM exists: react-dom decides at load) ----

const React = await import("react");
const { act, Profiler } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProviderWithAuth } = await import("convex/react");
const { getFunctionName } = await import("convex/server");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../store/inboxStore");

// --- A Convex client that answers nothing and counts everything asked -------

// Subscriptions are counted the way the real client sends them: one per
// distinct query and arguments, opened when the first listener attaches and
// closed when the last leaves. A component remount that re-attaches to a query
// already open asks the server for nothing.
let convexAsked: { subscribe: string[]; query: string[]; mutation: string[]; action: string[] } = { subscribe: [], query: [], mutation: [], action: [] };
const openQueries = new Map<string, number>();
const nameOf = (q: any) => { try { return getFunctionName(q); } catch { return String(q); } };
const convex = {
  clearAuth() {}, setAuth() {},
  watchQuery(q: any, args?: unknown) {
    const name = nameOf(q);
    const key = `${name} ${JSON.stringify(args ?? {})}`;
    return {
      onUpdate: () => {
        const n = openQueries.get(key) ?? 0;
        if (n === 0) convexAsked.subscribe.push(name);
        openQueries.set(key, n + 1);
        let open = true;
        return () => {
          if (!open) return;
          open = false;
          const left = (openQueries.get(key) ?? 1) - 1;
          if (left > 0) openQueries.set(key, left); else openQueries.delete(key);
        };
      },
      localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined,
    };
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
    sessions: {}, conversations: {}, pendingMessages: {}, drafts: {},
    currentUser: { _id: ME, name: "Perf" }, clientStateInitialized: true,
  } as any);
  // Through the feed's own path, so what the first sync does at boot (view
  // adoption, the conversations mirror) is done before anything is measured.
  useInboxStore.getState().syncTable("sessions", Object.values(sessionRows(sessions)) as any);
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
    if (process.env.PERF_DEBUG) console.log("waiting", what, commits, host?.querySelectorAll("[data-vkey]").length, host?.textContent?.slice(-120));
  }
}

// Everything one action caused: React commits, store writes, Convex asks, DOM
// mutations and forced layouts.
async function measure(action: () => Promise<void>): Promise<Report> {
  commits = 0;
  rendered = new Map();
  layoutReads = [];
  convexAsked = { subscribe: [], query: [], mutation: [], action: [] };
  let storeWrites = 0;
  const storeKeys = new Set<string>();
  const unsub = useInboxStore.subscribe((next: any, prev: any) => {
    storeWrites++;
    for (const k in next) if (next[k] !== prev[k]) storeKeys.add(k);
  });
  // DOM changes under the host and inside every shadow root (the diff viewer
  // draws in one, outside React), including roots attached during the action.
  let mutations = 0;
  const observed = new Set<Node>();
  const mo = new w.MutationObserver((records: MutationRecord[]) => { mutations += records.length; watchRoots(); });
  const watch = (node: Node) => { if (observed.has(node)) return; observed.add(node); mo.observe(node, { subtree: true, childList: true, attributes: true, characterData: true }); };
  const watchRoots = () => { for (const el of host.querySelectorAll("*")) if (el.shadowRoot) watch(el.shadowRoot); };
  watch(host);
  watchRoots();
  await action();
  watchRoots();
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
    detail: { layoutReads: [...new Set(reads)], storeKeys: [...storeKeys], rendered: [...rendered].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} x${n}`), ...convexAsked },
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

// The inbox's session list over a cache of 5,000 sessions, the size a busy
// account holds. The panel caps what it draws (GLOBAL_CARD_BUDGET), so the
// cost that grows with the cache is the walk over every row.
const INBOX_SESSIONS = 5000;
const cards = () => host.querySelectorAll("[data-session-id]").length;

async function inboxPanel() {
  const { SessionListPanel } = await import("../components/GlobalSessionPanel");
  seedStore(INBOX_SESSIONS);
  mount();
  const panel = <SessionListPanel activeSessionId={convId(3)} onSessionSelect={() => {}} />;
  const show = async () => { await render(panel); await until(() => cards() > 0, "the session list to draw"); await settle(); };
  const hide = async () => { await act(async () => { root.render(null); }); await settle(); };
  return { show, hide };
}

// Opening the inbox: the list mounts over the full cache.
async function setupInboxLoad(): Promise<Bench> {
  const { show, hide } = await inboxPanel();
  await show();
  await hide();
  return {
    run: async () => {
      const report = await measure(show);
      report.counts.cards = cards();
      return report;
    },
    reset: hide,
  };
}

// The feed applies a heartbeat to one drawn session the way
// useLiveInboxSessions does (a delta through syncTable). It changes nothing
// the list shows, so it may re-render nothing.
async function setupInboxHeartbeat(): Promise<Bench> {
  const { show } = await inboxPanel();
  await show();
  let n = 0;
  const target = host.querySelector("[data-session-id]")!.getAttribute("data-session-id")!;
  return {
    run: () => measure(async () => {
      n++;
      const row = useInboxStore.getState().sessions[target] as any;
      useInboxStore.getState().syncTable("sessions", [{ ...row, last_heartbeat: now + n * 1000 }] as any, { isDelta: true } as any);
      await settle();
    }),
    reset: () => settle(),
  };
}

// Opening a long diff: a 1,560-line TypeScript file with every 20th line
// changed, shown whole (expandUnchanged) in the diff viewer, from mount until
// its last line is drawn.
const DIFF_LINES = 1560;
function longFile(changed: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < DIFF_LINES; i++) {
    const edit = changed && i % 20 === 7;
    out.push(i % 6 === 0 ? `export function step${i}(rows: Row[], limit = ${edit ? 64 : 32}): Row[] {` : i % 6 === 5 ? "}" : `  const v${i} = rows.filter((r) => r.idle && r.size > ${edit ? i * 2 : i}).slice(0, limit); // line ${i}`);
  }
  return out.join("\n") + "\n";
}

const diffLines = () => {
  let n = 0;
  for (const el of host.querySelectorAll("diffs-container")) n += el.shadowRoot?.querySelectorAll("[data-line]").length ?? 0;
  return n + host.querySelectorAll("[data-line]").length;
};

async function setupDiff(): Promise<Bench> {
  const { DiffView } = await import("../components/DiffView");
  seedStore(200);
  mount();
  const [oldStr, newStr] = [longFile(false), longFile(true)];
  const view = <DiffView oldStr={oldStr} newStr={newStr} fileName="src/routes.ts" language="typescript" maxLines={100_000} expandUnchanged showLineNumbers />;
  const show = async () => { await render(view); await until(() => diffLines() >= DIFF_LINES, "the diff's lines to draw", 120_000); await settle(); };
  const hide = async () => { await act(async () => { root.render(null); }); await settle(); };
  // The first open loads the renderer and the language; every run after is
  // a diff opened in a warm app.
  await show();
  await hide();
  return {
    run: async () => {
      const report = await measure(show);
      report.counts.diffLines = diffLines();
      return report;
    },
    reset: hide,
  };
}

const setups: Record<Workload, () => Promise<Bench>> = {
  switch: setupSwitch,
  "inbox-load": setupInboxLoad,
  "inbox-heartbeat": setupInboxHeartbeat,
  diff: setupDiff,
};

/** Builds the workload's world, once per process. */
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
