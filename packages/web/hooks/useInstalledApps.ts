// Installed apps from React: the desktop bridge (desktopApps), the list of
// apps installed on this computer, and the "Install as app" act every Share
// menu runs. The list is the desktop's own registry, read over the bridge;
// it never passes through the store, because it is a fact of this computer,
// not server data.
import { createContext, useCallback, useContext, useRef, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { desktopApps } from "../lib/desktop";
import { installDeepLink, type AppInfo, type DesktopAppsBridge, type GateKeys, type InstalledApp } from "../lib/installedApps";
import { useWatchEffect } from "./useWatchEffect";

const BRIDGE_EVENT = "codecast-apps-bridge";
const subscribeBridge = (cb: () => void) => {
  window.addEventListener(BRIDGE_EVENT, cb);
  return () => window.removeEventListener(BRIDGE_EVENT, cb);
};

/** True inside a surface that must not reach this computer's apps (the marketing hero's sandbox). */
export const InstalledAppsOff = createContext(false);
const noBridge = () => null;
const subscribeNothing = () => () => {};

/** The installed-app host, or null outside the desktop app. */
export function useDesktopApps(): DesktopAppsBridge | null {
  const off = useContext(InstalledAppsOff);
  return useSyncExternalStore(off ? subscribeNothing : subscribeBridge, off ? noBridge : desktopApps, noBridge);
}

/** Every app installed on this computer, live; null while the first answer is on its way or outside the desktop app. */
export function useInstalledApps(): InstalledApp[] | null {
  const apps = useDesktopApps();
  const [list, setList] = useState<InstalledApp[] | null>(null);
  useWatchEffect(() => {
    if (!apps) return;
    let live = true;
    void apps.list().then((l) => { if (live) setList(l); }, () => { if (live) setList([]); });
    const off = apps.onChange((l) => setList(l));
    return () => { live = false; off(); };
  }, [apps]);
  return apps ? list : null;
}

/** How long a browser waits for the desktop app to take the install link before offering the download. */
export const HANDOFF_WAIT_MS = 1500;

/**
 * Hands `url` to whatever handles its scheme and reports whether anything
 * did: a handler takes focus from the page (the app comes forward, or the
 * browser asks to open it), and nothing happening within the wait means
 * nothing on this computer handles it.
 */
export function handOff(url: string, wait = HANDOFF_WAIT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (handled: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("blur", taken);
      document.removeEventListener("visibilitychange", taken);
      resolve(handled);
    };
    const taken = () => finish(true);
    const timer = setTimeout(() => finish(document.visibilityState === "hidden"), wait);
    window.addEventListener("blur", taken);
    document.addEventListener("visibilitychange", taken);
    // A dev build can stand in for a computer without the desktop app (lib/installedAppsDevFake.ts, ?appsFake=nohandler); nothing else sets this.
    if ((window as { __CODECAST_NO_DESKTOP__?: boolean }).__CODECAST_NO_DESKTOP__) return;
    window.location.href = url;
  });
}

export type InstallAsApp = {
  /** Start the install: the sheet in the desktop app, the handoff in a browser. */
  install: () => void;
  /** The browser found no desktop app to take the link: show the download choice. */
  fallback: boolean;
  closeFallback: () => void;
  /** Send the link again (after installing the desktop app). */
  retry: () => void;
};

/** The "Install as app" act for one page. `gate` carries a gated page's keys when the caller holds them. */
export function useInstallAsApp(slug: string, gate: GateKeys = {}): InstallAsApp {
  const convex = useConvex();
  const [fallback, setFallback] = useState(false);
  // A handoff judged taken only because the page lost focus (a tab switch, the address bar) may have reached nothing.
  const judgedTaken = useRef(false);
  const { k, e, m } = gate;
  const handoff = useCallback(() => {
    void handOff(installDeepLink(slug, { k, e, m })).then((handled) => {
      judgedTaken.current = handled;
      setFallback(!handled);
    });
  }, [slug, k, e, m]);
  // The bridge is read at the press, not subscribed: a card that only offers
  // the act has no reason to listen for the bridge arriving.
  const install = useCallback(() => {
    const apps = desktopApps();
    if (apps) return void installFromDesktop(convex, apps, slug, { k, e, m });
    // Asking again after a handoff that seemed taken means it was not: offer the download choice, which can still retry.
    if (judgedTaken.current) {
      judgedTaken.current = false;
      return setFallback(true);
    }
    handoff();
  }, [convex, handoff, slug, k, e, m]);
  return { install, fallback, closeFallback: () => setFallback(false), retry: handoff };
}

/** Read the page's app info as the signed-in person and open the desktop's install sheet. The deep link takes this path too. */
export async function installFromDesktop(convex: ReturnType<typeof useConvex>, apps: DesktopAppsBridge, slug: string, gate: GateKeys): Promise<void> {
  try {
    const info = await convex.query(api.artifacts.appInfo, { slug, ...gate });
    if ("error" in info) {
      toast.error(`Can't install: ${info.error}`);
      return;
    }
    await apps.install(info as AppInfo);
  } catch {
    toast.error("Couldn't reach the page to install it");
  }
}
