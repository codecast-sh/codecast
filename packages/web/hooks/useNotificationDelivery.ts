import { useConvex, useConvexConnectionState } from "convex/react";
import { useWatchEffect } from "./useWatchEffect";
import { useInboxStore } from "../store/inboxStore";
import { isElectron } from "../lib/desktop";
import { getTerminalEndpoint, termHttpBase, type TerminalEndpoint } from "../lib/terminal/endpoint";
import {
  agentAlertsSuppressed, claimBrowserAlert, createNotificationDelivery,
  installNotificationDelivery, type AlertClaim, type ClaimResult,
} from "../lib/notificationDelivery";

export function useNotificationDelivery(ready: boolean) {
  const convex = useConvex();
  const { isWebSocketConnected } = useConvexConnectionState();
  const viewer = useInboxStore((s) => s.currentUser?._id);
  const team = useInboxStore((s) => s.clientState.ui?.active_team_id);
  useWatchEffect(() => {
    if (!viewer) return;
    const scope = JSON.stringify([convex.url, viewer, team ?? null]);
    const desktop = isElectron();
    const client = crypto.randomUUID();
    let endpoint: TerminalEndpoint | null = null;
    let stopped = false;
    let connecting: Promise<void> | null = null;
    let retryAt = 0;
    let discoverFresh = false;

    const request = async (path: string, params: Record<string, string>, keepalive = false): Promise<any> => {
      if (!endpoint) return null;
      const res = await fetch(`${termHttpBase(endpoint)}/notifications/${path}?${new URLSearchParams({ scope, ...params })}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.token}` },
        signal: AbortSignal.timeout(1_500),
        keepalive,
      }).catch(() => null);
      if (!res?.ok) {
        discoverFresh = res?.status !== 404;
        endpoint = null;
        retryAt = Date.now() + 30_000;
        return null;
      }
      return res.json().catch(() => null);
    };

    const heartbeat = async () => {
      if (stopped || !ready || !isWebSocketConnected || agentAlertsSuppressed()) return;
      if (!endpoint && Date.now() >= retryAt && !connecting) {
        connecting = getTerminalEndpoint(convex, { trustCache: !discoverFresh, force: discoverFresh })
          .then((ep) => { if (!stopped) endpoint = ep; })
          .catch(() => {})
          .finally(() => { connecting = null; retryAt = Date.now() + 30_000; });
      }
      await connecting;
      if (desktop && !stopped) await request("desktop", { client, active: "1" });
    };

    const delivery = createNotificationDelivery({
      suppressed: agentAlertsSuppressed,
      remote: async (claim: AlertClaim): Promise<ClaimResult> => {
        await connecting;
        const body = await request("claim", {
          event: claim.key, ttl: String(claim.ttl), desktop: desktop ? "1" : "0", preferDesktop: claim.preferDesktop ? "1" : "0",
        });
        return ["claimed", "duplicate", "desktop"].includes(body?.result) ? body.result : null;
      },
      fallback: (claim) => claimBrowserAlert(scope, claim),
    });
    const uninstall = installNotificationDelivery(delivery);
    void heartbeat();
    const timer = setInterval(() => { void heartbeat(); }, 5_000);
    const release = () => {
      if (desktop) void request("desktop", { client, active: "0" }, true);
    };
    window.addEventListener("pagehide", release);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("pagehide", release);
      release();
      uninstall();
    };
  }, [convex, viewer, team, ready, isWebSocketConnected]);
}
