// The replay page's data: the recording's events read from its chunks, the
// first-open import of a mirrored recording, and the issues it is linked to.
import { useMemo, useRef, useState } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { needsVendorImport, type ReplayEvent } from "@codecast/shared/contracts/replay";
import { foldRepeatNavs, parseReplayEvents, sortReplayEvents } from "@codecast/shared/replay";
import { useOpsGroups, useOpsReplayTimeline } from "../../hooks/useSyncOps";
import { CONVEX_URL } from "../../lib/convexUrl";
import { decodeReplayChunk } from "./opsModel";
import type { OpsGroup, OpsReplay, OpsSource } from "./opsTypes";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { onReplayClock, restDue, type RestHold, vendorRecordingUrl } from "./replayModel";

type Loaded = { state: "loading" } | { state: "ready"; events: ReplayEvent[] } | { state: "failed"; error: string };

/** Read every chunk of a replay the viewer may see, in order. */
export function useReplayEvents(replay: OpsReplay | undefined): Loaded {
  const token = useAuthToken();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  // A re-import (a newer converter, a part of a long recording) replaces chunks that may keep their count: when it landed is part of the key.
  const key = replay ? `${replay._id}:${replay.chunks}:${replay.captured_ms ?? ""}:${replay.imported_at ?? ""}` : null;
  // The replay whose events are on screen: a later part landing reads the chunks again behind them, so nothing blanks.
  const shown = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!replay || !token) return;
    if (replay.chunks === 0) {
      setLoaded({ state: "ready", events: [] });
      return;
    }
    let cancelled = false;
    if (shown.current !== replay._id) setLoaded({ state: "loading" });
    (async () => {
      // Every chunk at once: a long recording is several, and each is a round trip through the chunk route.
      const parts = await Promise.all(Array.from({ length: replay.chunks }, async (_, seq) => {
        const res = await fetch(`${CONVEX_URL}/cli/replays/chunk?replay=${encodeURIComponent(replay._id)}&seq=${seq}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(res.status === 404 ? "a chunk is missing or expired (chunks are kept 30 days)" : `chunk ${seq} answered ${res.status}`);
        return parseReplayEvents(await decodeReplayChunk(new Uint8Array(await res.arrayBuffer())));
      }));
      const all = parts.flat();
      if (cancelled) return;
      shown.current = replay._id;
      setLoaded({ state: "ready", events: onReplayClock(foldRepeatNavs(sortReplayEvents(all))) });
    })().catch((e) => {
      if (!cancelled) setLoaded({ state: "failed", error: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands in for the replay row
  }, [key, token]);
  return loaded;
}

export type Import = ({ state: "idle" } | { state: "importing" } | { state: "failed"; error: string }) & {
  again?: () => void;
  /** The server read nothing on the last ask, and why (importLinked's `declined`): shown at once, before the row's own sync says so. */
  declined?: RestHold | null;
};

/**
 * Import a mirrored recording the first time the page opens it. The answer is
 * not rendered: the import writes the replay row, and the row's sync brings
 * its chunks here. One attempt per replay per visit.
 */
export function useVendorImport(replay: OpsReplay | undefined): Import {
  const importLinked = useAction(api.sources.vendorReplay.importLinked);
  const [state, setState] = useState<Import>({ state: "idle" });
  const [declined, setDeclined] = useState<RestHold | null>(null);
  const tried = useRef<string | null>(null);
  // Also a copy holding only the start of a long recording with nothing reading the rest: the server starts reading it.
  const due = !!replay && (needsVendorImport(replay) || restDue(replay, Date.now())) && !(declined && declined.until > Date.now());
  const run = (id: string) => {
    setState({ state: "importing" });
    setDeclined(null);
    importLinked({ replay: id }).then(
      (out: { declined?: { why: string; until?: number } }) => {
        setState({ state: "idle" });
        const d = out?.declined;
        if (d && d.until && d.why !== "whole" && d.why !== "reading") setDeclined({ why: d.why as RestHold["why"], until: d.until });
      },
      (e) => setState({ state: "failed", error: e instanceof Error ? e.message : String(e) }),
    );
  };
  useWatchEffect(() => {
    if (!replay || !due || tried.current === replay._id) return;
    tried.current = replay._id;
    run(replay._id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per replay id
  }, [replay?._id, due]);
  // A press that asks again: reading the rest stopped while the page was open.
  return { ...state, declined, again: replay && due && state.state !== "importing" ? () => run(replay._id) : undefined };
}

/** The issues a recording is linked to: the store's group rows first (they carry fix state), the detail's names for the rest. */
export function useLinkedIssues(replay: OpsReplay | undefined, timeline: ReturnType<typeof useOpsReplayTimeline>): { _id: string; short_id: string; title: string; status: string; fingerprint?: string; group?: OpsGroup }[] {
  const groups = useOpsGroups();
  return useMemo(() => {
    if (!replay) return [];
    const byId = new Map(groups.map((g) => [g._id, g]));
    const named = new Map((timeline?.groups ?? []).map((g) => [g._id, g]));
    return replay.group_ids
      .map((id) => {
        const g = byId.get(id);
        if (g) return { _id: g._id, short_id: g.short_id, title: g.title, status: g.status, fingerprint: g.fingerprint, group: g };
        const n = named.get(id);
        return n ? { _id: n._id, short_id: n.short_id, title: n.title, status: n.status } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  }, [replay, groups, timeline]);
}

/** Where the vendor shows the recording itself, when the source says enough to build the address. */
export function vendorUrl(replay: OpsReplay, source: Pick<OpsSource, "config" | "vendor_web_url"> | undefined): string | null {
  return vendorRecordingUrl(replay.provider, replay.external_id, source);
}

export const VENDOR_NAME: Partial<Record<OpsReplay["provider"], string>> = { sentry: "Sentry", posthog: "PostHog" };
