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

export function deliverAlert(
  key: string,
  send: () => boolean | void | Promise<boolean | void>,
  { ttl = 60_000, preferDesktop = true } = {},
): Promise<boolean> {
  if (agentAlertsSuppressed()) return Promise.resolve(false);
  if (current) return current.deliver({ key, ttl, preferDesktop }, send);
  return Promise.resolve(send()).then((sent) => sent !== false);
}
