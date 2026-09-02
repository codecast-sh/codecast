import { bridge, isDesktopShell } from "./desktop";

/**
 * Popping a surface out into a window of its own, on whatever build is running.
 *
 * The desktop app the person has is not the desktop app we just shipped. Build
 * 1.1.95 has no people-window IPC, so `bridge("openPeopleWindow")` was
 * undefined there and the button fell all the way through to `window.open` —
 * which inside Electron is a CHROME window, floating outside the app, with the
 * app's own chrome missing. The founder pressed it and got a browser.
 *
 * The fix is a ladder rather than a single fallback, because there is a real
 * rung between the two: detached tab windows shipped long ago, so almost every
 * build in the wild can open a route as a genuine app window even when it has
 * never heard of this particular one.
 *
 *   1. the shell's own window for this route (newest builds — a singleton the
 *      shell focuses on a second press)
 *   2. a detached tab window (older builds — still a real OS window)
 *   3. a browser popup — ONLY in a browser
 *
 * Inside the desktop app with neither verb, the ladder stops and says so. A
 * silent degrade into a browser popup is worse than nothing: it looks like the
 * feature is broken rather than like the app is old.
 *
 * Which is why "am I in the app" is `isDesktopShell()` — the user agent — and
 * NOT the bridge. On 1.1.100 the preload threw before exposing the bridge, so
 * every rung was missing AND the app looked like a browser: the ladder ran off
 * its end into window.open, Electron handed that to shell.openExternal, and the
 * roster opened as a Chrome tab. The rung that reports the truth is the one the
 * broken build cannot erase.
 */
export type PopOutOutcome =
  /** The shell opened (or focused) its own window for this route. */
  | "shell"
  /** An older shell broke the route out as a detached tab window. */
  | "detached"
  /** A browser popup, the only rung a browser has. */
  | "popup"
  /** A browser popup a blocker ate. */
  | "blocked"
  /** The desktop app is too old to know either verb. */
  | "needs-update";

export type PopOutRungs = {
  /** The shell's window for this exact route, when the build has one. */
  shellOpen?: () => Promise<void>;
  /** The shell's generic breakout, present on builds since detached tabs. */
  detach?: (path: string) => Promise<void>;
  /** Open the route as a browser popup; false when a blocker ate it. */
  openPopup: () => boolean;
  /** Running inside the desktop shell. */
  desktop: boolean;
};

/** The ladder itself, with nothing of the browser in it so it can be tested. */
export async function popOutVia(route: string, rungs: PopOutRungs): Promise<PopOutOutcome> {
  if (rungs.shellOpen) {
    await rungs.shellOpen();
    return "shell";
  }
  if (rungs.detach) {
    await rungs.detach(route);
    return "detached";
  }
  if (rungs.desktop) return "needs-update";
  return rungs.openPopup() ? "popup" : "blocked";
}

/**
 * The ladder wired to the live shell and browser.
 *
 * `shellOpen` is the caller's, because it names a route-specific verb —
 * `bridge("openPeopleWindow")` today, the call panel's own tomorrow — and the
 * two other rungs are the same for every surface.
 */
export async function popOutWindow(
  route: string,
  shellOpen: (() => Promise<void>) | undefined,
  popup: { name: string; width: number; height: number },
): Promise<PopOutOutcome> {
  return popOutVia(route, {
    shellOpen,
    detach: bridge("detachTab"),
    desktop: isDesktopShell(),
    // A NAMED popup, so a second click raises the window the first one opened
    // instead of stacking another.
    openPopup: () => {
      if (typeof window === "undefined") return false;
      const ref = window.open(route, popup.name, `popup,width=${popup.width},height=${popup.height}`);
      ref?.focus();
      return !!ref;
    },
  });
}
