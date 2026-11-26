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

// The -modern workloads are the same inbox with the Modern style on (its
// session card, ModernSessionCardView, and section header): the same budgets.
// The -owners workloads are the same inbox with every session under the
// session_owners model: each row carries its owner fields and each has an
// owners read in the store, which the cards' owner faces read.
export type Workload = "switch" | "append" | "inbox-load" | "inbox-heartbeat" | "inbox-load-modern" | "inbox-heartbeat-modern" | "inbox-load-owners" | "inbox-heartbeat-owners" | "inbox-owners-push" | "diff" | "palette-open" | "palette-type" | "palette-idle";
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
// Named by the first app frame, or the diff viewer's own (it measures outside the app).
const readSite = (name: string) => `${name} ${new Error().stack!.split("\n").find((l) => (l.includes("/packages/web/") && !l.includes("/perf/") && !l.includes("/node_modules/")) || l.includes("/@pierre/diffs/"))?.trim().replace(/^at /, "").replace(/\/\S*\/node_modules\//, "") ?? "?"}`;
const offsets = new WeakMap<Element, number>();
// A scroller a workload mounts its subject in (`data-perf-viewport`) is a
// viewport tall, like a virtualized feed.
const isViewport = (el: Element) => el.hasAttribute("data-sv-feed") || el.hasAttribute("data-perf-viewport");
const heightOf = (el: Element) => ((el as HTMLElement).style?.height === "0px" ? 0 : isViewport(el) ? VIEWPORT : ROW);
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
// Shadow roots made during a measured action are watched from the moment they
// exist, so a viewer that draws (or redraws) inside one is counted.
let onShadowRoot: ((root: ShadowRoot) => void) | null = null;
const realAttachShadow = w.Element.prototype.attachShadow;
w.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
  const shadow = realAttachShadow.call(this, init);
  onShadowRoot?.(shadow);
  return shadow;
};

// Constructable stylesheets (the diff viewer styles its shadow root with
// them); jsdom has neither the class nor adoptedStyleSheets.
class CSSStyleSheet { cssRules: unknown[] = []; replaceSync(_text: string) {} replace(_text: string) { return Promise.resolve(this); } insertRule() { return 0; } deleteRule() {} }
for (const proto of [w.ShadowRoot.prototype, w.Document.prototype]) {
  if (!("adoptedStyleSheets" in proto)) Object.defineProperty(proto, "adoptedStyleSheets", { get() { return this.__adopted ?? []; }, set(v) { this.__adopted = v; }, configurable: true });
}
class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
// Reports each observed element as on screen once, as a browser does on
// observe for an element inside its root's margin. Only the diff workload
// installs it (Pierre's Virtualizer tracks which diffs are visible through
// one); the others keep NoopObserver, so no load-more sentinel fires there.
class VisibleObserver {
  targets = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {}
  observe(el: Element) {
    this.targets.add(el);
    queueMicrotask(() => {
      if (this.targets.has(el) && el.isConnected) this.callback([{ target: el, isIntersecting: true, intersectionRatio: 1, boundingClientRect: { top: 0 } } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    });
  }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
}
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
  Element: w.Element, Node: w.Node, Text: w.Text, Document: w.Document, DocumentFragment: w.DocumentFragment, ShadowRoot: w.ShadowRoot, SVGElement: w.SVGElement,
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
let lastCurrent = new WeakSet<object>();
const typeName = (t: any) => typeof t === "string" ? null : t?.displayName || t?.name || t?.type?.displayName || t?.type?.name || null;
// A lazy component's elementType is the lazy wrapper, which has no name; its
// type is the component it resolved to.
const fiberName = (f: any) => typeName(f.elementType) ?? typeName(f.type);
(globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
  onCommitFiberRoot(_id: number, fiberRoot: any) {
    const before = process.env.PERF_COMMITS ? new Map(rendered) : null;
    const stack = [fiberRoot.current];
    // A subtree this commit never visited keeps last commit's fibers, render
    // flags included; only a fiber object new since the last commit ran now.
    const seen = new WeakSet<object>();
    while (stack.length) {
      const f = stack.pop();
      seen.add(f);
      if (f.alternate && f.flags & 1 && !lastCurrent.has(f)) { const name = fiberName(f); if (name) rendered.set(name, (rendered.get(name) ?? 0) + 1); }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    lastCurrent = seen;
    // PERF_COMMITS=1 logs what each commit rendered, for finding a commit
    // nothing on screen asked for.
    if (before && process.env.PERF_HOOKS) {
      const find = (f: any): any => { const st = [f]; while (st.length) { const x = st.pop(); if (fiberName(x) === process.env.PERF_HOOKS && x.alternate) return x; if (x.child) st.push(x.child); if (x.sibling) st.push(x.sibling); } return null; };
      const f = find(fiberRoot.current);
      if (f && f.flags & 1) {
        const changed: string[] = [];
        let a = f.memoizedState, b = f.alternate.memoizedState, i = 0;
        while (a && b) { if (a.queue && a.memoizedState !== b.memoizedState) changed.push(`#${i}=${String(JSON.stringify(a.memoizedState) ?? a.memoizedState).slice(0, 60)}`); a = a.next; b = b.next; i++; }
        const propsChanged = f.memoizedProps !== f.alternate.memoizedProps;
        console.log("hooks:", process.env.PERF_HOOKS, propsChanged ? "props" : "", changed.join(" ") || "(context/parent)");
      }
    }
    if (before) console.log("commit:", [...rendered].filter(([k, n]) => n !== (before.get(k) ?? 0)).map(([k, n]) => `${k}+${n - (before.get(k) ?? 0)}`).slice(0, 14).join(" "));
  },
};

// REACT_COMPILER=1 runs the files on the compiler's allowlist compiled
// (test-helpers/reactCompiler.ts), so a bench or a budget can be taken with
// the compiler on. Before any app module, which is why those load below. A
// base ref without the helper runs as written.
if (process.env.REACT_COMPILER === "1") await import("../test-helpers/reactCompiler").catch(() => {});

// --- App modules (loaded after the DOM exists: react-dom decides at load) ----

const React = await import("react");
const { act, Profiler } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProviderWithAuth } = await import("convex/react");
const { getFunctionName } = await import("convex/server");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../store/inboxStore");
// The store hydrates from IndexedDB as its module loads and writes
// draftsHydrated once the first keys land. Let that happen before any world is
// built, or a slow machine lands the write inside a measured action.
while (!useInboxStore.getState().draftsHydrated) await new Promise((r) => setTimeout(r, 5));

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
      // Structured overlay facts on some rows, so a payload carries objects
      // the overlay must compare by value.
      ...(i % 11 === 0 ? { activity: { text: `editing file${i}.ts`, tool: "Edit", at: now - i * 1000 } } : {}),
      ...(i % 17 === 0 ? { open_tasks: [{ id: `task-${i}`, kind: "background", started_at: now - 600_000, tool_use_id: `tool-${i}`, description: "Watch the build", command: "sleep 60" }] } : {}),
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

// An owners read (sessionOwnership.listOwnersFor's shape) for session i: the
// viewer, a teammate on every third, a role on every fifth.
const ROLE_ID = "jd7perfrole00000000000000000000";
function ownersRead(i: number) {
  const id = convId(i);
  const people = [{ user_id: ME, name: "Perf", email: null, added_by: ME, added_at: now - i * 1000 }];
  if (i % 3 === 0) people.push({ user_id: "user_teammate", name: "Teammate", email: null, added_by: ME, added_at: now - i * 1000 + 1 });
  return {
    session_owners: true, conversation_id: id, people,
    role: i % 5 === 0 ? { role_id: ROLE_ID, short_id: "or-1", handle: "evals", name: "Eval Suite lead" } : null,
    parent_session: null, implicit_starter: null, starter_id: ME, role_started: false, can_edit: true, owners_changed_at: now - i * 1000,
  };
}

async function seedStore(sessions: number, owners = false) {
  const st = useInboxStore.getState() as any;
  st._setDispatch?.(async () => undefined);
  useInboxStore.setState({
    sessions: {}, conversations: {}, pendingMessages: {}, drafts: {},
    currentUser: { _id: ME, name: "Perf" }, clientStateInitialized: true,
  } as any);
  // Through the feed's own path, so what the first sync does at boot (view
  // adoption, the conversations mirror) is done before anything is measured.
  const rows = Object.values(sessionRows(sessions));
  if (owners) for (const [i, row] of rows.entries()) Object.assign(row, { owners_model: true, owned_by_me: true, implicit_owner: null, org_role_id: i % 5 === 0 ? ROLE_ID : null, owner_session_id: null });
  useInboxStore.getState().syncTable("sessions", rows as any);
  if (owners) {
    const { applySessionOwnersReads } = await import("../hooks/useSyncSessionOwners");
    applySessionOwnersReads(Object.fromEntries(rows.map((_, i) => [convId(i), ownersRead(i)])));
  }
}

// --- Mounting and measuring ------------------------------------------------

let commits = 0;
// Time React spent rendering in those commits (the Profiler's actualDuration).
let renderMs = 0;
// Each commit's render time, in order: the first is what stood between an
// action and its first paint.
let commitMs: number[] = [];
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
            <Profiler id="perf" onRender={(_id, _phase, actualDuration) => { commits++; renderMs += actualDuration; commitMs.push(actualDuration); }}>{node}</Profiler>
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

// "name xN" per distinct value, most frequent first.
const tally = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([x, n]) => `${x} x${n}`);

// Everything one action caused: React commits, store writes, Convex asks, DOM
// mutations and forced layouts.
async function measure(action: () => Promise<void>): Promise<Report> {
  commits = 0;
  renderMs = 0;
  commitMs = [];
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
  const mo = new w.MutationObserver((records: MutationRecord[]) => { mutations += records.length; });
  const watch = (node: Node) => { if (observed.has(node)) return; observed.add(node); mo.observe(node, { subtree: true, childList: true, attributes: true, characterData: true }); };
  watch(host);
  for (const el of host.querySelectorAll("*")) if (el.shadowRoot) watch(el.shadowRoot);
  onShadowRoot = watch;
  await action();
  onShadowRoot = null;
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
    detail: { renderMs: [renderMs.toFixed(2)], commitMs: commitMs.map((ms) => ms.toFixed(1)), layoutReads: [...new Set(reads)], layoutReadKinds: tally(reads.map((r) => r.split(" ")[0])), storeKeys: [...storeKeys], rendered: [...rendered].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} x${n}`), ...convexAsked },
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
  await seedStore(2000);
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

// A message arriving in the open conversation: 200 cached messages on screen,
// one more appended through the store's own merge (the path a streamed answer
// takes), until its text is drawn. The other rows have nothing new to show,
// so this is the re-render that memoization exists for.
async function setupAppend(): Promise<Bench> {
  const { InboxConversation } = await import("../app/inbox/QueuePageClient");
  await seedStore(2000);
  const a = convId(1);
  useInboxStore.getState().setMessages(a, messages(a, 200), { hasMoreAbove: true, initialized: true });
  mount();
  await render(<InboxConversation sessionId={a} isIdle autoFocusInput={false} />);
  await until(() => host.textContent!.includes(`Last line of answer 199 in ${a.slice(-6)}`), `conversation ${a} to paint`);
  await settle();
  let n = 200;
  return {
    run: () => measure(async () => {
      const i = n++;
      const row = { _id: `${a.slice(0, 20)}m${String(i).padStart(11, "0")}`, conversation_id: a, role: "assistant", timestamp: now + i * 1000, content: `Streamed answer ${i} has arrived.` };
      await act(async () => { useInboxStore.getState().mergeMessages(a, [row] as any, "append"); });
      await until(() => host.textContent!.includes(`Streamed answer ${i} has arrived.`), "the new message to paint");
      await settle();
    }),
    reset: async () => { await settle(); },
  };
}

// The inbox's session list over a cache of 5,000 sessions, the size a busy
// account holds. The panel caps what it draws (GLOBAL_CARD_BUDGET), so the
// cost that grows with the cache is the walk over every row.
const INBOX_SESSIONS = 5000;
const cards = () => host.querySelectorAll("[data-session-id]").length;

// The coarse clocks (engine useCoarseNow: 15 s and up) tick on real time, so a
// run that crosses a tick re-renders every relative time on the cards
// (WakeWhen, CardBars) whatever the action did. The owners variants set up
// longest and crossed one: they freeze those clocks, so a run counts only what
// its action caused. Shorter timers (settling, the feeder's) still run.
const COARSE_CLOCK_MS = 5_000;
function freezeCoarseClocks(): void {
  const real = globalThis.setInterval;
  const frozen = ((fn: (...args: any[]) => void, ms?: number, ...rest: any[]) =>
    (ms ?? 0) >= COARSE_CLOCK_MS ? (0 as unknown as ReturnType<typeof setInterval>) : real(fn, ms, ...rest)) as typeof setInterval;
  globalThis.setInterval = frozen;
  w.setInterval = frozen;
}

async function inboxPanel(modern = false, owners = false) {
  if (owners) freezeCoarseClocks();
  const { SessionListPanel } = await import("../components/GlobalSessionPanel");
  const { ThemeContext } = await import("../components/ThemeProvider");
  await seedStore(INBOX_SESSIONS, owners);
  mount();
  // Modern: the root class the style's CSS keys on, and the theme context the
  // components read it from (hooks/useVisualStyle).
  // Classic mounts the panel bare, as it always did.
  // Under the owners model the window's owners feeder rides along, as the
  // dashboard mounts it (DashboardLayout's VisibleOwnersFeeder), and every
  // card it watches reports itself on screen.
  const { useSyncVisibleSessionOwners, OWNER_CARDS_SETTLE_MS } = await import("../hooks/useSyncVisibleSessionOwners");
  function OwnersFeeder() { useSyncVisibleSessionOwners(); return null; }
  if (owners) (globalThis as any).IntersectionObserver = w.IntersectionObserver = VisibleObserver;
  const list = <SessionListPanel activeSessionId={convId(3)} onSessionSelect={() => {}} />;
  const bare = owners ? <>{list}<OwnersFeeder /></> : list;
  if (modern) w.document.documentElement.classList.add("modern-style");
  const theme = { theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any;
  const panel = modern ? <ThemeContext.Provider value={theme}>{bare}</ThemeContext.Provider> : bare;
  // The feeder reads the cards on screen once they hold still for
  // OWNER_CARDS_SETTLE_MS, longer than settle()'s quiet window: a shown list
  // is still only once that timer has landed, or the next measured action
  // counts the feeder catching up. (A hide unmounts the feeder and its timer.)
  const feederSettled = async () => { if (owners) { await tick(OWNER_CARDS_SETTLE_MS); await settle(); } };
  const show = async () => { await render(panel); await until(() => cards() > 0, "the session list to draw"); await settle(); await feederSettled(); };
  const hide = async () => { await act(async () => { root.render(null); }); await settle(); };
  return { show, hide };
}

// Opening the inbox: the list mounts over the full cache.
async function setupInboxLoad(modern = false, owners = false): Promise<Bench> {
  const { show, hide } = await inboxPanel(modern, owners);
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

// A heartbeat through the path production heartbeats take: the liveness
// overlay (useSyncInboxSessions' applyMineLivenessPayload, the one inbox
// channel that re-runs every beat). Each payload is shaped like the server's
// (computeSessionsLiveness): the viewer's 600 newest sessions, each row its
// overlay facts plus its placement stamps, and the projection envelope, all
// fresh objects as a decoded push is. Only one drawn session's heartbeat
// moves, which changes nothing the list shows, so a beat may re-render
// nothing.
const LIVE_SET = 600;
async function setupInboxHeartbeat(modern = false, owners = false): Promise<Bench> {
  const { applyMineLivenessPayload } = await import("../hooks/useSyncInboxSessions");
  const { INBOX_FACT_FIELDS, INBOX_PROJECTION_VERSION } = await import("@codecast/shared/contracts");
  const { placeInboxRows } = await import("../store/inboxStore");
  const { show } = await inboxPanel(modern, owners);
  await show();
  const target = host.querySelector("[data-session-id]")!.getAttribute("data-session-id")!;
  const sessions = useInboxStore.getState().sessions as Record<string, any>;
  // The server stamps each shown member with the placement its facts give;
  // the facts do not change between beats, so neither do the stamps. No
  // seeded session asks, so `asking` is false on every row, as the server's
  // askingFor would say for them.
  const placed = placeInboxRows(useInboxStore.getState() as any, { scope: "mine" });
  const live = Object.keys(sessions).filter((id) => sessions[id].user_id === ME && placed.placements.has(id)).slice(0, LIVE_SET);
  if (!live.includes(target)) live.push(target);
  const stampOf = (id: string) => {
    const p = placed.placements.get(id)!;
    return { bucket: p.bucket, work_state: p.work_state, asking: false, below_fold: !!p.below_fold, bucket_stale_at: null, stale_bucket: null };
  };
  let n = 0;
  const beat = async () => {
    n++;
    const rows = useInboxStore.getState().sessions as Record<string, any>;
    const liveness: Record<string, Record<string, unknown>> = {};
    for (const id of live) {
      const row: Record<string, unknown> = stampOf(id);
      for (const key of INBOX_FACT_FIELDS) row[key] = rows[id][key] ?? null;
      liveness[id] = row;
    }
    liveness[target].last_heartbeat = now + n * 1000;
    const projection = { v: INBOX_PROJECTION_VERSION, user_id: ME, scope: "mine", team_id: null, epoch: placed.epoch, tally: placed.tally, set_digest: null, truncated: [] };
    const payload = structuredClone({ liveness, projection });
    await act(async () => { applyMineLivenessPayload(payload); });
  };
  return {
    run: () => measure(async () => {
      await beat();
      await settle();
    }),
    reset: () => settle(),
  };
}

// A push of the visible cards' owners reads (listOwnersFor), as fresh objects
// a decoded push is, saying what the store already holds: it may write
// nothing and re-render nothing. Its follow-up changes one card's owners.
async function setupInboxOwnersPush(): Promise<Bench> {
  const { applySessionOwnersReads } = await import("../hooks/useSyncSessionOwners");
  const { show } = await inboxPanel(false, true);
  await show();
  const drawn = [...host.querySelectorAll("[data-session-id]")].map((el) => el.getAttribute("data-session-id")!);
  const index = (id: string) => Number(id.slice(3));
  return {
    run: () => measure(async () => {
      const payload = structuredClone(Object.fromEntries(drawn.map((id) => [id, ownersRead(index(id))])));
      await act(async () => { applySessionOwnersReads(payload); });
      await settle();
    }),
    reset: () => settle(),
  };
}

// Opening a long diff: a 1,560-line TypeScript file with every 20th line
// changed, shown whole (expandUnchanged) in the diff viewer, from mount until
// its window is drawn. A diff past VIRTUALIZE_LINE_THRESHOLD draws windowed
// under the Virtualizer of the scroller around it (components/diff/
// virtualizer.ts), so it mounts in a scroller a viewport tall, at the top, as
// it sits in a transcript or the diff panel.
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
  await seedStore(200);
  mount();
  const [oldStr, newStr] = [longFile(false), longFile(true)];
  (globalThis as any).IntersectionObserver = w.IntersectionObserver = VisibleObserver;
  const view = (
    <div data-perf-viewport style={{ overflowY: "auto", height: VIEWPORT }}>
      <DiffView oldStr={oldStr} newStr={newStr} fileName="src/routes.ts" language="typescript" maxLines={100_000} expandUnchanged showLineNumbers />
    </div>
  );
  // The viewer draws outside React (on animation frames), so the window is
  // drawn once its line count holds still, not when React stops committing.
  const show = async () => {
    await render(view);
    await until(() => diffLines() > 0, "the diff's lines to draw", 120_000);
    for (let drawn = -1; drawn !== diffLines();) { drawn = diffLines(); await settle(); }
  };
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

// The command palette over a cache the size a busy account holds (measured on
// one on 2026-11-25): 2,700 sessions, 29,000 rows in the session index, 52,000
// tasks, 20,000 docs, 640 plans and 4,500 routines. PALETTE_SAMPLE names a JSON
// file of real rows per kind ({ sessions: [...], tasks: [...], ... }) to clone
// up to those counts instead of the synthetic rows; such a file holds private
// data and stays out of git.
const PALETTE_SCALE = { sessions: 2700, sessionIndex: 29000, tasks: 52000, docs: 20000, plans: 640, agentTasks: 4500 };
type PaletteKind = keyof typeof PALETTE_SCALE;
const WORDS = ["sync", "inbox", "palette", "deploy", "review", "typing", "search", "convex", "store", "release", "mobile", "audit", "fix", "ship", "plan", "docs", "call", "chat"];
const words = (i: number, n: number) => Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 13) % WORDS.length]).join(" ");
function syntheticRow(kind: PaletteKind, i: number): any {
  const at = now - i * 37_000;
  const base = { _id: `${kind.slice(0, 2)}7${String(i).padStart(29, "0")}`, _creationTime: at, updated_at: at, created_at: at, user_id: i % 5 ? ME : "user_teammate", team_id: "team_perf", workspace: i % 3 ? "team:team_perf" : `user:${ME}` };
  switch (kind) {
    case "sessions": return { ...sessionRows(1)[convId(0)], ...base, _id: convId(i), title: `Session ${i}: ${words(i, 5)}`, project_path: `/src/p${i % 40}` };
    case "sessionIndex": return { _id: convId(PALETTE_SCALE.sessions + i), agent_type: "claude_code", first_prompt: `${words(i, 30)}`, idle_summary: words(i + 1, 12), message_count: 40 + (i % 300), project_path: `/src/p${i % 40}`, title: `Indexed ${i}: ${words(i, 4)}`, updated_at: at - 40 * 86_400_000 };
    case "tasks": return { ...base, short_id: `ct-${i}`, title: `Task ${i}: ${words(i, 6)}`, description: words(i, 120), status: ["open", "in_progress", "done", "dropped"][i % 4], priority: "medium", task_type: "task", triage_status: "active", project_path: `/src/p${i % 40}` };
    case "docs": return { ...base, title: `Doc ${i}: ${words(i, 5)}`, doc_type: i % 9 ? "note" : "plan", author_name: "Perf" };
    case "plans": return { ...base, short_id: `pl-${i}`, title: `Plan ${i}: ${words(i, 5)}`, status: i % 4 ? "active" : "done" };
    case "agentTasks": return { ...base, short_id: `tr-${i}`, title: `Routine ${i}: ${words(i, 4)}`, prompt: words(i, 40), status: i % 3 ? "completed" : "scheduled" };
  }
}
function paletteRows(kind: PaletteKind, sample: any[] | undefined): any[] {
  const n = PALETTE_SCALE[kind];
  if (!sample?.length) return Array.from({ length: n }, (_, i) => syntheticRow(kind, i));
  return Array.from({ length: n }, (_, i) => {
    const row = sample[i % sample.length];
    const id = `${String(row._id).slice(0, 20)}${String(i).padStart(12, "0")}`;
    return { ...row, _id: id, title: `${row.title ?? ""} ${i}`, updated_at: (row.updated_at ?? now) - i * 1000 };
  });
}

async function setupPalette(mode: "open" | "type" | "idle"): Promise<Bench> {
  const typing = mode !== "open";
  const { PaletteHost } = await import("../components/shell/ShellHosts");
  const sample = process.env.PALETTE_SAMPLE ? JSON.parse(await Bun.file(process.env.PALETTE_SAMPLE).text()) : {};
  const st = useInboxStore.getState() as any;
  st._setDispatch?.(async () => undefined);
  useInboxStore.setState({ sessions: {}, conversations: {}, currentUser: sample.currentUser ?? { _id: ME, name: "Perf" }, clientStateInitialized: true, ...(sample.mentionIndex ? { mentionIndex: sample.mentionIndex } : {}) } as any);
  for (const kind of Object.keys(PALETTE_SCALE) as PaletteKind[]) useInboxStore.getState().syncTable(kind as any, paletteRows(kind, sample[kind]) as any);
  mount();
  await render(<PaletteHost />);
  const input = () => host.ownerDocument.querySelector<HTMLInputElement>("[cmdk-input]");
  const items = () => host.ownerDocument.querySelectorAll("[cmdk-item]").length;
  const open = async () => {
    await act(async () => { useInboxStore.getState().openPalette(); });
    await until(() => !!input() && items() > 0, "the palette to open");
    await settle(50);
  };
  const close = async () => { await act(async () => { useInboxStore.getState().closePalette(); }); await settle(50); };
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!;
  const QUERY = process.env.PALETTE_QUERY ?? "sync review";
  // One key: the box takes the value, then the deferred ranking render and
  // whatever it schedules settle.
  const key = async (value: string) => {
    const el = input()!;
    await act(async () => { setter.call(el, value); el.dispatchEvent(new w.Event("input", { bubbles: true })); });
    await settle(30);
  };
  // Between opens the app keeps living: twenty sessions beat and a task
  // changes, so an open never finds the store exactly as it left it.
  let beat = 0;
  const churn = async () => {
    beat++;
    const state = useInboxStore.getState() as any;
    const rows = Object.values(state.sessions).slice(0, 20).map((r: any) => ({ ...r, updated_at: now + beat * 1000, last_heartbeat: now + beat * 1000 }));
    const task = Object.values(state.tasks)[beat % 50] as any;
    await act(async () => {
      useInboxStore.getState().syncTable("sessions", rows as any, { isDelta: true } as any);
      useInboxStore.getState().syncTable("tasks", [{ ...task, updated_at: now + beat * 1000 }] as any, { isDelta: true } as any);
    });
  };
  // The first open loads the palette's lazy chunks; runs measure a warm app.
  await open();
  if (!typing) await close();
  // Open and untouched while the app lives on: what a heartbeat costs it.
  if (mode === "idle") return { run: () => measure(async () => { await churn(); await settle(30); }), reset: async () => {} };
  return typing
    ? {
        run: () => measure(async () => { for (let i = 1; i <= QUERY.length; i++) await key(QUERY.slice(0, i)); }),
        reset: async () => { await key(""); },
      }
    : { run: () => measure(open), reset: async () => { await close(); await churn(); } };
}

const setups: Record<Workload, () => Promise<Bench>> = {
  "palette-open": () => setupPalette("open"),
  "palette-type": () => setupPalette("type"),
  "palette-idle": () => setupPalette("idle"),
  switch: setupSwitch,
  append: setupAppend,
  "inbox-load": () => setupInboxLoad(),
  "inbox-heartbeat": () => setupInboxHeartbeat(),
  "inbox-load-modern": () => setupInboxLoad(true),
  "inbox-heartbeat-modern": () => setupInboxHeartbeat(true),
  "inbox-load-owners": () => setupInboxLoad(false, true),
  "inbox-heartbeat-owners": () => setupInboxHeartbeat(false, true),
  "inbox-owners-push": setupInboxOwnersPush,
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
