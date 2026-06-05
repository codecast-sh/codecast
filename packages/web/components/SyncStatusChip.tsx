import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore } from "../store/inboxStore";

// A healthy cold-open sync settles in a few seconds. If a scope is still
// loading past this, the backend is genuinely slow (or stalled) — surface that
// as a distinct amber state rather than an indefinite, identical-looking spin.
const STALL_MS = 10_000;

/**
 * Header indicator that spins while the app is pulling fresh data from the
 * server — the cold-open "data syncing in" phase you see right after the desktop
 * app has been closed for a while.
 *
 * Driven by `liveLoading` — the first-payload state of the LIVE subscriptions
 * (inbox sessions, docs, tasks). It deliberately does NOT read `syncProgress`
 * (the background reconcile crawl that the per-page SyncProgressBadge shows):
 * that crawl pages through every row at a throttled pace and can run for
 * minutes, which kept this spinner lit ~forever. Tracking the live first load
 * instead bounds the chip to a single round-trip — it lights up while any scope
 * hasn't delivered yet and clears once they have. Warm in-app navigation never
 * flips it on, because those subscriptions stay resolved after the first load.
 *
 * Two tiers: cyan "syncing" for a normal sync, amber "sync slow" once it drags
 * past STALL_MS so a genuinely slow backend reads differently from a quick one.
 * Styled as a pill to match the daemon/agents chips it sits beside.
 */
// The chip spins iff some live subscription's first payload is still pending.
// Reads ONLY `liveLoading`, never `syncProgress` (the background reconcile crawl
// that pages every row for minutes) — that conflation kept the spinner lit
// ~forever on every cold load. Exported for the regression test.
export function selectSyncing(s: { liveLoading: Record<string, boolean> }): boolean {
  return Object.values(s.liveLoading).some(Boolean);
}

export function SyncStatusChip() {
  const syncing = useInboxStore(selectSyncing);
  const [stalled, setStalled] = useState(false);
  // Mirror DaemonStatusChip: render nothing until mounted so SSR markup and the
  // first client render agree (no hydration mismatch).
  const [mounted, setMounted] = useState(false);
  useMountEffect(() => setMounted(true));

  // Arm a timer when sync starts; trip the slow state if it's still going past
  // the threshold. Reset the moment sync settles (the timer is cleared too).
  useWatchEffect(() => {
    if (!syncing) {
      setStalled(false);
      return;
    }
    const t = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(t);
  }, [syncing]);

  if (!mounted || !syncing) return null;

  const color = stalled ? "var(--sol-yellow)" : "var(--sol-cyan)";
  return (
    <div
      className="hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded-full select-none transition-all duration-300"
      style={{
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
        boxShadow: `0 0 10px color-mix(in srgb, ${color} 12%, transparent)`,
      }}
      title={
        stalled
          ? "Sync is taking longer than usual — the server may be under load."
          : "Syncing the latest data from the server…"
      }
    >
      <Loader2 className="w-3 h-3 animate-spin" style={{ color }} />
      <span className="text-[11px] font-mono font-bold" style={{ color }}>
        {stalled ? "sync slow" : "syncing"}
      </span>
    </div>
  );
}
