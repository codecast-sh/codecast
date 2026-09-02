import { test, expect, describe } from "bun:test";
import {
  buildDesktopDeepLink,
  parseDesktopDeepLinkPath,
  isHandoffEligiblePath,
  shouldAttemptHandoff,
  extractDeepLinkIntent,
  shouldApplyAutoDeepLink,
  shouldAttemptPreBootHandoff,
  conversationIdFromPath,
  isDesktopShell,
  HANDOFF_MIRROR_DEV,
  type HandoffContext,
  type PreBootHandoffContext,
} from "./desktop";

// A context that passes every gate; each test overrides one field to prove that
// field is load-bearing.
const PASSING: HandoffContext = {
  isDesktop: false,
  initialized: true,
  hasUsedDesktop: true,
  preferBrowser: false,
  isTopWindow: true,
  foreground: true,
  host: "codecast.sh",
  freshNavigation: true,
  path: "/conversation/jx7c89",
  search: "",
  skippedUrl: null,
};

describe("buildDesktopDeepLink", () => {
  test("nests the route under the 'open' host", () => {
    expect(buildDesktopDeepLink("/conversation/jx7c89")).toBe("codecast://open/conversation/jx7c89");
  });

  test("preserves the query string", () => {
    expect(buildDesktopDeepLink("/tasks/ct-1?tab=files")).toBe("codecast://open/tasks/ct-1?tab=files");
  });

  test("tolerates a path missing its leading slash", () => {
    expect(buildDesktopDeepLink("plans/pl-9")).toBe("codecast://open/plans/pl-9");
  });
});

describe("parseDesktopDeepLinkPath", () => {
  test("round-trips a built link, keeping the full path", () => {
    const link = buildDesktopDeepLink("/conversation/jx7c89");
    expect(parseDesktopDeepLinkPath(link)).toBe("/conversation/jx7c89");
  });

  test("round-trips a link with a query string", () => {
    const link = buildDesktopDeepLink("/tasks/ct-1?tab=files");
    expect(parseDesktopDeepLinkPath(link)).toBe("/tasks/ct-1?tab=files");
  });

  // The bug the 'open' host guards against: a bare scheme parses the first
  // segment as the host. We still recover it rather than dropping it.
  test("recovers the legacy host-as-segment shape", () => {
    expect(parseDesktopDeepLinkPath("codecast://conversation/jx7c89")).toBe("/conversation/jx7c89");
  });

  test("handles a triple-slash (empty host) link", () => {
    expect(parseDesktopDeepLinkPath("codecast:///conversation/jx7c89")).toBe("/conversation/jx7c89");
  });

  test("returns null when there's no navigable path", () => {
    expect(parseDesktopDeepLinkPath("codecast://open")).toBeNull();
    expect(parseDesktopDeepLinkPath("codecast://open/")).toBeNull();
  });

  test("returns null for an unparseable url", () => {
    expect(parseDesktopDeepLinkPath("not a url")).toBeNull();
  });
});

describe("isHandoffEligiblePath", () => {
  test("allows content routes", () => {
    expect(isHandoffEligiblePath("/conversation/jx7c89")).toBe(true);
    expect(isHandoffEligiblePath("/tasks/ct-1")).toBe(true);
    expect(isHandoffEligiblePath("/")).toBe(true);
  });

  test("blocks auth, share, artifact, palette, download and api routes", () => {
    expect(isHandoffEligiblePath("/login")).toBe(false);
    expect(isHandoffEligiblePath("/auth/callback")).toBe(false);
    expect(isHandoffEligiblePath("/oauth/github")).toBe(false);
    expect(isHandoffEligiblePath("/share/abc")).toBe(false);
    expect(isHandoffEligiblePath("/a/wbYnhK4Qv9zw")).toBe(false);
    expect(isHandoffEligiblePath("/palette")).toBe(false);
    expect(isHandoffEligiblePath("/download/mac")).toBe(false);
    expect(isHandoffEligiblePath("/api/x")).toBe(false);
  });
});

describe("shouldAttemptHandoff", () => {
  test("fires for a fresh deep link when the user owns the app", () => {
    expect(shouldAttemptHandoff(PASSING)).toBe(true);
  });

  test("never fires inside the desktop app itself", () => {
    expect(shouldAttemptHandoff({ ...PASSING, isDesktop: true })).toBe(false);
  });

  test("waits for synced prefs to load", () => {
    expect(shouldAttemptHandoff({ ...PASSING, initialized: false })).toBe(false);
  });

  test("requires that the user has used the desktop app", () => {
    expect(shouldAttemptHandoff({ ...PASSING, hasUsedDesktop: false })).toBe(false);
  });

  test("respects a remembered 'stay in browser' choice", () => {
    expect(shouldAttemptHandoff({ ...PASSING, preferBrowser: true })).toBe(false);
  });

  test("ignores non-top-level (iframe) windows", () => {
    expect(shouldAttemptHandoff({ ...PASSING, isTopWindow: false })).toBe(false);
  });

  test("stays inert in background / unfocused tabs (the agent-tab jump fix)", () => {
    expect(shouldAttemptHandoff({ ...PASSING, foreground: false })).toBe(false);
  });

  test("fires only on the production host — never local dev (agent tabs live there) or foreign hosts", () => {
    expect(shouldAttemptHandoff({ ...PASSING, host: "codecast.sh" })).toBe(true);
    expect(shouldAttemptHandoff({ ...PASSING, host: "www.codecast.sh" })).toBe(true);
    expect(shouldAttemptHandoff({ ...PASSING, host: "local.codecast.sh" })).toBe(false);
    expect(shouldAttemptHandoff({ ...PASSING, host: "localhost:5173" })).toBe(false);
    expect(shouldAttemptHandoff({ ...PASSING, host: "127.0.0.1:5173" })).toBe(false);
    expect(shouldAttemptHandoff({ ...PASSING, host: "evil.example.com" })).toBe(false);
  });

  test("respects reload / back-forward (only fires on fresh navigation)", () => {
    expect(shouldAttemptHandoff({ ...PASSING, freshNavigation: false })).toBe(false);
  });

  test("skips auth/share/etc. paths", () => {
    expect(shouldAttemptHandoff({ ...PASSING, path: "/share/abc" })).toBe(false);
    expect(shouldAttemptHandoff({ ...PASSING, path: "/login" })).toBe(false);
  });

  test("skips oauth callbacks carrying code + state", () => {
    expect(shouldAttemptHandoff({ ...PASSING, path: "/", search: "?code=abc&state=xyz" })).toBe(false);
  });

  test("respects 'use the browser for this page', matched on the full url", () => {
    const c = { ...PASSING, path: "/conversation/jx7c89", search: "?m=5" };
    expect(shouldAttemptHandoff({ ...c, skippedUrl: "/conversation/jx7c89?m=5" })).toBe(false);
    // A different page in the same tab still hands off.
    expect(shouldAttemptHandoff({ ...c, skippedUrl: "/conversation/other" })).toBe(true);
  });
});

// The gate that runs inlined in <head>, before any app chunk is fetched. It
// reads a localStorage mirror of the two synced preferences because those don't
// exist yet — the whole point is that the app never boots.
describe("shouldAttemptPreBootHandoff", () => {
  const PRE: PreBootHandoffContext = {
    mirror: "1",
    isDesktopShell: false,
    isTopWindow: true,
    foreground: true,
    host: "codecast.sh",
    freshNavigation: true,
    path: "/conversation/jx7c89",
    search: "",
    skippedUrl: null,
  };

  test("fires when the mirror says this browser owns the app", () => {
    expect(shouldAttemptPreBootHandoff(PRE)).toBe(true);
  });

  test("never fires without a mirror — the React path handles the first visit", () => {
    expect(shouldAttemptPreBootHandoff({ ...PRE, mirror: null })).toBe(false);
    expect(shouldAttemptPreBootHandoff({ ...PRE, mirror: "" })).toBe(false);
  });

  test("never fires inside the desktop app, which loads this same html", () => {
    expect(shouldAttemptPreBootHandoff({ ...PRE, isDesktopShell: true })).toBe(false);
  });

  test("the 'dev' mirror value opts a local host in, for verification only", () => {
    expect(shouldAttemptPreBootHandoff({ ...PRE, host: "local.codecast.sh" })).toBe(false);
    expect(shouldAttemptPreBootHandoff({ ...PRE, host: "local.codecast.sh", mirror: HANDOFF_MIRROR_DEV })).toBe(true);
  });

  // Everything else is the full gate's business; spot-check that it is really
  // delegating rather than re-deciding.
  test("inherits the full gate's rules", () => {
    expect(shouldAttemptPreBootHandoff({ ...PRE, foreground: false })).toBe(false);
    expect(shouldAttemptPreBootHandoff({ ...PRE, freshNavigation: false })).toBe(false);
    expect(shouldAttemptPreBootHandoff({ ...PRE, isTopWindow: false })).toBe(false);
    expect(shouldAttemptPreBootHandoff({ ...PRE, path: "/share/abc" })).toBe(false);
    expect(shouldAttemptPreBootHandoff({ ...PRE, path: "/", search: "?code=a&state=b" })).toBe(false);
    expect(shouldAttemptPreBootHandoff({ ...PRE, skippedUrl: "/conversation/jx7c89" })).toBe(false);
  });
});

// Auto-handoff deep links carry a marker so the DESKTOP can apply policy: a
// machine-initiated handoff may not move the view while the user is actively
// working in the app (agent-driven Chrome tabs satisfy every browser-side
// gate — the "desktop randomly jumps to whatever the agent opened" bug).
describe("auto-handoff deep-link intent", () => {
  test("manual links carry no marker and parse as not-auto", () => {
    const url = buildDesktopDeepLink("/conversation/x");
    expect(url).toBe("codecast://open/conversation/x");
    expect(extractDeepLinkIntent("/conversation/x")).toEqual({ path: "/conversation/x", auto: false });
  });

  test("auto links round-trip the marker and strip it from the path", () => {
    const url = buildDesktopDeepLink("/conversation/x", { auto: true });
    const parsed = parseDesktopDeepLinkPath(url)!;
    expect(extractDeepLinkIntent(parsed)).toEqual({ path: "/conversation/x", auto: true });
  });

  test("the marker composes with existing query params and preserves them", () => {
    const url = buildDesktopDeepLink("/conversation/x?m=5", { auto: true });
    const parsed = parseDesktopDeepLinkPath(url)!;
    expect(extractDeepLinkIntent(parsed)).toEqual({ path: "/conversation/x?m=5", auto: true });
  });

  test("auto navigation applies only after the desktop has been quiet", () => {
    const now = 1_000_000;
    expect(shouldApplyAutoDeepLink(now, now - 5_000)).toBe(false);  // user mid-work
    expect(shouldApplyAutoDeepLink(now, now - 60_000)).toBe(true);  // idle desktop
  });
});

describe("conversationIdFromPath", () => {
  test("extracts the id from a conversation path, dropping query and hash", () => {
    expect(conversationIdFromPath("/conversation/jx7abc123")).toBe("jx7abc123");
    expect(conversationIdFromPath("/conversation/jx7abc123?m=5")).toBe("jx7abc123");
    expect(conversationIdFromPath("/conversation/jx7abc123#msg-1")).toBe("jx7abc123");
  });

  test("returns null for non-conversation pages", () => {
    expect(conversationIdFromPath("/tasks/ct-1")).toBeNull();
    expect(conversationIdFromPath("/conversation/")).toBeNull();
    expect(conversationIdFromPath("/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-window notification role. Outside the desktop shell this window is the
// only one (leader). Inside it, the shell pushes the role and answers whether a
// banner request was the one that showed — so a sound pairs with one banner.
// ---------------------------------------------------------------------------
import {
  getDesktopWindowRole,
  isNotificationLeader,
  installWindowRoleTracker,
  notifyNative,
  reportDesktopWindowState,
  isPeopleWindow,
  hasPeopleWindow,
  isCallPanelWindow,
  hasCallPanel,
  canPopOutCall,
  callPanelRoute,
  subscribeWindowRole,
  navigateMainWindow,
} from "./desktop";

describe("desktop window role", () => {
  test("defaults to leader with no shell", () => {
    expect(isNotificationLeader()).toBe(true);
    expect(getDesktopWindowRole()).toEqual({
      leader: true,
      appFocused: false,
      anyInCall: false,
      peopleWindow: false,
      callPanel: false,
      facesOverlay: false,
    });
  });

  test("tracks the shell's pushes and reports state through the bridge", async () => {
    let roleCb: ((r: any) => void) | null = null;
    const reported: any[] = [];
    const shown: any[] = [];
    const g = globalThis as any;
    const prevWindow = g.window;
    const prevDocument = g.document;
    g.window = {
      __CODECAST_ELECTRON__: {
        onWindowRole: (cb: any) => { roleCb = cb; },
        reportWindowState: (s: any) => reported.push(s),
        showNotification: async (title: string, _body: string, data: any) => {
          shown.push({ title, data });
          return { shown: data.key === "first" };
        },
      },
    };
    g.document = { hasFocus: () => false };
    try {
      installWindowRoleTracker();
      expect(roleCb).not.toBeNull();
      // A surface that DRAWS the role (the pin, the "call is elsewhere" pill)
      // has to learn when it changes; the sound paths only ever ask.
      let woke = 0;
      const unsubscribe = subscribeWindowRole(() => { woke += 1; });
      roleCb!({ leader: false, appFocused: true, anyInCall: true, peopleWindow: true });
      expect(woke).toBe(1);
      expect(isNotificationLeader()).toBe(false);
      expect(getDesktopWindowRole().anyInCall).toBe(true);
      // A people window elsewhere: this window knows without being one.
      expect(getDesktopWindowRole().peopleWindow).toBe(true);
      expect(isPeopleWindow()).toBe(false);
      expect(hasPeopleWindow()).toBe(true);
      // The call panel reads the same way, and a shell that never mentions it
      // (an older build) means "no panel", never undefined.
      expect(getDesktopWindowRole().callPanel).toBe(false);
      expect(hasCallPanel()).toBe(false);
      roleCb!({ leader: false, appFocused: true, anyInCall: true, peopleWindow: true, callPanel: true });
      expect(hasCallPanel()).toBe(true);
      expect(isCallPanelWindow()).toBe(false);

      reportDesktopWindowState({ active: "/chat/a", open: [{ id: "t1", path: "/chat/a" }], inCall: false });
      expect(reported).toEqual([{ active: "/chat/a", open: [{ id: "t1", path: "/chat/a" }], inCall: false }]);

      // The shell decides who announced: the same key from two windows shows once.
      expect(await notifyNative("t", "b", { key: "first", route: "/chat/a?m=1" })).toBe(true);
      expect(await notifyNative("t", "b", { key: "dup", route: "/chat/a?m=1" })).toBe(false);
      // The route rides along, and a conversationId still becomes one.
      expect(shown[0].data.route).toBe("/chat/a?m=1");
      await notifyNative("t", "b", { conversationId: "c1", key: "first" });
      expect(shown[2].data.route).toBe("/conversation/c1");
      // A focused window never asks the shell.
      g.document = { hasFocus: () => true };
      expect(await notifyNative("t", "b", { key: "first" })).toBe(false);
      expect(shown.length).toBe(3);

      // An unsubscribed watcher stops being woken — a window that closed its
      // pin must not keep a dead callback alive for the life of the process.
      unsubscribe();
      const before = woke;
      roleCb!({ leader: false, appFocused: true, anyInCall: false, peopleWindow: true });
      expect(woke).toBe(before);
    } finally {
      // Module state is shared with any later test: hand the role back.
      roleCb!({ leader: true, appFocused: false, anyInCall: false });
      g.window = prevWindow;
      g.document = prevDocument;
    }
  });
});

describe("navigateMainWindow", () => {
  const g = globalThis as any;

  test("hands the path to the shell, which raises the main window", () => {
    const sent: string[] = [];
    const prev = g.window;
    g.window = { __CODECAST_ELECTRON__: { paletteNavigate: (p: string) => sent.push(p) } };
    try {
      expect(navigateMainWindow("/chat/c1")).toBe(true);
      expect(sent).toEqual(["/chat/c1"]);
    } finally {
      g.window = prev;
    }
  });

  test("in a browser popup, moves the opener and raises it", () => {
    const prev = g.window;
    const opener: any = { closed: false, location: { href: "/inbox" }, focused: 0 };
    opener.focus = () => { opener.focused += 1; };
    g.window = { opener };
    try {
      expect(navigateMainWindow("/chat/c1")).toBe(true);
      expect(opener.location.href).toBe("/chat/c1");
      expect(opener.focused).toBe(1);
    } finally {
      g.window = prev;
    }
  });

  test("reports failure with no other window, so the caller can move itself", () => {
    const prev = g.window;
    try {
      g.window = { opener: null };
      expect(navigateMainWindow("/chat/c1")).toBe(false);
      // An opener the user already closed is not a window either.
      g.window = { opener: { closed: true } };
      expect(navigateMainWindow("/chat/c1")).toBe(false);
    } finally {
      g.window = prev;
    }
  });

  test("a cross-origin opener is refused, not thrown at the caller", () => {
    const prev = g.window;
    g.window = {
      opener: {
        closed: false,
        get location() { throw new Error("cross-origin"); },
      },
    };
    try {
      expect(navigateMainWindow("/chat/c1")).toBe(false);
    } finally {
      g.window = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// The input tracker keeps TWO clocks and they must not merge. Presence asks
// "is a person here" and must count a trackpad scrolling a conversation; auto
// handoff asks "may I move the view" and must not be blocked for ever by a
// resting hand nudging the mouse. One clock served both, so a reader who did
// not click for INPUT_ACTIVE_MS (3 min) went idle to their whole team while
// visibly using the app.
// ---------------------------------------------------------------------------
import {
  installDesktopInputTracker,
  getLastDesktopInputAt,
  getLastDesktopActivityAt,
  getIdleMs,
} from "./desktop";

describe("desktop input vs activity", () => {
  test("a wheel or a moved pointer is activity but not input", async () => {
    const g = globalThis as any;
    const prevWindow = g.window;
    const prevDocument = g.document;
    const handlers: Record<string, () => void> = {};
    g.window = {
      addEventListener: (type: string, fn: () => void) => { handlers[type] = fn; },
      removeEventListener: () => {},
    };
    g.document = { ...(prevDocument ?? {}) };
    try {
      installDesktopInputTracker();
      expect(Object.keys(handlers).sort()).toEqual(["keydown", "pointerdown", "pointermove", "wheel"]);

      // Scroll first and never click: the case that used to read as idle.
      // Nothing has been committed, so the handoff clock must stay at zero
      // while presence already knows a person is here.
      expect(getLastDesktopInputAt()).toBe(0);
      handlers.wheel();
      expect(getLastDesktopActivityAt()).toBeGreaterThan(0);
      expect(getLastDesktopInputAt()).toBe(0);
      expect(await getIdleMs(0)).toBeLessThan(5_000);

      handlers.pointermove();
      expect(getLastDesktopInputAt()).toBe(0);

      // A click commits, and moves both.
      handlers.pointerdown();
      const clickedAt = getLastDesktopInputAt();
      expect(clickedAt).toBeGreaterThan(0);
      expect(getLastDesktopActivityAt()).toBe(clickedAt);
    } finally {
      g.window = prevWindow;
      g.document = prevDocument;
    }
  });
});


describe("the call panel's route", () => {
  test("carries the room, and only the state that is actually on", () => {
    // A room key is not a path segment — every kind of them carries colons —
    // so it rides the query string, encoded.
    expect(callPanelRoute("dm:kd764ed:kd777yp")).toBe(
      "/call-panel?room=dm%3Akd764ed%3Akd777yp",
    );
    // Absent flags mean absent state. The panel reads "mic=1" and nothing
    // else as "unmuted", so an omitted flag can never be misread as on.
    expect(callPanelRoute("session:abc", { mic: true })).toBe(
      "/call-panel?room=session%3Aabc&mic=1",
    );
    expect(callPanelRoute("session:abc", { mic: true, camera: true, scribe: true })).toBe(
      "/call-panel?room=session%3Aabc&mic=1&cam=1&scribe=1",
    );
    expect(callPanelRoute("session:abc", { mic: false, camera: false, scribe: false })).toBe(
      "/call-panel?room=session%3Aabc",
    );
  });

  test("a browser is offered no popout at all", () => {
    const g = globalThis as any;
    const prev = g.window;
    // No shell: this is a plain browser tab. Every other popout in the app
    // degrades to window.open here; a call refuses to, so the CONTROL has to
    // be absent rather than the fallback silent.
    g.window = {};
    try {
      expect(canPopOutCall()).toBe(false);
      expect(isCallPanelWindow()).toBe(false);
      expect(hasCallPanel()).toBe(false);
    } finally {
      g.window = prev;
    }
  });

  test("the panel itself is not offered its own popout", () => {
    const g = globalThis as any;
    const prev = g.window;
    g.window = { __CODECAST_ELECTRON__: { isCallPanelWindow: true } };
    try {
      expect(isCallPanelWindow()).toBe(true);
      // It already IS the window, so there is no gesture to make.
      expect(canPopOutCall()).toBe(false);
      // And it answers "a panel exists" for itself, before any shell push.
      expect(hasCallPanel()).toBe(true);
    } finally {
      g.window = prev;
    }
  });

  test("a desktop window that is not the panel is offered it", () => {
    const g = globalThis as any;
    const prev = g.window;
    g.window = { __CODECAST_ELECTRON__: { platform: "darwin" } };
    try {
      expect(canPopOutCall()).toBe(true);
    } finally {
      g.window = prev;
    }
  });
});

// The bridge is the one thing that can go missing inside the app: 1.1.100's
// preload threw before exposing it, and every surface that asked "am I in the
// desktop?" with that global answered "no" — which sent window.open, and with
// it the people window, out to Chrome. This asks the user agent instead.
describe("isDesktopShell", () => {
  const realNav = globalThis.navigator;
  const setUserAgent = (ua: string) =>
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: ua }, configurable: true });
  const restore = () =>
    Object.defineProperty(globalThis, "navigator", { value: realNav, configurable: true });

  test("sees the shell through a dead preload", () => {
    setUserAgent("Mozilla/5.0 (Macintosh) Codecast/1.1.100 Chrome/140 Electron/38.0.0 Safari/537.36");
    try {
      expect((globalThis as any).window?.__CODECAST_ELECTRON__).toBeUndefined();
      expect(isDesktopShell()).toBe(true);
    } finally {
      restore();
    }
  });

  test("a plain browser is still a browser", () => {
    setUserAgent("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36");
    try {
      expect(isDesktopShell()).toBe(false);
    } finally {
      restore();
    }
  });
});
