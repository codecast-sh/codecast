// The Ops shell's hooks: the workspace an opened item belongs to when it is
// not the one Ops reads, and which tabs fit a narrow bar.
import { useMemo, useRef, useState, type RefObject } from "react";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { OpsView } from "./opsPaths";
import { fitTabs } from "./tabFit";

const sameRef = (ref: string) => (r: { _id: string; short_id?: string }) => r.short_id === ref || r._id === ref;
const wsSig = (r: { workspace?: string }) => r.workspace ?? "";
const NONE = () => false;

/**
 * The workspace an opened item belongs to, when it is not the one Ops reads:
 * a link from chat, a notification or another workspace's palette lands on
 * the item, and the area says whose it is instead of mixing two workspaces.
 */
export function useForeignItemWorkspace(view: OpsView): string | null {
  const ref = view.view === "issue" || view.view === "replay" || view.view === "metric" ? view.id : "";
  const where = useMemo(() => sameRef(ref), [ref]);
  const groups = useCollectionRows<{ _id: string; short_id?: string; workspace?: string }>("opsGroups", { where: view.view === "issue" ? where : NONE, sig: wsSig });
  const replays = useCollectionRows<{ _id: string; short_id?: string; workspace?: string }>("opsReplays", { where: view.view === "replay" ? where : NONE, sig: wsSig });
  const watches = useCollectionRows<{ _id: string; short_id?: string; workspace?: string }>("opsWatches", { where: view.view === "metric" ? where : NONE, sig: wsSig });
  const active = useActiveWorkspaceKey();
  const row = groups[0] ?? replays[0] ?? watches[0];
  if (!row?.workspace || !active) return null;
  return row.workspace === active ? null : row.workspace;
}


/**
 * The workspace a source link means, and whether the server is still asked:
 * `pending` while the by-name lookup has not answered (and has not failed),
 * so a page can finish its "not in this workspace" verdict at once and mark
 * only the other-workspace lookup as still running.
 */
export function useForeignSourceLookup(ref: string | null): { workspace: string | null; pending: boolean } {
  const where = useMemo(() => (ref ? (r: { _id: string; short_id?: string; name?: string }) => r.name === ref || r.short_id === ref || r._id === ref : NONE), [ref]);
  const rows = useCollectionRows<{ _id: string; short_id?: string; name?: string; workspace?: string }>("opsSources", { where, sig: wsSig });
  // The device holds only the active workspace's sources, so the server names the one a link means (by name, src-N or id) in any workspace the reader belongs to, as an issue link's own read does.
  const { data: remote, error } = useQueryNoThrow(api.ingest.webGetSource, ref ? { ref } : "skip");
  const active = useActiveWorkspaceKey();
  if (!active || !ref) return { workspace: null, pending: false };
  const local = rows.find((r) => r.workspace && r.workspace !== active)?.workspace;
  if (local) return { workspace: local, pending: false };
  const ws = (remote as { workspace?: string } | null | undefined)?.workspace;
  return { workspace: ws && ws !== active ? ws : null, pending: remote === undefined && !error };
}

/** Room the More menu takes at the bar's end. */
const MORE_WIDTH = 76;

/**
 * The tab keys the bar draws, null for all of them: on a narrow bar the ones
 * past its width fold into a More menu (fitTabs), measured from the tabs as
 * drawn and again whenever the bar resizes.
 */
export function useTabFit(nav: RefObject<HTMLElement | null>, keys: readonly string[], active: string | null, /** What the tabs print (their counts): a change re-measures them. */ content = "", /** The tabs kept first when the bar is narrow, most opened first. */ rank: readonly string[] = []): ReadonlySet<string> | null {
  const widths = useRef(new Map<string, number>());
  const [shown, setShown] = useState<string | null>(null);
  const sig = keys.join(",");
  useWatchEffect(() => {
    const el = nav.current;
    if (!el) return;
    const fit = () => {
      for (const t of el.querySelectorAll<HTMLElement>("[data-ops-tab]")) {
        const w = t.offsetWidth;
        if (w) widths.current.set(t.dataset.opsTab!, w);
      }
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const keep = fitTabs(keys.map((k) => widths.current.get(k) ?? 0), el.clientWidth, MORE_WIDTH, gap, active ? keys.indexOf(active) : -1, rank.map((k) => keys.indexOf(k)));
      const next = keep.length === keys.length ? null : keep.map((i) => keys[i]).join(",");
      setShown((prev) => (prev === next ? prev : next));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig spells keys
  }, [nav, sig, active, content]);
  return useMemo(() => (shown === null ? null : new Set(shown.split(","))), [shown]);
}
