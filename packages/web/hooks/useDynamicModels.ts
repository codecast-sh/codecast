"use client";

// Live model options for dynamic clients (opencode/pi). Each device heartbeats
// the `provider/model` ids its installed clients can actually launch (devices
// row, model_inventory); this hook turns that into picker data: a curated
// featured head plus the full searchable id list. Non-dynamic clients (and
// devices that haven't reported yet) fall back to the static contract options,
// so the pickers never go blank.

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
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
  // Subscription only exists while a dynamic picker is mounted; Convex dedupes
  // it against other listDevices subscribers (DeviceBadge).
  const devices = useQuery(api.devices.listDevices, dynamic ? {} : "skip");

  return useMemo(() => {
    const staticFeatured = (cfg?.models ?? []).filter((m) => m.key !== "default");
    if (!dynamic || !devices) return { dynamic, featured: staticFeatured, all: [] };
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
