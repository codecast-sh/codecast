// The daemon on this machine, for Settings > Editor: the one Files already
// found, else discovered here (the settings modal can open before Files ever
// mounted on this page load). Discovery alone, never a vault connect, so
// opening settings scans nothing.

import { useState } from "react";
import { useConvex } from "convex/react";
import { useVaultStore } from "../../../store/vaultStore";
import { getVaultEndpoint, type VaultEndpoint } from "../../../lib/vault/client";
import { useWatchEffect } from "../../../hooks/useWatchEffect";

export type EndpointState = { status: "finding" } | { status: "ready"; ep: VaultEndpoint } | { status: "offline" };

export function useEditorEndpoint(): EndpointState {
  const convex = useConvex();
  const shared = useVaultStore((s) => s.endpoint);
  const [found, setFound] = useState<EndpointState>({ status: "finding" });
  useWatchEffect(() => {
    if (shared) return;
    let live = true;
    getVaultEndpoint(convex).then(
      (ep) => live && setFound(ep ? { status: "ready", ep } : { status: "offline" }),
      () => live && setFound({ status: "offline" }),
    );
    return () => {
      live = false;
    };
  }, [shared, convex]);
  return shared ? { status: "ready", ep: shared } : found;
}
