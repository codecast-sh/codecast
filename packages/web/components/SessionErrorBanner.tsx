"use client";

/**
 * The daemon's `session_error`, rendered the same way on every conversation
 * surface (inbox queue, side panel, floating window). ONE definition so the
 * hosts can't drift apart — they only differ in how they resume.
 *
 * In normal flow rather than an absolute overlay, so it can't be clipped behind
 * the conversation header's higher-z elements. The text wraps instead of
 * truncating to one line: the errors that matter most ("No local checkout for
 * <remote> (recorded path X doesn't exist here). Clone it first.") put the
 * instruction at the END of the sentence, which truncation ate.
 */

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useDevices } from "./DeviceBadge";
import { deviceSeesPath } from "../lib/machinePicker";
import { classifyApiErrorBanner, SAFETY_BLOCK_HINT } from "@codecast/shared/contracts";

/**
 * The transient resume-lifecycle banners (resuming, reconstituting, timed out,
 * unresponsive), shared by the same hosts as SessionErrorBanner. In normal flow
 * for the same reason: an absolute overlay at the top of the conversation area
 * stretches across the diff panel and its backdrop blur obscures the diff
 * view's header.
 */
export function SessionResumeBanner({
  resumeState,
  looksAbandoned,
  onResume,
}: {
  resumeState: "idle" | "resuming" | "sent" | "reconstituting" | "failed";
  looksAbandoned?: boolean;
  onResume: () => void;
}) {
  if (resumeState === "resuming" || resumeState === "sent" || resumeState === "reconstituting") {
    return (
      <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-sol-orange/90 text-sol-bg text-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-sol-bg animate-pulse" />
        {resumeState === "reconstituting" ? "Reconstituting session from database..." : "Resuming session..."}
      </div>
    );
  }
  if (resumeState === "failed") {
    return (
      <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-sol-bg" />
        Resume timed out
        <button onClick={onResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors">
          Retry
        </button>
      </div>
    );
  }
  if (looksAbandoned) {
    return (
      <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-sol-bg-alt/90 border-b border-sol-border/50 text-sol-text-dim text-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/50" />
        Session unresponsive — send a message or
        <button onClick={onResume} className="px-1.5 py-0.5 rounded bg-sol-cyan/10 hover:bg-sol-cyan/20 border border-sol-cyan/30 text-sol-cyan transition-colors">
          Resume
        </button>
      </div>
    );
  }
  return null;
}

export function SessionErrorBanner({
  error,
  projectPath,
  ownerDeviceId,
  onResume,
}: {
  error: string;
  projectPath?: string | null;
  ownerDeviceId?: string | null;
  onResume?: () => void;
}) {
  const { devices } = useDevices();
  // Keyed by the error text, not a bare boolean: dismissing "no local checkout"
  // must not also swallow whatever the session fails with next.
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  if (!error || dismissedError === error) return null;
  const safety = classifyApiErrorBanner(error) === "safety";

  // Only offer the move when another online machine actually has this checkout —
  // otherwise it's advice that leads to the same error on a second box.
  const canMoveElsewhere =
    !!projectPath &&
    devices.some(
      (d) =>
        d.online &&
        d.device_id !== ownerDeviceId &&
        deviceSeesPath(d, projectPath),
    );

  return (
    <div role="alert" className={`shrink-0 flex items-start gap-2 px-4 py-1.5 text-xs ${safety ? "border-b border-amber-500/40 bg-amber-500/10 text-amber-500" : "bg-sol-red/90 text-sol-bg backdrop-blur-sm"}`}>
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        {safety && <div className="font-semibold">Safety review required</div>}
        <span className="break-words">{error}</span>
        {safety && <p className="mt-1 text-sol-text-dim">{SAFETY_BLOCK_HINT}</p>}
        {canMoveElsewhere && !safety && (
          <span className="opacity-80"> — or move this session to another machine from the header chip.</span>
        )}
      </div>
      {onResume && !safety && (
        <button onClick={onResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors flex-shrink-0">
          Resume
        </button>
      )}
      <button
        onClick={() => setDismissedError(error)}
        aria-label="Dismiss error"
        className="flex-shrink-0 p-0.5 rounded opacity-70 hover:opacity-100 transition-opacity"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
