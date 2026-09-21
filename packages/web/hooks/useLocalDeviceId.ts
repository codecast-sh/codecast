import { useState } from "react";
import { captureException } from "@sentry/react";
import { useConvex, useConvexConnectionState } from "convex/react";
import { useInboxStore } from "../store/inboxStore";
import { getTerminalEndpoint, isOverrideEndpoint } from "../lib/terminal/endpoint";
import { useWatchEffect } from "./useWatchEffect";

export function useLocalDeviceId(ready: boolean): string | null {
  const convex = useConvex();
  const { isWebSocketConnected } = useConvexConnectionState();
  const viewer = useInboxStore((s) => s.currentUser?._id);
  const [local, setLocal] = useState<{ viewer: string; deviceId: string } | null>(null);

  useWatchEffect(() => {
    if (!viewer || !ready || !isWebSocketConnected) return;
    let stopped = false;
    let running = false;
    let found = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const discover = async () => {
      if (stopped || running || found) return;
      clearTimeout(retry);
      running = true;
      try {
        const endpoint = await getTerminalEndpoint(convex);
        if (!stopped && endpoint && !isOverrideEndpoint(endpoint)) {
          found = true;
          setLocal({ viewer, deviceId: endpoint.deviceId });
        }
      } catch (error) {
        if (!stopped) captureException(error);
      } finally {
        running = false;
        if (!stopped && !found) retry = setTimeout(discover, 30_000);
      }
    };
    void discover();
    window.addEventListener("focus", discover);
    window.addEventListener("online", discover);
    return () => {
      stopped = true;
      clearTimeout(retry);
      window.removeEventListener("focus", discover);
      window.removeEventListener("online", discover);
    };
  }, [convex, viewer, ready, isWebSocketConnected]);

  return local && local.viewer === viewer ? local.deviceId : null;
}
