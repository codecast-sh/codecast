import { isAgentDrivenTab } from "./desktopHandoff";

export const AGENT_ALERTS_OVERRIDE = "codecast-agent-alerts";
const CLAIMS_KEY = "codecast-notification-claims";

export function reportAlertError(error: Error): void {
  void import("./analytics").then(({ captureError }) => captureError(error));
}

export function agentAlertsSuppressed(): boolean {
  if (!isAgentDrivenTab()) return false;
  try {
    return sessionStorage.getItem(AGENT_ALERTS_OVERRIDE) !== "1";
  } catch (error) {
    reportAlertError(error as Error);
    return true;
  }
}

export type AlertClaim = { key: string; ttl: number; preferDesktop: boolean };
export type ClaimResult = "claimed" | "duplicate" | "desktop" | null;

export function claimStoredAlert(storage: Pick<Storage, "getItem" | "setItem">, key: string, ttl: number, now = Date.now()): boolean {
  const entries: Record<string, number> = JSON.parse(storage.getItem(CLAIMS_KEY) || "{}");
  if (entries[key] > now) return false;
  const live = Object.entries(entries).filter(([, expires]) => expires > now).slice(-499);
  storage.setItem(CLAIMS_KEY, JSON.stringify(Object.fromEntries([...live, [key, now + ttl]])));
  return true;
}

export async function claimBrowserAlert(scope: string, claim: AlertClaim): Promise<boolean> {
  const key = JSON.stringify([scope, claim.key]);
  const reserve = () => claimStoredAlert(localStorage, key, claim.ttl);
  try {
    if (navigator.locks) return await navigator.locks.request(CLAIMS_KEY, { signal: AbortSignal.timeout(3_000) }, reserve);
    return reserve();
  } catch (error) {
    reportAlertError(error as Error);
    return !(error instanceof DOMException && error.name === "TimeoutError");
  }
}

export type NotificationDeliveryDeps = {
  remote: (claim: AlertClaim) => Promise<ClaimResult>;
  fallback: (claim: AlertClaim) => Promise<boolean>;
  suppressed: () => boolean;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
};

export function createNotificationDelivery(deps: NotificationDeliveryDeps) {
  let stopped = false;
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return {
    stop() { stopped = true; },
    async deliver(claim: AlertClaim, send: () => boolean | void | Promise<boolean | void>): Promise<boolean> {
      const deadline = now() + Math.min(claim.ttl, 20_000);
      if (stopped || deps.suppressed() || !(await deps.fallback(claim))) return false;
      while (!stopped && !deps.suppressed()) {
        const result = await deps.remote(claim);
        if (stopped || deps.suppressed() || now() > deadline) return false;
        if (result === "duplicate") return false;
        if (result === "desktop") {
          if (now() >= deadline) return false;
          await wait(Math.min(1_000, deadline - now()));
          continue;
        }
        if (stopped || deps.suppressed()) return false;
        return (await send()) !== false;
      }
      return false;
    },
  };
}

type Delivery = ReturnType<typeof createNotificationDelivery>;
let current: Delivery | null = null;

export function installNotificationDelivery(delivery: Delivery): () => void {
  current?.stop();
  current = delivery;
  return () => {
    delivery.stop();
    if (current === delivery) current = null;
  };
}

/** Deliver one alert, once across every window. `due` is asked again at the
 *  moment it would sound or show, after the claims and waits above: an alert
 *  about a request the person answered meanwhile stays quiet. */
export function deliverAlert(
  key: string,
  send: () => boolean | void | Promise<boolean | void>,
  { ttl = 60_000, preferDesktop = true, due }: { ttl?: number; preferDesktop?: boolean; due?: () => boolean } = {},
): Promise<boolean> {
  if (agentAlertsSuppressed() || (due && !due())) return Promise.resolve(false);
  const sendIfDue = () => (due && !due() ? false : send());
  if (current) return current.deliver({ key, ttl, preferDesktop }, sendIfDue);
  return Promise.resolve(sendIfDue()).then((sent) => sent !== false);
}

// Which view a focused browser tab shows, across tabs. A tab holds a shared
// hold on a Web Lock named for the entity on its screen while it has focus;
// asking for that name exclusively without waiting fails while any tab holds
// it. (The desktop shell sees its windows itself and decides banners there.)
const FOCUS_LOCK = "codecast-focused-view:";
let resyncFocusHold: () => void = () => {};

/** Hold the lock for `view()` (an entity, notificationGate's `bannerEntity`)
 *  while this window has focus. Returns the uninstall. */
export function installFocusHold(view: () => string | null): () => void {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks || typeof window === "undefined") return () => {};
  let held: { name: string; release: () => void } | null = null;
  const sync = () => {
    const entity = document.hasFocus() ? view() : null;
    const name = entity ? FOCUS_LOCK + entity : null;
    if (held?.name === name) return;
    held?.release();
    held = null;
    if (!name) return;
    // Released before the grant, the hold ends as soon as it starts.
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    held = { name, release };
    locks.request(name, { mode: "shared" }, () => hold).catch(reportAlertError);
  };
  resyncFocusHold = sync;
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    window.removeEventListener("focus", sync);
    window.removeEventListener("blur", sync);
    document.removeEventListener("visibilitychange", sync);
    if (resyncFocusHold === sync) resyncFocusHold = () => {};
    held?.release();
    held = null;
  };
}

/** The view on this window's screen changed: move its hold. */
export function focusedViewChanged(): void {
  resyncFocusHold();
}

/** True when a focused tab of the app (this one or another) shows `entity`. */
export async function focusedWindowShows(entity: string): Promise<boolean> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return false;
  try {
    return await locks.request(FOCUS_LOCK + entity, { mode: "exclusive", ifAvailable: true }, (lock) => lock === null);
  } catch (error) {
    reportAlertError(error as Error);
    return false;
  }
}
