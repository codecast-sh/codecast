import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { replaceGlobals } from "../../../test-helpers/globals";

// The proof that the hero is isolated from the visitor's app (ARCHITECTURE.md
// section 1, item 7). It mounts every chapter the registry holds inside the
// real HeroSandbox, with the real store module loaded, steps the film clock
// across the whole timeline, fires every `data-hero-live` interaction at each
// chapter's hold, and then checks that nothing reached the app:
//   (a) every top-level store key is the same reference as before
//   (b) no IndexedDB write, outbox entry or server dispatch was made
//   (c) window/document listeners were added only for allowlisted types
//   (d) the real Convex client was never asked to watch a query, run one,
//       or call a mutation or an action
//   (e) <html>'s classes are untouched
//   (f) nothing was written to localStorage
//   (g) no event fired inside the hero reached a document or window listener
//       (the page's navigation progress bar, outside-click handlers), and the
//       app's own capture-phase mention router (App.tsx) never navigated, even
//       for a mention pill pressed inside the hero
//   (h) nothing was portalled to document.body (context menus, dialogs,
//       hover cards: every element is hovered at each hold, past the delay)
//   (i) no link activation went through
//   (j) the visitor's own UI prefs change nothing the hero draws: the film is
//       drawn again with every pref the hero could read flipped, and must match
//   (k) nothing in the hero is in the page's tab order at any chapter's hold,
//       and a press on a live control leaves no focus on it (only a live text
//       field keeps focus)
// and that no part failed into its boundary. Interactions are fired on every
// control inside each live element (pointer, mouse, click, context menu and
// Enter/Space), and a context menu on every message and trigger row. New chapters and parts are
// picked up through the registry (chapters/contract.test.ts keeps the
// registry equal to the files), so a builder never edits this test.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.test/", pretendToBeVisual: true });
const w = dom.window as unknown as Window & typeof globalThis;

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
w.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof w.matchMedia;
(w as any).IntersectionObserver ??= NoopObserver;
(w as any).ResizeObserver ??= NoopObserver;
w.HTMLElement.prototype.scrollIntoView ??= () => {};

const restoreGlobals = replaceGlobals({
  window: w,
  document: w.document,
  navigator: w.navigator,
  location: w.location,
  localStorage: w.localStorage,
  sessionStorage: w.sessionStorage,
  Element: w.Element,
  HTMLElement: w.HTMLElement,
  HTMLInputElement: w.HTMLInputElement,
  HTMLTextAreaElement: w.HTMLTextAreaElement,
  SVGElement: w.SVGElement,
  Node: w.Node,
  Text: w.Text,
  DocumentFragment: w.DocumentFragment,
  Event: w.Event,
  MouseEvent: w.MouseEvent,
  KeyboardEvent: w.KeyboardEvent,
  CustomEvent: w.CustomEvent,
  FocusEvent: w.FocusEvent,
  NodeFilter: (w as any).NodeFilter,
  HTMLAnchorElement: w.HTMLAnchorElement,
  HTMLButtonElement: w.HTMLButtonElement,
  PointerEvent: (w as any).PointerEvent ?? w.MouseEvent,
  MutationObserver: w.MutationObserver,
  IntersectionObserver: (w as any).IntersectionObserver,
  ResizeObserver: (w as any).ResizeObserver,
  getComputedStyle: w.getComputedStyle.bind(w),
  matchMedia: w.matchMedia.bind(w),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

// Imported after the DOM exists, the way the app loads them.
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConvexReactClient } = await import("convex/react");
const { useInboxStore } = await import("../../../store/inboxStore");
const { HeroSandbox } = await import("./sandbox");
const { World } = await import("./surfaces");
const { createFilmClock, FilmClockContext } = await import("./filmClock");
const { loadAllChapters } = await import("./chapters");
const { DURATION, SCENES, SURFACES } = await import("./world");
const { MemoryRouter, useLocation } = await import("react-router");
const { useMentionLinkNavigation } = await import("../../../hooks/useMentionLinkNavigation");
const act: <T>(fn: () => T | Promise<T>) => Promise<T> = (React as any).act;

/**
 * Listener types the hero may add to window or document. Every addition needs
 * a reason here; key listeners never qualify (the hero takes no page keys).
 *   resize, scroll       layout reads
 *   visibilitychange     pausing while the tab is hidden
 *   selectionchange      React DOM's own root listener (createRoot adds it)
 *   beforeunload,        module-level teardown in lib/calls/callManager.ts,
 *   pagehide             lib/calls/walkie.ts and lib/terminal/termSessions.ts,
 *                        loaded through real views; they act only during a
 *                        live call or terminal session, which the hero never starts
 *   pointerup            a Radix tooltip trigger (a chat reaction) pressed
 *                        clears its own pressed flag on the next pointerup, once
 */
const LISTENER_ALLOWLIST = new Set<string>(["resize", "scroll", "visibilitychange", "selectionchange", "beforeunload", "pagehide", "pointerup"]);

const STEP = 0.25;

/** What a visitor can press inside a live element. */
const CONTROLS = "button, [role=button], a, [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=tab], label, summary";
/** Rows whose right-click opens the app's own menu. */
const MENU_ROWS = "[data-cc-message], [data-schedrow]";
const store = useInboxStore as any;

const host = w.document.createElement("div");
const navigated: string[] = [];

const mouse = (type: string) => new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
const Pointer = (w as any).PointerEvent ?? w.MouseEvent;
/** Point at an element the way a visitor's pointer arrives: hover cards and tooltips open from these. */
function hover(el: Element) {
  el.dispatchEvent(new Pointer("pointerover", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Pointer("pointerenter", { bubbles: false }));
  el.dispatchEvent(new w.MouseEvent("mouseover", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new w.MouseEvent("mouseenter", { bubbles: false }));
  el.dispatchEvent(new Pointer("pointermove", { bubbles: true, cancelable: true }));
}
/** Longer than any hover delay in the app (cards open at 200ms, Radix tooltips at 700ms by default). */
const HOVER_WAIT_MS = 800;

/** Generous: on a loaded machine the sweep's wall time runs far past its CPU time. */
const TIMEOUT_MS = Number(process.env.HERO_GUARD_TIMEOUT_MS ?? 600_000);

/**
 * Markup to compare across two mounts: the digits a clock read at mount may
 * move, the clocks that tick in real time (a trigger's "in 4h" turns "in 3h
 * 59m", its "2s ago" turns "2m ago", when a draw runs long), and React's ids
 * (a counter across roots), are set aside.
 */
const shape = (html: string) =>
  html
    .replace(/«[^»]*»|:r[0-9a-z]+:/g, "«id»")
    .replace(/\d+/g, "#")
    .replace(/\bin #[dhms](?: #[dhms])*/g, "in «countdown»")
    .replace(/#[dhms](?: #[dhms])* ago/g, "«age» ago");
/** Fire a press the way a visitor's click arrives; a link it activates must have been cancelled. */
function press(el: Element) {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) el.dispatchEvent(type.startsWith("pointer") ? new ((w as any).PointerEvent ?? w.MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 }) : mouse(type));
  const went = el.dispatchEvent(mouse("click"));
  const link = el.closest("a[href]");
  if (went && link) navigated.push(link.getAttribute("href") ?? "");
}

describe("hero sandbox isolation", () => {
  // The whole film, every live interaction, one chapter per test, so a slow machine names the chapter it was in
  // rather than timing out the film; the spies are set up once before the first and checked once after the last.
  describe("the whole film, every live interaction, touches nothing of the app's", () => {
    const idbWrites: unknown[] = [];
    const enqueued: unknown[] = [];
    const dispatched: unknown[] = [];
    const reached: string[] = [];
    const appPaths: string[] = [];
    const listeners: string[] = [];
    const errors: string[] = [];
    const focusKept: string[] = [];
    let before: Record<string, unknown> = {};
    let bodyBefore: Element[] = [];
    let appHost: HTMLElement;
    let appRoot: ReturnType<typeof createRoot>;
    let root: ReturnType<typeof createRoot>;
    let clock: ReturnType<typeof createFilmClock>;
    let spies: { mockRestore(): void }[] = [];
    let watch: ReturnType<typeof spyOn>;
    let convexCalls: ReturnType<typeof spyOn>[];
    let setItem: ReturnType<typeof spyOn>;

    beforeAll(async () => {
      // Let module boot settle before taking the baseline.
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      store.getState()._setIDBWrite((...args: unknown[]) => void idbWrites.push(args));
      store.getState()._setOutbox(async (e: unknown) => void enqueued.push(e), async () => {}, async () => []);
      store.getState()._setDispatch(async (...args: unknown[]) => void dispatched.push(args));
      before = { ...store.getState() };

      // Registered before the listener spies, as the page's own document and window listeners are.
      for (const type of ["click", "pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu", "keydown", "keyup"]) {
        for (const target of [w.document, w] as EventTarget[]) {
          target.addEventListener(type, (e) => {
            if (e.target instanceof w.Node && host.contains(e.target)) reached.push(`${target === w ? "window" : "document"}:${type}`);
          });
        }
      }
      // The app's capture-phase mention router, mounted the way App.tsx mounts it, with the page's location watched.
      function AppShell() {
        useMentionLinkNavigation();
        const at = useLocation().pathname;
        if (appPaths[appPaths.length - 1] !== at) appPaths.push(at);
        return null;
      }
      appHost = w.document.createElement("div");
      w.document.body.append(appHost);
      appRoot = createRoot(appHost);
      await act(async () => appRoot.render(<MemoryRouter initialEntries={["/"]}><AppShell /></MemoryRouter>));
      bodyBefore = [...w.document.body.children];

      const winAdd = spyOn(w, "addEventListener").mockImplementation(function (this: unknown, type: string) {
        listeners.push(`window:${type}`);
      } as any);
      const docAdd = spyOn(w.document, "addEventListener").mockImplementation(function (this: unknown, type: string) {
        listeners.push(`document:${type}`);
      } as any);
      watch = spyOn(ConvexReactClient.prototype, "watchQuery");
      convexCalls = (["query", "mutation", "action"] as const).map((m) => spyOn(ConvexReactClient.prototype, m));
      setItem = spyOn(w.Storage.prototype, "setItem");
      const consoleError = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
      spies = [winAdd, docAdd, watch, ...convexCalls, setItem, consoleError];

      w.document.documentElement.className = "dark minimal-style";
      const chapters = await loadAllChapters();
      clock = createFilmClock(0);
      w.document.body.append(host);
      root = createRoot(host);
      await act(async () => {
        root.render(
          // The page always has a router around the hero; HeroSandbox masks it
          // with its own, so this also proves the two nest.
          <MemoryRouter>
            <HeroSandbox>
              <FilmClockContext.Provider value={clock}>
                <World chapters={chapters} now={Date.UTC(2026, 8, 30, 12)} />
              </FilmClockContext.Provider>
            </HeroSandbox>
          </MemoryRouter>,
        );
      });
    }, TIMEOUT_MS);

    const FOCUSABLE = "a[href], button, input, textarea, select, iframe, summary, [tabindex], [contenteditable]";
    for (const scene of SCENES) {
      test(`${scene.name}: every live interaction at its hold`, async () => {
        const hold = scene.hold + 1;
        // Stepped through the chapter's own stretch of the film, in order, so every chapter mounts as it does when it plays.
        for (let t = Math.ceil(scene.start / STEP) * STEP; t < scene.end; t += STEP) {
          await act(async () => clock.set(t));
          if (!(hold >= t && hold < t + STEP)) continue;
          const tabbable = [...host.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0).map((el) => el.outerHTML.slice(0, 80));
          expect(tabbable, `(k) in the tab order at ${t}s`).toEqual([]);
          // Point at everything, then wait out the hover delays: nothing may open.
          await act(async () => {
            for (const el of host.querySelectorAll("*")) hover(el);
            await new Promise((r) => setTimeout(r, HOVER_WAIT_MS));
          });
          expect([...w.document.body.children].filter((n) => !bodyBefore.includes(n) && n !== host), `(h) hover at ${t}s portalled to body`).toEqual([]);
          for (const live of host.querySelectorAll<HTMLElement>("[data-hero-live]")) {
            if (!live.isConnected) continue;
            await act(async () => {
              if (live instanceof w.HTMLInputElement || live instanceof w.HTMLTextAreaElement) {
                live.focus();
                live.value = "webhook retry";
                live.dispatchEvent(new w.Event("input", { bubbles: true }));
                live.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
                live.blur();
              } else {
                press(live);
              }
            });
            for (const el of [...live.querySelectorAll<HTMLElement>(CONTROLS)]) {
              if (!el.isConnected) continue;
              await act(async () => {
                // A visitor's press focuses what it lands on first, the way a browser does.
                el.focus();
                press(el);
                const at = w.document.activeElement;
                if (at instanceof w.HTMLElement && host.contains(at) && !at.matches("input, textarea, [contenteditable]")) focusKept.push(`${t}s ${at.outerHTML.slice(0, 80)}`);
                el.dispatchEvent(mouse("contextmenu"));
                for (const key of ["Enter", " "]) el.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
              });
            }
          }
          for (const row of [...host.querySelectorAll<HTMLElement>(MENU_ROWS)]) {
            await act(async () => void row.dispatchEvent(mouse("contextmenu")));
          }
          // Nothing the hero shows at a hold is still loading: every view it mounts is fed its data (a press may open more, like a trigger's run history).
          const loading = (host.textContent ?? "").match(/Loading[^.…]*…/g) ?? [];
          expect(loading, `still loading at ${scene.name}'s hold`).toEqual([]);
        }
      }, TIMEOUT_MS);
    }

    test("and nothing reached the app", async () => {
      // A mention pill pressed inside the hero, the way a fixture could one day render one.
      const mention = w.document.createElement("a");
      mention.className = "mention-inline";
      mention.setAttribute("href", "/team/hero");
      host.querySelector("[data-hero-sandbox]")!.append(mention);
      await act(async () => press(mention));
      mention.remove();
      // A link outside React's own tree, after the views have re-rendered under it, still never navigates.
      const stray = w.document.createElement("a");
      stray.setAttribute("href", "/pr/acme/billing/479");
      host.querySelector("[data-region]")!.append(stray);
      const click = mouse("click");
      await act(async () => void stray.dispatchEvent(click));
      expect(click.defaultPrevented, "a click on a link React does not own").toBe(true);
      stray.remove();

      // Every surface and region rendered, and no part fell into its boundary.
      for (const s of SURFACES) for (const name of Object.keys(s.regions)) expect(host.querySelector(`[data-region="${s.id}.${name}"]`), `${s.id}.${name}`).not.toBeNull();
      expect(errors.filter((e) => e.includes("ErrorBoundary:HeroFlythrough")), "no part failed").toEqual([]);

      await act(async () => root.unmount());
      host.remove();
      await act(async () => appRoot.unmount());
      appHost.remove();

      const after = store.getState();
      const changed = Object.keys(before).filter((k) => !Object.is(before[k], after[k]));
      expect(changed, "(a) store keys changed").toEqual([]);
      expect(idbWrites.length, "(b) IndexedDB writes").toBe(0);
      expect(enqueued.length, "(b) outbox entries").toBe(0);
      expect(dispatched.length, "(b) dispatches").toBe(0);
      expect(listeners.filter((l) => !LISTENER_ALLOWLIST.has(l.split(":")[1])), "(c) listeners outside the allowlist").toEqual([]);
      expect(watch).not.toHaveBeenCalled();
      for (const spy of convexCalls) expect(spy, "(d) Convex queries, mutations and actions").not.toHaveBeenCalled();
      expect(w.document.documentElement.className, "(e) html classes").toBe("dark minimal-style");
      expect(setItem).not.toHaveBeenCalled();
      expect([...new Set(reached)], "(g) events that reached the document").toEqual([]);
      expect([...w.document.body.children].filter((n) => !bodyBefore.includes(n) && n !== host), "(h) portalled to body").toEqual([]);
      expect(navigated, "(i) link activations").toEqual([]);
      expect(focusKept, "(k) focus left on a non-text control after a press").toEqual([]);
      expect(appPaths, "(g) the app's mention router navigated").toEqual(["/"]);
    }, TIMEOUT_MS);

    afterAll(() => {
      for (const spy of spies) spy.mockRestore();
    });
  });

  // (j) The visitor's own UI prefs reach nothing the hero draws. The film is
  // drawn twice, clock only: once with the store's initial prefs, once with
  // every pref flipped, where any read answers true (a boolean turned on,
  // anything else in a shape the view did not expect) and is recorded.
  test("the visitor's UI prefs change nothing the hero draws", async () => {
    const chapters = await loadAllChapters();
    const holds = SCENES.map((s) => s.hold + 1);
    const draw = async () => {
      const el = w.document.createElement("div");
      w.document.body.append(el);
      const root = createRoot(el);
      const clock = createFilmClock(0);
      await act(async () => {
        root.render(
          <MemoryRouter>
            <HeroSandbox>
              <FilmClockContext.Provider value={clock}>
                <World chapters={chapters} now={Date.UTC(2026, 8, 30, 12)} />
              </FilmClockContext.Provider>
            </HeroSandbox>
          </MemoryRouter>,
        );
      });
      const shots = new Map<number, string>();
      for (let t = 0; t < DURATION; t += STEP) {
        await act(async () => clock.set(t));
        if (holds.some((h) => h >= t && h < t + STEP)) shots.set(t, shape(el.innerHTML));
      }
      await act(async () => root.unmount());
      el.remove();
      return shots;
    };
    const real = store.getState().clientState;
    const plain = await draw();
    // Each pref read, with the first frame of the app's code that read it.
    const read = new Map<string, string>();
    const caller = () => (new Error().stack ?? "").split("\n").find((l) => /\/(components|hooks|lib)\//.test(l))?.trim() ?? "";
    const flipped = new Proxy({}, { get: (_, key) => (typeof key === "string" ? (read.has(key) || read.set(key, caller()), true) : undefined) });
    store.setState({ clientState: { ...real, ui: flipped } });
    let prefs: Map<number, string>;
    try {
      prefs = await draw();
    } finally {
      store.setState({ clientState: real });
    }
    // Where each differing hold first departs, so a failure names the view.
    const differ = [...plain].filter(([t, html]) => prefs.get(t) !== html).map(([t, html]) => {
      const other = prefs.get(t) ?? "";
      let i = 0;
      while (i < html.length && html[i] === other[i]) i++;
      return `${t}s: ${html.slice(Math.max(0, i - 120), i + 60)}\n   vs: ${other.slice(Math.max(0, i - 120), i + 60)}`;
    });
    expect(plain.size).toBe(SCENES.length);
    const reads = [...read].map(([k, at]) => `${k} (${at})`).join("; ") || "none";
    expect(differ, `holds drawn differently with the prefs flipped; prefs read: ${reads}`).toEqual([]);
  }, TIMEOUT_MS);

  // (j) A populated visitor reaches nothing the hero draws either. Views the
  // hero mounts read rows straight from the store (the channel rail its
  // roster, pins and call occupancy; a face its follow state; thread panels
  // and links the sessions; chat lines the channels; task rows their active
  // session and their team's statuses; a card its tick from the inbox
  // selection). The store is filled the
  // way a signed-in teammate's would be, keyed to the hero's own fixture ids
  // as the worst case (a fixture whose id collides with a real row), with
  // names no fixture uses: the holds must draw exactly as on an empty store,
  // and none of those names may appear.
  test("a populated visitor's rows change nothing the hero draws", async () => {
    const { CHANNELS } = await import("./fixtures/team");
    const { PEOPLE, SESSIONS } = await import("./fixtures/story");
    const { chatViewRoomKey } = await import("../../../lib/chatViews");
    const { useInboxSelection } = await import("../../../lib/inboxSelection");
    const { planTasks, PLAN } = await import("./fixtures/work");
    const chapters = await loadAllChapters();
    const holds = SCENES.map((s) => s.hold + 1);
    const draw = async () => {
      const el = w.document.createElement("div");
      w.document.body.append(el);
      const root = createRoot(el);
      const clock = createFilmClock(0);
      await act(async () => {
        root.render(
          <MemoryRouter>
            <HeroSandbox>
              <FilmClockContext.Provider value={clock}>
                <World chapters={chapters} now={Date.UTC(2026, 8, 30, 12)} />
              </FilmClockContext.Provider>
            </HeroSandbox>
          </MemoryRouter>,
        );
      });
      const shots = new Map<number, string>();
      const text: string[] = [];
      for (let t = 0; t < DURATION; t += STEP) {
        await act(async () => clock.set(t));
        if (holds.some((h) => h >= t && h < t + STEP)) {
          shots.set(t, shape(el.innerHTML));
          text.push(el.textContent ?? "");
        }
      }
      await act(async () => root.unmount());
      el.remove();
      return { shots, text: text.join("\n") };
    };
    const plain = await draw();

    const SEEDED = ["Visitorname Zelda", "Seededmate Quentin", "visitor-secret-channel", "Visitor secret session", "Visitor secret task", "Visitor secret plan", "Visitorstatus Ophelia"];
    const viewer = { _id: "visitor-u", name: SEEDED[0], email: "zelda@visitor.test", active_team_id: "visitor-team" };
    const members = [viewer, { _id: "visitor-tm", name: SEEDED[1] }, ...Object.values(PEOPLE).map((p) => ({ _id: p.id, name: SEEDED[1] }))];
    const sessions = Object.fromEntries(Object.values(SESSIONS).map((s) => [s.id, { _id: s.id, title: SEEDED[3], agent_type: "claude_code", thread_state: SEEDED[3], updated_at: 1 }]));
    const chatChannels = Object.fromEntries(CHANNELS.map((c) => [c.id, { _id: c.id, name: SEEDED[2], team_id: "visitor-team" }]));
    const occupant = [{ user_id: "visitor-tm", name: SEEDED[1] }];
    const callOccupancy = Object.fromEntries(CHANNELS.map((c) => [chatViewRoomKey(c as any, viewer._id, members), occupant]));
    const taskIds = [...planTasks(Date.UTC(2026, 8, 30, 12), true).map((t) => t._id as string), "hero-task-1"];
    const tasks = Object.fromEntries(taskIds.map((id) => [id, { _id: id, title: SEEDED[4], status: "visitor_status", team_id: "visitor-team", updated_at: 1 }]));
    const taskActiveSessions = Object.fromEntries(taskIds.map((id) => [id, { conversation_id: "visitor-s", session_id: "visitor-s-sess", title: SEEDED[3], started_by: SEEDED[0] }]));
    const teams = [{ _id: "visitor-team", name: SEEDED[2], task_statuses: [{ key: "visitor_status", label: SEEDED[6], category: "started" }] }];
    const conversations = Object.fromEntries(Object.values(SESSIONS).map((s) => [s.id, { _id: s.id, title: SEEDED[3], user_id: "visitor-tm", author_name: SEEDED[1], updated_at: 1 }]));
    const plans = { [PLAN._id]: { _id: PLAN._id, short_id: PLAN.short_id, title: SEEDED[5], status: "active" } };
    // The visitor has cards ticked in their inbox, one with a fixture's id.
    const selection = [SESSIONS.lead.id, "visitor-s"];
    const prev = store.getState();
    const real = { currentUser: prev.currentUser, teamMembers: prev.teamMembers, sessions: prev.sessions, chatChannels: prev.chatChannels, callOccupancy: prev.callOccupancy, followLeaderId: prev.followLeaderId, clientState: prev.clientState, tasks: prev.tasks, taskActiveSessions: prev.taskActiveSessions, teams: prev.teams, conversations: prev.conversations, plans: prev.plans };
    const realSelection = useInboxSelection.getState().ids;
    useInboxSelection.getState().set(selection);
    store.setState({
      tasks: { ...prev.tasks, ...tasks },
      taskActiveSessions: { ...prev.taskActiveSessions, ...taskActiveSessions },
      teams,
      conversations: { ...prev.conversations, ...conversations },
      plans: { ...prev.plans, ...plans },
      currentUser: viewer,
      teamMembers: members,
      sessions: { ...prev.sessions, ...sessions },
      chatChannels: { ...prev.chatChannels, ...chatChannels },
      callOccupancy,
      followLeaderId: PEOPLE.maya.id,
      clientState: { ...prev.clientState, ui: { ...prev.clientState?.ui, sidebar_pins: CHANNELS.map((c) => ({ kind: "channel", id: c.id })) } },
    });
    let seeded: Awaited<ReturnType<typeof draw>>;
    let selectionAfter: string[];
    try {
      seeded = await draw();
      selectionAfter = useInboxSelection.getState().ids;
    } finally {
      store.setState(real);
      useInboxSelection.getState().set(realSelection);
    }
    expect(selectionAfter, "the visitor's inbox selection").toEqual(selection);
    const differ = [...plain.shots].filter(([t, html]) => seeded.shots.get(t) !== html).map(([t, html]) => {
      const other = seeded.shots.get(t) ?? "";
      let i = 0;
      while (i < html.length && html[i] === other[i]) i++;
      return `${t}s: ${html.slice(Math.max(0, i - 120), i + 60)}\n   vs: ${other.slice(Math.max(0, i - 120), i + 60)}`;
    });
    expect(differ, "holds drawn differently over a populated visitor").toEqual([]);
    expect(SEEDED.filter((name) => seeded.text.includes(name)), "visitor names on screen").toEqual([]);
  }, TIMEOUT_MS);
});
