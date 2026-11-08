// Turning agent features on from the web: once for the machines online now,
// or kept for the first machine to connect (usePendingAgentFeatures).
import type { SnippetDescriptor } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { snippetEnabledOn } from "../../lib/newSnippets";
import type { Device } from "../DeviceBadge";

/** Turn on each chosen feature a reporting machine lacks. Returns how many were sent. */
export function applyAgentFeatures(devices: Device[], features: SnippetDescriptor[]): number {
  const { setDeviceSnippet } = useInboxStore.getState();
  let sent = 0;
  for (const d of devices) {
    if (!d.online || !d.settings) continue;
    for (const s of features) {
      if (snippetEnabledOn(d.settings, s)) continue;
      void setDeviceSnippet(d.device_id, { snippet: s.wireSlug ?? s.slug, enabled: true }).catch(() => {});
      sent++;
    }
  }
  return sent;
}

/** Keep a choice for the first machine that comes online and reports its setup. */
export function setPendingAgentFeatures(slugs: string[]) {
  useInboxStore.getState().updateClientUI({ agent_features_pending: { slugs, at: Date.now() } });
}

