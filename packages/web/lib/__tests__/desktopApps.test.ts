import { afterEach, describe, expect, it } from "bun:test";
import { installWindowRoleTracker } from "../desktop";
import { desktopAppWindow, hasAppWindow, routeElsewhere, runPlaced } from "../desktopApps";
import { divertNavigation, divertSessionOpen, endClickIntent } from "../openIntent";
import { installAppWindowRegistry, resetAppWindowRegistryForTests } from "../appWindowRegistry";

// Chat and Work are windows of their own, and a path lands in the window that
// owns it whatever the entry point. The rule is asked at every navigation
// chokepoint; these pin what it answers from each kind of window.

const original = (globalThis as any).window;

/** Stand a desktop shell up: which app THIS window is, which app windows exist. */
function shell(
  opts: { appWindow?: string | null; apps?: Record<string, boolean>; verbs?: boolean; tab?: boolean; path?: string } | null,
) {
  const sent: string[] = [];
  if (opts === null) {
    (globalThis as any).window = {};
    return sent;
  }
  const verbs = opts.verbs !== false;
  (globalThis as any).window = {
    location: { pathname: opts.path ?? "/inbox" },
    __CODECAST_ELECTRON__: {
      appWindow: opts.appWindow ?? null,
      isTabWindow: opts.tab === true,
      // An older shell has the palette verb and none of the app window ones.
      paletteNavigate: (p: string) => sent.push(`main:${p}`),
      ...(verbs ? { routeNavigate: (p: string) => (sent.push(p), Promise.resolve(true)), openAppWindow: () => Promise.resolve(true) } : {}),
      onWindowRole: (cb: (role: any) => void) => cb({ leader: true, apps: opts.apps ?? {} }),
    },
  };
  installWindowRoleTracker();
  return sent;
}

afterEach(() => {
  resetAppWindowRegistryForTests();
  endClickIntent();
  shell({ apps: {} }); // clear the role the last case pushed
  (globalThis as any).window = original;
});

describe("routeElsewhere", () => {
  it("hands a chat path to the Chat window from the main window, and keeps everything else", () => {
    const sent = shell({ apps: { chat: true } });
    expect(routeElsewhere("/chat/ch1?m=9")).toBe(true);
    expect(routeElsewhere("/calls")).toBe(true);
    expect(routeElsewhere("/inbox?s=c1")).toBe(false);
    expect(routeElsewhere("/tasks/ct-1")).toBe(false); // no Work window
    expect(sent).toEqual(["/chat/ch1?m=9", "/calls"]);
  });

  it("keeps chat in the main window while no Chat window exists", () => {
    const sent = shell({ apps: {} });
    expect(routeElsewhere("/chat/ch1")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("hands everything that is not chat out of the Chat window", () => {
    const sent = shell({ appWindow: "chat", apps: { chat: true } });
    expect(desktopAppWindow()).toBe("chat");
    expect(hasAppWindow("chat")).toBe(true);
    expect(routeElsewhere("/chat/ch2")).toBe(false);
    expect(routeElsewhere("/threads")).toBe(false);
    expect(routeElsewhere("/conversation/c1")).toBe(true);
    expect(routeElsewhere("/inbox?s=c1")).toBe(true);
    expect(routeElsewhere("/tasks/ct-1")).toBe(true);
    expect(sent).toEqual(["/conversation/c1", "/inbox?s=c1", "/tasks/ct-1"]);
  });

  it("never hands off a route outside the tab shell: settings opens as a modal where you are", () => {
    const sent = shell({ appWindow: "work", apps: { work: true } });
    expect(routeElsewhere("/settings/team")).toBe(false);
    expect(routeElsewhere("/people")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("stands down for a navigation the shell placed, so a path cannot bounce", () => {
    const sent = shell({ apps: { chat: true } });
    expect(runPlaced(() => routeElsewhere("/chat/ch1"))).toBe(false);
    expect(routeElsewhere("/chat/ch1")).toBe(true);
    expect(sent).toEqual(["/chat/ch1"]);
  });

  it("answers no in a browser and, from the main window, on a shell without the verb", () => {
    shell(null);
    expect(routeElsewhere("/chat/ch1")).toBe(false);
    expect(desktopAppWindow()).toBe(null);
    const sent = shell({ apps: { chat: true }, verbs: false });
    expect(routeElsewhere("/chat/ch1")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("on an older shell, a breakout showing a chat route is the Chat window and hands the rest to main", () => {
    // The shipped build: no app windows, so the popout fell down the ladder
    // to a plain breakout of /chat. That window must still be Chat.
    const sent = shell({ verbs: false, tab: true, path: "/chat/ch1" });
    expect(desktopAppWindow()).toBe("chat");
    expect(desktopAppWindow("/tasks")).toBe("work");
    expect(routeElsewhere("/chat/ch2")).toBe(false);
    expect(routeElsewhere("/conversation/c1")).toBe(true);
    expect(routeElsewhere("/tasks/ct-1")).toBe(true);
    expect(sent).toEqual(["main:/conversation/c1", "main:/tasks/ct-1"]);
    // A breakout on a route no app owns is a plain window.
    expect(desktopAppWindow("/feed")).toBe(null);
  });

  it("on an older shell, the main window hands a chat path to a Chat window the windows themselves announced", async () => {
    const sent = shell({ verbs: false, path: "/inbox" });
    (globalThis as any).window.addEventListener = () => {};
    installAppWindowRegistry(() => {});
    const chatWindow = new BroadcastChannel("codecast-app-windows");
    const heard: any[] = [];
    chatWindow.onmessage = (e) => heard.push(e.data);
    chatWindow.postMessage({ type: "hello", app: "chat" });
    await new Promise((r) => setTimeout(r, 10));
    expect(hasAppWindow("chat")).toBe(true);
    expect(routeElsewhere("/chat/ch1")).toBe(true);
    expect(routeElsewhere("/tasks")).toBe(false); // no Work window anywhere
    await new Promise((r) => setTimeout(r, 10));
    expect(heard).toEqual([{ type: "open", app: "chat", path: "/chat/ch1" }]);
    expect(sent).toEqual([]);
    chatWindow.close();
  });

  it("on a shell with app windows, a plain breakout never becomes one by its route alone", () => {
    shell({ tab: true, path: "/chat/ch1", apps: {} });
    expect(desktopAppWindow()).toBe(null);
  });
});

describe("divertNavigation", () => {
  it("hands the path off once per click: sibling navigations stand down without a second send", () => {
    const sent = shell({ appWindow: "chat", apps: { chat: true } });
    // useOpenSession: navigateToSession, then router.push of the same session.
    expect(divertNavigation("/inbox?s=c1")).toBe(true);
    expect(divertNavigation("/inbox?s=c1")).toBe(true);
    expect(sent).toEqual(["/inbox?s=c1"]);
  });

  it("hands a plain click on a session out of the Chat window (no modifier held)", () => {
    const sent = shell({ appWindow: "chat", apps: { chat: true } });
    expect(divertSessionOpen("c1")).toBe(true);
    expect(sent).toEqual(["/inbox?s=c1"]);
  });

  it("keeps a plain session click in the main window", () => {
    const sent = shell({ apps: { chat: true, work: true } });
    expect(divertSessionOpen("c1")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("lets a canonicalizing replace through", () => {
    const sent = shell({ apps: { chat: true } });
    expect(divertNavigation("/chat/ch1", { openable: false })).toBe(false);
    expect(sent).toEqual([]);
  });
});
