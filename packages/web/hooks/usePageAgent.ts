import { useState } from "react";
import type { PageAgentChip } from "@codecast/shared/contracts";
import { useWatchEffect } from "./useWatchEffect";
import { pageFrameSrc } from "../lib/publishedPageUrls";

export type PageAgent = { state: string; since: number; awaiting_since: number | null; chip: PageAgentChip };

const IDLE_POLL_MS = 30_000;
const ACTIVE_POLL_MS = 5_000;

/** The publishing session of a published page, as the page's own bar shows
 *  it: read from the page's ?meta=1. Polled over HTTP while the embed is
 *  mounted and the window visible, never subscribed: the state derives from
 *  the owner's daemon heartbeats, so a subscription per embed would re-run on
 *  every heartbeat of the owner's whole fleet. Polls faster while the agent
 *  is on the page. Null for a page with no session, a gated page, or until
 *  the first answer. */
export function usePageAgent(slug: string, enabled: boolean): PageAgent | null {
  const [agent, setAgent] = useState<PageAgent | null>(null);
  useWatchEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = false;
    const tick = async () => {
      timer = null;
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`${pageFrameSrc(slug)}?meta=1`, { cache: "no-store" });
          const meta = res.ok ? ((await res.json()) as { agent?: PageAgent | null }) : null;
          if (stopped) return;
          const next = meta?.agent ?? null;
          active = !!next && next.chip !== "idle";
          setAgent((prev) => (prev && next && prev.chip === next.chip && prev.since === next.since ? prev : next));
        } catch {
          /* enrichment only: keep the last state */
        }
      }
      if (!stopped) timer = setTimeout(tick, active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && timer) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug, enabled]);
  return agent;
}
