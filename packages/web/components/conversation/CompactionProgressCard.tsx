"use client";

import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";
import { readLiveScreenText } from "../../lib/terminal/termSessions";
import {
  parseCompactionProgress,
  type CompactionProgress,
} from "../../lib/compactionProgress";

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function sameProgress(a: CompactionProgress | null, b: CompactionProgress | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.elapsed === b.elapsed && a.percent === b.percent && a.tip === b.tip;
}

function usePolledProgress(tmux: string | null, active: boolean): CompactionProgress | null {
  const [progress, setProgress] = useState<CompactionProgress | null>(null);
  useWatchEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      const text = tmux ? readLiveScreenText(tmux) : null;
      const next = text ? parseCompactionProgress(text) : null;
      if (cancelled) return;
      setProgress((prev) => (sameProgress(prev, next) ? prev : next));
    };
    tick();
    const id = setInterval(tick, 400);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tmux, active]);
  return progress;
}

export function CompactionProgressCard({
  progress,
  elapsed: elapsedProp,
  className,
}: {
  progress: CompactionProgress | null;
  /** Clock text when the screen itself didn't print one. */
  elapsed?: string | null;
  className?: string;
}) {
  const elapsed = progress?.elapsed ?? elapsedProp ?? null;
  const percent = progress?.percent ?? null;
  return (
    <div className={`rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 ${className ?? ""}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse motion-reduce:animate-none shrink-0" />
        <span className="text-xs font-medium text-amber-500 shrink-0">Compacting conversation</span>
        <span className="flex-1" />
        {elapsed && <span className="text-[11px] tabular-nums text-sol-text-dim shrink-0">{elapsed}</span>}
        {percent != null && (
          <span className="text-[11px] tabular-nums text-amber-500/80 shrink-0">{percent}%</span>
        )}
      </div>
      <div
        className="mt-2 h-1.5 rounded-full bg-amber-500/15 overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label="Compacting conversation"
      >
        {percent != null ? (
          <div
            className="h-full rounded-full bg-amber-400 transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-2/5 rounded-full bg-amber-400/80 animate-pulse motion-reduce:animate-none" />
        )}
      </div>
      {progress?.tip && (
        <p className="mt-1.5 text-[11px] leading-snug text-sol-text-dim line-clamp-2">
          {progress.tip}
        </p>
      )}
    </div>
  );
}

/** Live row above the composer while this session is compacting. The percent
 *  and tip come from the attached terminal, when one is open. */
export function LiveCompactionCard({ conversationId, expanded }: { conversationId: string; expanded?: boolean }) {
  const snap = useInboxStore(useShallow((s) => {
    const sess = s.sessions[conversationId];
    if (!sess || sess.agent_status !== "compacting") return null;
    return {
      tmux: sess.tmux_session ?? null,
      startedAt: sess.agent_status_updated_at ?? null,
    };
  }));
  const progress = usePolledProgress(snap?.tmux ?? null, !!snap);
  const now = useCoarseNow(1000);
  if (!snap) return null;
  const elapsed = progress?.elapsed ? null : snap.startedAt ? formatElapsed(now - snap.startedAt) : null;
  return (
    <div className={`mx-auto px-2 sm:px-4 mb-2 ${expanded ? "conv-col" : "max-w-md"}`}>
      <CompactionProgressCard progress={progress} elapsed={elapsed} />
    </div>
  );
}
