// A backend that has none of the web bundle's functions: the degrade harness.
//
// The web bundle ships on every push; convex ships only when someone runs
// deploy.sh. Inside that gap the live site asks for functions prod does not
// have, convex answers "Could not find public function", and a plain useQuery
// re-throws that during render, so the component drops into its ErrorBoundary
// (the conversation header on 2026-08-11, the avatar bar on 2026-09-21).
// CLAUDE.md's rule: a query that only enriches a surface goes through
// useQueryNoThrow, and a feeder never re-throws, because the surface paints
// from the store.
//
// A degrade test mounts a whole page surface over the real store and the real
// components, with only the convex transport replaced by this one: every query
// fails the way a missing function fails, through each hook's own contract
// (useQuery throws, useQueries hands the Error back as the value, a client
// query rejects). Mutations and actions resolve to nothing, so a surface that
// writes on mount is not mistaken for one that reads. A function the surface
// cannot honestly render without may be answered by name through `answers`.
//
// mountSurface records every error any ErrorBoundary caught and every error
// that escaped all of them, so "the surface still renders" is an assertion on
// those lists, not on a boundary's fallback text the test would have to know.
//
// Usage, at the top of a test file and before importing any component:
//   const env = installDom("https://app.test/inbox");
//   const backend = await installMissingBackend();
//   const { mountSurface } = env;
import { afterAll, mock } from "bun:test";
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "./globals";
import { closeDomWindow } from "./domGlobals";

export function missingFunctionError(name: string): Error {
  return new Error(`[Request ID: degrade000000000] Server Error\nCould not find public function for '${name}'.`);
}

const noop = () => {};
class InertObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

export function installDom(url: string) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url, pretendToBeVisual: true });
  const w = dom.window as any;
  const restoreGlobals = replaceGlobals({
    window: w,
    document: w.document,
    navigator: w.navigator,
    location: w.location,
    history: w.history,
    localStorage: w.localStorage,
    sessionStorage: w.sessionStorage,
    indexedDB,
    IDBKeyRange,
    HTMLElement: w.HTMLElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLAnchorElement: w.HTMLAnchorElement,
    HTMLDivElement: w.HTMLDivElement,
    SVGElement: w.SVGElement,
    Element: w.Element,
    Node: w.Node,
    Text: w.Text,
    DocumentFragment: w.DocumentFragment,
    Event: w.Event,
    CustomEvent: w.CustomEvent,
    KeyboardEvent: w.KeyboardEvent,
    MouseEvent: w.MouseEvent,
    FocusEvent: w.FocusEvent,
    PointerEvent: w.PointerEvent ?? w.MouseEvent,
    DOMParser: w.DOMParser,
    DOMRect: w.DOMRect ?? class DOMRect { constructor(public x = 0, public y = 0, public width = 0, public height = 0) {} get top() { return this.y; } get left() { return this.x; } get right() { return this.x + this.width; } get bottom() { return this.y + this.height; } toJSON() { return this; } },
    MutationObserver: w.MutationObserver,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    ResizeObserver: InertObserver,
    IntersectionObserver: InertObserver,
    matchMedia: () => ({ matches: false, media: "", onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false }),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  w.matchMedia = (globalThis as any).matchMedia;
  w.ResizeObserver = InertObserver;
  w.IntersectionObserver = InertObserver;
  // jsdom lays nothing out, and a virtualized list over a zero-height
  // viewport renders no rows at all. A fixed box per element is enough for
  // every list to render its first rows.
  for (const [prop, value] of [["offsetHeight", 600], ["clientHeight", 600], ["offsetWidth", 800], ["clientWidth", 800]] as const) {
    Object.defineProperty(w.HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} });
  w.HTMLElement.prototype.scrollIntoView ??= noop;
  w.HTMLElement.prototype.scrollTo ??= noop;
  w.scrollTo = noop;
  afterAll(() => {
    closeDomWindow(dom);
    restoreGlobals();
  });
  return { dom, mountSurface, mountPage };
}

export type MissingBackend = {
  // Every function a query hook or client asked for and was refused, by name.
  refused: Set<string>;
};

type Answers = Record<string, unknown>;

export async function installMissingBackend(opts: { answers?: Answers } = {}): Promise<MissingBackend> {
  const answers = opts.answers ?? {};
  const refused = new Set<string>();
  const { getFunctionName } = await import("convex/server");
  const nameOf = (ref: unknown) => {
    try {
      return getFunctionName(ref as any);
    } catch {
      return String(ref);
    }
  };
  // The hook contract: the answer, or the Error a missing function produces.
  const resolve = (ref: unknown): unknown => {
    const name = nameOf(ref);
    if (name in answers) return answers[name];
    refused.add(name);
    return missingFunctionError(name);
  };
  const failing = (ref: unknown) => {
    const value = resolve(ref);
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  const mutation = () => Object.assign(async () => undefined, { withOptimisticUpdate: () => mutation() });
  const watch = (ref: unknown) => ({
    onUpdate: () => noop,
    localQueryResult: () => {
      const value = resolve(ref);
      if (value instanceof Error) throw value;
      return value;
    },
    journal: () => undefined,
  });
  const client = {
    query: failing,
    mutation: async () => undefined,
    action: async () => undefined,
    watchQuery: watch,
    connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false, hasEverConnected: true, connectionCount: 1, connectionRetries: 0, timeOfOldestInflightRequest: null, inflightMutations: 0, inflightActions: 0 }),
    subscribeToConnectionState: () => noop,
    setAuth: noop,
    clearAuth: noop,
    close: async () => {},
    url: "https://degrade.convex.cloud",
  };

  const convexReact = { ...(await import("convex/react")) };
  afterAll(() => mock.module("convex/react", () => convexReact));
  mock.module("convex/react", () => ({
    ...convexReact,
    useConvex: () => client,
    useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
    useConvexConnectionState: () => client.connectionState(),
    useQuery: (ref: unknown, args?: unknown) => {
      if (args === "skip") return undefined;
      const value = resolve(ref);
      if (value instanceof Error) throw value;
      return value;
    },
    useQueries: (queries: Record<string, { query: unknown; args: unknown }>) =>
      Object.fromEntries(Object.entries(queries).map(([key, q]) => [key, resolve(q.query)])),
    usePaginatedQuery: (ref: unknown, args?: unknown) => {
      if (args === "skip") return { results: [], status: "LoadingFirstPage", isLoading: true, loadMore: noop };
      const value = resolve(ref);
      if (value instanceof Error) throw value;
      return { results: value, status: "Exhausted", isLoading: false, loadMore: noop };
    },
    useMutation: mutation,
    useAction: () => async () => undefined,
  }));
  // The auth transport rides the same client: signed in, and sign out does
  // nothing a render could observe.
  const convexAuth = { ...(await import("@convex-dev/auth/react")) };
  afterAll(() => mock.module("@convex-dev/auth/react", () => convexAuth));
  mock.module("@convex-dev/auth/react", () => ({
    ...convexAuth,
    useAuthActions: () => ({ signIn: async () => ({ signingIn: false }), signOut: async () => {} }),
    useAuthToken: () => "degrade-token",
  }));
  return { refused };
}

export type MountedSurface = {
  container: HTMLElement;
  // Errors an ErrorBoundary caught (the surface, or a part of it, went down).
  caught: Error[];
  // Errors no boundary caught (the whole root went down).
  uncaught: Error[];
  text: () => string;
  unmount: () => Promise<void>;
};

// The component that threw, read off React's component stack, so a failure
// names the subscriber to fix and not only the function that was missing.
function withOwner(error: unknown, info: { componentStack?: string }): Error {
  const e = error instanceof Error ? error : new Error(String(error));
  const owner = info.componentStack?.match(/^\s*at (\S+)/m)?.[1];
  return Object.assign(e, { owner });
}

async function mountSurface(node: React.ReactNode): Promise<MountedSurface> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const caught: Error[] = [];
  const uncaught: Error[] = [];
  const root = createRoot(container, {
    onCaughtError: (error: unknown, info: { componentStack?: string }) => caught.push(withOwner(error, info)),
    onUncaughtError: (error: unknown, info: { componentStack?: string }) => uncaught.push(withOwner(error, info)),
  });
  await act(async () => {
    root.render(node);
  });
  // A second pass lets effects that subscribe after the first commit
  // (feeders gated on a settled flag, lazy panels) run and fail too.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return {
    container,
    caught,
    uncaught,
    text: () => container.textContent ?? "",
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

// Convex-shaped ids: several surfaces skip their queries for a stub id, so a
// fixture with a readable id would never reach the backend it is testing.
export const fixtureId = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(32, "0").slice(0, 32);
export const VIEWER_ID = fixtureId("degradeviewer");
export const TEAM_ID = fixtureId("degradeteam");

// What a signed-in viewer's cache holds before any query answers: who they
// are, their team with every opt-in feature on (so no surface hides behind an
// off flag), and that team as the active workspace.
export async function seedViewer(): Promise<void> {
  const { useInboxStore } = await import("../store/inboxStore");
  const { TEAM_FEATURE_KEYS } = await import("@codecast/shared/contracts");
  const viewer = { _id: VIEWER_ID, name: "Dana Viewer", email: "dana@degrade.test", username: "dana" };
  const s = useInboxStore.getState();
  useInboxStore.setState({
    currentUser: viewer,
    clientStateInitialized: true,
    clientState: { ...s.clientState, ui: { ...s.clientState.ui, active_team_id: TEAM_ID } },
    callConfig: { enabled: true },
  } as any);
  s.syncTable("teams", [{ _id: TEAM_ID, name: "Degrade Co", role: "admin", features: Object.fromEntries(TEAM_FEATURE_KEYS.map((k) => [k, true])) }] as any);
  s.syncTable("teamMembers", [{ ...viewer, role: "admin", presence_state: "active" }] as any);
}

// A session this browser already holds: its inbox row, its conversation
// meta and its messages, written the way the feeders write them.
export async function seedCachedSession(id: string, title: string, messages: { role: "user" | "assistant"; content: string }[]): Promise<void> {
  const { useInboxStore } = await import("../store/inboxStore");
  const now = Date.now();
  const store = useInboxStore.getState();
  store.syncTable("sessions", [{
    _id: id,
    session_id: `s-${id.slice(0, 8)}`,
    user_id: VIEWER_ID,
    owned_by_me: true,
    title,
    status: "active",
    started_at: now - 3_600_000,
    updated_at: now - 60_000,
    message_count: messages.length,
    is_idle: true,
    agent_type: "claude_code",
    project_path: "/src/app",
  }] as any);
  store.syncRecord("conversations", id, { _id: id, title, user_id: VIEWER_ID, is_own: true, message_count: messages.length, updated_at: now - 60_000 } as any);
  store.setMessages(id, messages.map((m, i) => ({
    _id: fixtureId(`${id.slice(0, 12)}msg${i}`),
    role: m.role,
    content: m.content,
    timestamp: now - (messages.length - i) * 60_000,
  })) as any);
}

// Pages mounted where the app mounts them: inside the dashboard shell (the
// sidebar, the top bar, the global feeders) at their real routes, entered at
// `path`. Several routes let a page hand off to another (a deep link that
// redirects into the inbox) and land somewhere real.
export async function mountPage(path: string, routes: Record<string, React.ReactNode>): Promise<MountedSurface> {
  const { MemoryRouter, Routes, Route } = await import("react-router");
  const { default: DashboardShell } = await import("../src/layouts/DashboardShell");
  const { ErrorBoundary } = await import("../components/ErrorBoundary");
  // Each mount is a fresh page load: the tabs a previous mount opened are
  // shared store state and would otherwise render in place of this route.
  const { useInboxStore } = await import("../store/inboxStore");
  useInboxStore.setState({ tabs: [], activeTabId: null } as any);
  return mountSurface(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<DashboardShell />}>
          {Object.entries(routes).map(([route, page]) => (
            <Route key={route} path={route} element={<ErrorBoundary name={`Page ${route}`} level="panel">{page}</ErrorBoundary>} />
          ))}
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

// The one-line summary a failing assertion prints: which errors took which
// part of the surface down.
export function describeFailures(surface: MountedSurface): string {
  return [...surface.caught, ...surface.uncaught]
    .map((e: any) => `${e.owner ?? "?"}: ${(e?.message ?? String(e)).split("\n").slice(0, 2).join(" | ")}`)
    .join("\n");
}
