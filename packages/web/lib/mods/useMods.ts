// React side of codecast mods: the feeder for the `mods` collection, the set of
// rows, the host's running set as a subscription, and useModSurface, which
// asks a mod to draw one surface and redraws it when the mod says so or when
// the data it read changes.

import { useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { ModNode, ModSurface, ResolvedObject } from "@codecast/shared/contracts/mods";
import { useInboxStore, isConvexId } from "../../store/inboxStore";
import { useSyncCollection } from "../../hooks/useSyncCollection";
import { modHost, type ModRow, type ModRuntime } from "./host";
import { externalObjectRef, objectByShortId } from "./objects";
import { useWatchEffect } from "../../hooks/useWatchEffect";

const api = _api as any;

/** Feeds the store's `mods` and `modObjects` collections. Mounted once, in HostFeeders. */
export function useSyncMods(): void {
  useSyncCollection("modObjects", api.modObjects.webList, {});
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  // The team's shared mods, and what their local halves publish, come with the active team.
  const teamArgs = activeTeamId && !isConvexId(String(activeTeamId)) ? "skip" : activeTeamId ? { team_id: activeTeamId } : {};
  useSyncCollection("modState", api.modLocal.webState, teamArgs);
  useSyncCollection("mods", api.mods.webList, teamArgs);
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

export type SurfaceState = { tree: ModNode | undefined; value?: unknown; error: string | null; loading: boolean; pass: boolean; status: ModRuntime["status"] | "missing"; retry?: () => void };

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

  useWatchEffect(() => {
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
          value: res.error ? s.value : res.value,
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

  // Gone for good (not just redrawn): the frame can drop this surface's handlers.
  useWatchEffect(() => () => runtime?.release(key), [runtime, key]);

  return { ...state, retry: runtime ? () => runtime.invalidate(key) : undefined };
}

/** What an object id names: `external` when the row is live from another system (read-only, nothing stored). */
export type ObjectRow = { short_id: string; title: string; status?: string; fields?: Record<string, any>; body?: string; external?: boolean; [k: string]: any };

/**
 * The row an object id names. A stored id (`bug-14`) reads the store; an
 * external id (`contact-3f9a21bc`) asks the declaring mod's `object.resolve`
 * hook, which redraws like any surface when the data it read changes.
 * `loading` holds while that answer is on its way.
 */
export function useObjectRow(shortId: string): { row: ObjectRow | undefined; loading: boolean; error: string | null } {
  useModHostVersion();
  const id = shortId.toLowerCase();
  const stored = useInboxStore((s) => objectByShortId((s as any).modObjects, id));
  const ext = externalObjectRef(id);
  const runtime = ext ? modHost.byName(ext.kind.mod) : undefined;
  const surface = useMemo<ModSurface | null>(() => (ext ? { kind: "resolve", id: ext.kind.prefix, props: { id: ext.id } } : null), [ext?.kind.prefix, ext?.id]);
  const res = useModSurface(runtime, surface, `${id}:${useId()}`);
  if (!ext) return { row: stored, loading: false, error: null };
  const v = res.value as ResolvedObject | null | undefined;
  const row = v?.title ? { ...v, short_id: id, external: true } : undefined;
  return { row, loading: !!runtime && (res.loading || res.pass) && !row, error: res.error };
}
