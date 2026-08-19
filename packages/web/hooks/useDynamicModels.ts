"use client";

// Live model options for dynamic clients (opencode/pi). Each device heartbeats
// the `provider/model` ids its installed clients can actually launch (devices
// row, model_inventory); this hook turns that into picker data: a curated
// featured head plus the full searchable id list. Non-dynamic clients (and
// devices that haven't reported yet) fall back to the static contract options,
// so the pickers never go blank.

import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useSyncDevices } from "./useSyncDevices";
import {
  AGENT_MODEL_CONFIG,
  modelAgentKey,
  featuredModelOptions,
  type ModelOption,
} from "@codecast/shared/contracts";

export interface DynamicModelData {
  dynamic: boolean;
  /** Curated head: live-featured when a device reported, static fallback else. */
  featured: ModelOption[];
  /** Full launchable id list (empty until a device reports). */
  all: string[];
}

export function useDynamicModels(
  agentType: string | undefined,
  ownerDeviceId?: string | null,
): DynamicModelData {
  const agentKey = modelAgentKey(agentType);
  const cfg = AGENT_MODEL_CONFIG[agentKey];
  const dynamic = !!cfg?.dynamic;
  // Store-fed roster (hooks/useSyncDevices); the feeder only mounts while a
  // dynamic picker is open. Convex dedupes the subscription against other
  // listDevices subscribers (DeviceBadge).
  useSyncDevices(dynamic);
  const roster = useInboxStore((s) => s.machineRoster);
  const devices = dynamic ? roster : undefined;

  return useMemo(() => {
    const staticFeatured = (cfg?.models ?? []).filter((m) => m.key !== "default");
    const empty = { featured: staticFeatured, all: [] as string[] };
    if (!devices) return { dynamic, ...empty };
    const rows = (devices as any[]).filter((d) => d.model_inventory?.clients?.[agentKey]?.length);
    // The session's bound device is the truth for what its launch can use;
    // before routing is known, the union across reporting devices.
    const bound = ownerDeviceId ? rows.filter((d) => d.device_id === ownerDeviceId) : [];
    const source = bound.length > 0 ? bound : rows;
    const all = [...new Set(source.flatMap((d) => d.model_inventory.clients[agentKey] as string[]))].sort();
    const featured = featuredModelOptions(all);
    return { dynamic, featured: featured.length > 0 ? featured : staticFeatured, all };
  }, [cfg, dynamic, devices, ownerDeviceId, agentKey]);
}
