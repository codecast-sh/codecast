// A live query tab fills itself: while it is open, the page asks the server
// to refresh it when it is stale (older than a minute) and every minute after.
// The server writes the rows as ordinary cell ops, so every viewer, the CLI
// and dashboards reading the sheet see the same data.
import { useCallback, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { TabMeta } from "@codecast/shared/artifacts/sheets";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";

const refreshRef = makeFunctionReference<"mutation", { doc_id: string; tab: string }, { rows?: number; changed?: number; skipped?: boolean }>("sheetQueries:refresh");
const STALE_MS = 60_000;

export function useQueryTabRefresh(docId: string, meta: TabMeta, readOnly: boolean) {
  const run = useMutation(refreshRef);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const inflight = useRef(false);
  const isQuery = !!meta.query;

  const refresh = useCallback(() => {
    if (!isQuery || readOnly || inflight.current) return;
    inflight.current = true;
    setRefreshing(true);
    run({ doc_id: docId, tab: meta.id })
      .then(() => setLastError(null))
      .catch((e: unknown) => setLastError(e instanceof Error ? e.message.replace(/^.*ConvexError:\s*/, "").split("\n")[0] : "Refresh failed"))
      .finally(() => {
        inflight.current = false;
        setRefreshing(false);
      });
  }, [run, docId, meta.id, isQuery, readOnly]);

  const refreshedAt = meta.refreshedAt;
  // A changed query (source, project, status) clears the stamp and reloads; the short wait lets the change reach the server first.
  const querySig = JSON.stringify(meta.query ?? null);
  useWatchEffect(() => {
    if (!isQuery || readOnly) return;
    const first = !refreshedAt ? setTimeout(refresh, 800) : Date.now() - refreshedAt > STALE_MS ? (refresh(), undefined) : undefined;
    const t = setInterval(refresh, STALE_MS);
    return () => {
      clearInterval(t);
      if (first) clearTimeout(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm per tab and per query, not per refresh stamp
  }, [isQuery, readOnly, meta.id, docId, querySig]);

  return { refreshing, refresh, lastError };
}

/**
 * The workspace project a sheet's folder belongs to, by its title (what a
 * query names a project by): the project whose path is the sheet's folder or
 * holds it. Undefined when none does, so a new live tab starts on all projects.
 */
export function useProjectTitleFor(path: string | undefined, workspace: string | undefined): string | undefined {
  const projects = useWorkspaceCollection<{ title?: string; project_path?: string; status?: string }>("projects", (p) => `${p.title}|${p.project_path}|${p.status}`, workspace ?? null);
  if (!path) return undefined;
  const hits = projects.filter((p) => p.title && p.project_path && p.status === "active" && (path === p.project_path || path.startsWith(`${p.project_path}/`)));
  // The deepest folder wins: a project for a package beats one for the whole repo.
  return hits.sort((a, b) => b.project_path!.length - a.project_path!.length)[0]?.title;
}
