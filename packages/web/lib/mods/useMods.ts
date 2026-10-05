// React side of codecast mods: the feeder for the `mods` collection, the set of
// rows, the host's running set as a subscription, and useModSurface, which
// asks a mod to draw one surface and redraws it when the mod says so or when
// the data it read changes.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { ModNode, ModSurface } from "@codecast/shared/contracts/mods";
import { useInboxStore, isConvexId } from "../../store/inboxStore";
import { useSyncCollection } from "../../hooks/useSyncCollection";
import { modHost, type ModRow, type ModRuntime } from "./host";

const api = _api as any;

/** Feeds the store's `mods` and `modObjects` collections. Mounted once, in HostFeeders. */
export function useSyncMods(): void {
  useSyncCollection("modObjects", api.modObjects.webList, {});
  useSyncCollection("modState", api.modLocal.webState, {});
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  useSyncCollection(
    "mods",
    api.mods.webList,
    activeTeamId && !isConvexId(String(activeTeamId)) ? "skip" : activeTeamId ? { team_id: activeTeamId } : {},
  );
}

const EMPTY: Record<string, ModRow> = {};
/** Every mod row the viewer can see, newest first. */
export function useModRows(): ModRow[] {
  const map = useInboxStore((s) => ((s as any).mods as Record<string, ModRow> | undefined) ?? EMPTY);
  return useMemo(() => Object.values(map).filter((r) => r && r.name).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)), [map]);
}

/** Re-renders when a mod starts, stops, reloads or logs an error. */
export function useModHostVersion(): number {
  return useSyncExternalStore((fn) => modHost.subscribe(fn), () => modHost.getVersion(), () => 0);
}

export function useModRuntime(name: string | undefined): ModRuntime | undefined {
  useModHostVersion();
  return name ? modHost.byName(name) : undefined;
}

export type SurfaceState = { tree: ModNode | undefined; error: string | null; loading: boolean; pass: boolean; status: ModRuntime["status"] | "missing"; retry?: () => void };

/**
 * One drawn surface of a mod. `instance` keeps two mounts of the same surface
 * (two fences with different code) apart. The last good tree stays on screen
 * while a redraw is in flight, so updates never flash.
 */
export function useModSurface(runtime: ModRuntime | undefined, surface: ModSurface | null, instance: string): SurfaceState {
  const [state, setState] = useState<SurfaceState>({ tree: undefined, error: null, loading: true, pass: false, status: runtime?.status ?? "missing" });
  const surfaceKey = surface ? `${surface.kind}:${surface.id}` : "";
  const propsSig = surface ? JSON.stringify(surface.props ?? {}) : "";
  const key = `${surfaceKey}@${instance}`;
  const seq = useRef(0);
  const status = runtime?.status;

  useEffect(() => {
    if (!runtime || !surface) {
      setState((s) => ({ ...s, loading: false, status: runtime?.status ?? "missing" }));
      return;
    }
    let alive = true;
    let queued = false;
    let running = false;
    const draw = async () => {
      if (running) { queued = true; return; }
      running = true;
      const mine = ++seq.current;
      try {
        const res = await runtime.render(key, surface);
        if (!alive || mine !== seq.current) return;
        setState((s) => ({
          tree: res.error ? s.tree : res.tree,
          error: res.error ?? null,
          loading: false,
          pass: !!res.pass,
          status: runtime.status,
        }));
      } finally {
        running = false;
        if (queued && alive) { queued = false; void draw(); }
      }
    };
    void draw();
    // A surface key without the instance lets $.ui.invalidate("pane:main") reach every mount of it.
    const offA = runtime.onInvalidate(key, () => void draw());
    const offB = runtime.onInvalidate(surfaceKey, () => void draw());
    const offS = runtime.onStatus(() => { if (runtime.status !== "loading") void draw(); });
    return () => { alive = false; offA(); offB(); offS(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, key, propsSig, status === "failed"]);

  return { ...state, retry: runtime ? () => runtime.invalidate(key) : undefined };
}
