"use client";

// The app-wide watcher: when one of your laptops has been under sustained
// pressure, a quiet notice in the status stack offers the resources page. It
// never navigates on its own, never takes focus, and stays away for an hour
// once dismissed (the same per-machine dismissal the page's suggestion uses).
import { useMemo } from "react";
import { Gauge } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { sustainedResourcePressure } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useStatusNotice, type StatusNotice } from "../../hooks/useStatusNotice";
import { joinMachines, useMachineResourceRows } from "../../hooks/useResourceMonitor";
import { useDevices } from "../DeviceBadge";
import { freshResourceMachine } from "../../lib/resourceOffload";
import { fmtAgo } from "./resourceModel";

const DISMISS_MS = 3600_000;

export function ResourcePressureNotice() {
  const now = useCoarseNow(30_000);
  const rows = useMachineResourceRows();
  const { devices } = useDevices();
  const pathname = usePathname();
  const router = useRouter();
  const dismissed = useInboxStore((s) => s.clientState.ui?.resource_plan_dismissed);

  const hot = useMemo(() => {
    for (const m of joinMachines(devices, rows)) {
      if (m.role !== "local" || !freshResourceMachine(m, now) || (dismissed?.[m.deviceId] ?? 0) > now) continue;
      const incident = sustainedResourcePressure(m.history, now);
      if (incident) return { machine: m, incident };
    }
    return null;
  }, [devices, rows, dismissed, now]);

  const notice = useMemo<StatusNotice | null>(() => {
    if (!hot || pathname?.startsWith("/resources")) return null;
    const { machine, incident } = hot;
    const dismiss = () => {
      const st = useInboxStore.getState();
      st.updateClientUI({ resource_plan_dismissed: { ...(st.clientState.ui?.resource_plan_dismissed ?? {}), [machine.deviceId]: Date.now() + DISMISS_MS } });
    };
    return {
      tone: incident.level === "critical" ? "red" : "yellow",
      icon: Gauge,
      title: `${machine.name} is under sustained load`,
      detail: `${incident.reason} for ${fmtAgo(incident.since, now).replace(" ago", "")}.`,
      action: (
        <button type="button" onClick={() => router.push("/resources")} className="rounded px-1.5 py-0.5 text-[11px] font-semibold underline-offset-2 hover:underline">
          Review resources
        </button>
      ),
      onDismiss: dismiss,
    };
  }, [hot, pathname, router, now]);

  useStatusNotice("resource-pressure", notice);
  return null;
}
