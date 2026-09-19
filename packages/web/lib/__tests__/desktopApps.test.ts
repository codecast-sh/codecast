import { afterEach, describe, expect, it } from "bun:test";
import { installWindowRoleTracker } from "../desktop";
import { desktopAppWindow, hasAppWindow, routeElsewhere, runPlaced } from "../desktopApps";
import { divertNavigation, divertSessionOpen, endClickIntent } from "../openIntent";

// Chat and Work are windows of their own, and a path lands in the window that
// owns it whatever the entry point. The rule is asked at every navigation
// chokepoint; these pin what it answers from each kind of window.

const original = (globalThis as any).window;

/** Stand a desktop shell up: which app THIS window is, which app windows exist. */
function shell(opts: { appWindow?: string | null; apps?: Record<string, boolean>; verbs?: boolean } | null) {
  const sent: string[] = [];
  if (opts === null) {
    (globalThis as any).window = {};
    return sent;
  }
  const verbs = opts.verbs !== false;
  (globalThis as any).window = {
    __CODECAST_ELECTRON__: {
      appWindow: opts.appWindow ?? null,
      ...(verbs ? { routeNavigate: (p: string) => (sent.push(p), Promise.resolve(true)) } : {}),
      onWindowRole: (cb: (role: any) => void) => cb({ leader: true, apps: opts.apps ?? {} }),
    },
  };
  installWindowRoleTracker();
  return sent;
}

afterEach(() => {
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

  it("answers no in a browser and on a shell without the verb", () => {
    shell(null);
    expect(routeElsewhere("/chat/ch1")).toBe(false);
    expect(desktopAppWindow()).toBe(null);
    const sent = shell({ apps: { chat: true }, verbs: false });
    expect(routeElsewhere("/chat/ch1")).toBe(false);
    expect(sent).toEqual([]);
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
