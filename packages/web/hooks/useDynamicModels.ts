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
  claudeMenuOption,
  CLAUDE_MENU_KEY_PREFIX,
  type ModelOption,
} from "@codecast/shared/contracts";

export interface DynamicModelData {
  dynamic: boolean;
  /** Curated head: live-featured when a device reported, static fallback else. */
  featured: ModelOption[];
  /** Full launchable id list (empty until a device reports). */
  all: string[];
  /** Menu-dynamic clients (claude): the device's harvested /model picker rows
   *  as ready-to-render options, in menu order. A row that matches a curated
   *  option IS that option (stable key, hint); an uncurated row gets a
   *  synthesized `menu:<label>` key. Empty until a switch harvests the menu —
   *  the picker falls back to the curated list. Live rail only. */
  menuRows: ModelOption[];
}

export function useDynamicModels(
  agentType: string | undefined,
  ownerDeviceId?: string | null,
): DynamicModelData {
  const agentKey = modelAgentKey(agentType);
  const cfg = AGENT_MODEL_CONFIG[agentKey];
  const dynamic = !!cfg?.dynamic;
  const menuDynamic = !!cfg?.menuDynamic;
  // Subscription only exists while a dynamic picker is mounted; Convex dedupes
  // it against other listDevices subscribers (DeviceBadge).
  // Store-fed roster (hooks/useSyncDevices); the feeder only mounts while a
  // dynamic picker is open.
  useSyncDevices(dynamic || menuDynamic);
  const roster = useInboxStore((s) => s.machineRoster);
  const devices = dynamic || menuDynamic ? roster : undefined;

  return useMemo(() => {
    const staticFeatured = (cfg?.models ?? []).filter((m) => m.key !== "default");
    const empty = { featured: staticFeatured, all: [] as string[], menuRows: [] as ModelOption[] };
    if (!devices) return { dynamic, ...empty };
    const rows = (devices as any[]).filter((d) => d.model_inventory?.clients?.[agentKey]?.length);
    // The session's bound device is the truth for what its launch can use;
    // before routing is known, the union across reporting devices.
    const bound = ownerDeviceId ? rows.filter((d) => d.device_id === ownerDeviceId) : [];
    const source = bound.length > 0 ? bound : rows;
    if (menuDynamic) {
      // Menu order is meaningful, so no union: the bound device's harvest, else
      // the freshest reporting device. The Default row is dropped — the curated
      // "default" option (= the agent's saved default) already covers it.
      const best = [...source].sort(
        (a, b) => (b.model_inventory?.collected_at ?? 0) - (a.model_inventory?.collected_at ?? 0),
      )[0];
      const labels: string[] = (best?.model_inventory?.clients?.[agentKey] ?? []).filter(
        (l: string) => !/^Default\b/i.test(l),
      );
      const menuRows = labels.map((label) => {
        const curated = cfg?.models.find(
          (m) => m.key !== "default" && m.menuMatch && new RegExp(m.menuMatch, "i").test(label),
        );
        return curated ?? claudeMenuOption(`${CLAUDE_MENU_KEY_PREFIX}${label}`);
      });
      return { dynamic, ...empty, menuRows };
    }
    if (!dynamic) return { dynamic, ...empty };
    const all = [...new Set(source.flatMap((d) => d.model_inventory.clients[agentKey] as string[]))].sort();
    const featured = featuredModelOptions(all);
    return { dynamic, featured: featured.length > 0 ? featured : staticFeatured, all, menuRows: [] };
  }, [cfg, dynamic, menuDynamic, devices, ownerDeviceId, agentKey]);
}
