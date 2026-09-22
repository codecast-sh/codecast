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

/**
 * Say what happened when a rung was missing, in the two sentences a person
 * needs. Both failures used to be silent, and each read as a dead button: a
 * blocked popup made people press again instead of looking at the address
 * bar, and an old desktop build quietly opened a Chrome window beside the app.
 *
 * The retry offered on a blocked popup is a plain tab rather than another
 * popup, and it fires from the toast's own click, so it carries a fresh user
 * gesture and the blocker lets it through. `toast` is passed in so this module
 * keeps no UI import and stays testable.
 */
export function explainPopOut(
  outcome: PopOutOutcome,
  what: { thing: string; route: string; name: string },
  toast: { error: (title: string, opts: { description: string; action?: { label: string; onClick: () => void } }) => unknown },
): void {
  if (outcome === "needs-update") {
    toast.error("The desktop app needs an update for this", {
      description: `This build cannot open ${what.thing} in a window of its own. Update Codecast and it will.`,
    });
  } else if (outcome === "blocked") {
    toast.error(`Your browser blocked ${what.thing}`, {
      description: "Allow popups for this site, or open it as a tab instead.",
      action: { label: "Open as a tab", onClick: () => window.open(what.route, what.name) },
    });
  }
}

/**
 * The same page as a plain browser tab, outside every shell.
 *
 * Inside the desktop app the bridge hands the URL to the operating system,
 * which is the one way out of Electron that lands in the person's own browser.
 * A build too old for that verb reports it rather than opening a Chrome window
 * dressed as the app. In a browser it is a new tab.
 */
/** The toast for an `openInBrowser` that could not: one wording for every
 *  control that hands a page out of the app. `toast` is passed in, as above. */
export function explainOpenInBrowser(
  outcome: ReturnType<typeof openInBrowser>,
  toast: { error: (title: string, opts: { description: string }) => unknown },
): void {
  if (outcome !== "needs-update") return;
  toast.error("The desktop app needs an update for this", {
    description: "This build cannot hand a page to your browser. Update Codecast and it opens on its own.",
  });
}

export function openInBrowser(url: string): "opened" | "needs-update" {
  if (isDesktopShell()) {
    const openExternal = bridge("openExternal");
    if (!openExternal) return "needs-update";
    void openExternal(url);
    return "opened";
  }
  window.open(url, "_blank", "noopener");
  return "opened";
}
